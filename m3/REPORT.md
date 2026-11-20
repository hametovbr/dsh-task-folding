# M3 — Self-summary folding: live acceptance report

Date: 2026-11-21. Scope: milestone M3 ([`docs/05-implementation-plan.md`](../docs/05-implementation-plan.md) §3,
[`HANDOFF.md`](../HANDOFF.md) §4). `delegate` tasks are deliberately left for M5, and no LLM call happens
anywhere in this milestone.

## 1. Environment

| Fact | Value |
|---|---|
| dsh | 0.2.2-rc.5 (`~/.dsh/runtime`) |
| Node / pnpm | v24.19.0 / 11.19.0 |
| Host | Linux 6.17.13-2-pve, x86_64 |
| Scratch Harness home | `<repo>/.m3-scratch/dsh-home` (deleted after the runs) |
| Profile `m3` | `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless` + `dsh-task-folding` + (spike only) `m3/probe-realm` |
| Working directory | `<repo>/.m3-scratch/work`, files of 300–304 lines for real pressure |

Isolation as in M0/M2: scratch `DSH_HOME` inside the workspace, credentials copied in (`mode 600`),
`npm_config_store_dir` and `XDG_*` inside the workspace. `~/.dsh/profiles` still holds exactly
`node_modules`, `rescue`, `web`, and `~/.dsh/profiles/web/package.json` is untouched.

## 2. Step 0 — the construction spike (the answer)

**The engine is constructed on a shim context, not on the plugin's real context.**

`new BasicCompactionEngine(shim, { auto: false })` succeeds, and the shim is a plain object with:

| Member | Why it is there |
|---|---|
| `reflect.provide` → no-op | `Service`'s constructor (`packages/cordis/src/service.ts` L42–L58) provides the instance under `compaction`; a no-op keeps the realm's service untouched |
| `tokenMeter` | the transaction prices the span and the framed summary |
| `waterfall` | `recover()` dispatches `compaction/summary-error` |
| `logger` | transaction diagnostics |
| `get` | optional siblings (unused with `auto: false`) |

`on`/`effect` are **absent on purpose**: with `auto: false` the constructor must not register
anything, so their absence turns a changed assumption into a loud failure instead of an engine with
no automatic hooks. `{ auto: false }` itself is required: with `auto: true` the pressure hooks would
be registered on the shim, silently disabling the realm's automatic compaction.

Verified live, in this order, inside one host process: the plugin builds its engine at `apply`; a
probe plugin then fetched `ctx.get('compaction')` and reported `realm engine is BasicCompactionEngine`;
`ctx.compaction.compactRegion(start, end, agent, signal)` committed a checkpoint
(`[m3-realm-probe] realm compactRegion committed: shadowed 10 nodes`) whose journal entry carries
`llmStreamCall: true` and `usage` — the realm's LLM path, not ours
(`test/fixtures/logs/m3-realm-compaction.jsonl`). No second set of pressure hooks exists, and no
`ctx.reflect.provide` call reached the realm.

Recorded in [`docs/02-host-api.md`](../docs/02-host-api.md) §6 ("Construction of a plugin-owned
engine") and in the new "Construction" section of [ADR 0004](../docs/adr/0004-engine-adapter.md).

## 3. What was implemented

| File | Content |
|---|---|
| `host/resolve.js` | `loadHostModule(spec)` (bare import, then the runtime-anchored `createRequire`); `loadSchemastery` is a wrapper over it |
| `host/engine-adapter.js` | the only module that knows `BasicCompactionEngine`; `createFoldEngine(ctx)` → `FoldEngine | null`, cached per process, with `foldRegion`, the two pairing helpers and `classify(error)` |
| `host/fold-runner.js` | the `agent/pre-step` and `agent/turn-stopping` handlers: per-session in-flight guard, due-task loop, region and pairing checks, summary extraction, size pre-check, route resolution, busy/demote/backoff handling, slow-pass warning |
| `host/texts.js` | `renderFoldNode(task, summary, stats)` |
| `host/index.js` | builds the engine in the background, registers both boundaries, logs once when the engine is unavailable |
| `scripts/contract-check.js` | downloads the published `dsh-compaction-basic` and `dsh-compaction` tarballs in the peer range and asserts the adapter's assumptions (`npm run contract`, network needed) |
| `m3/probe-realm/` | the acceptance probe of §2 (not part of the published bundle) |

## 4. What was run

Every run is a separate `dsh` process; later runs resume with `--session-id`, so the projection was
replayed from the log each time. Prompts asked for behaviour in words; no tool argument was scripted.

| # | Session | What was asked | Result |
|---|---|---|---|
| 1 | `63d05bcb` | open a task, read two 300-line files, close with a summary that keeps the access keys, report | **folded** (`# T1`, 5 messages, ~11.0k tokens); a follow-up "quote the two keys, no tools" answered `PLAUSIBLE-KEY-7781` / `SECOND-KEY-4410` from the checkpoint |
| 2 | `38b658cd` | outer → nested inner (two reads) → in ONE message close inner + open sibling → read → close sibling → close outer | inner and sibling **folded**; outer **below-floor** after its children were folded (§5.3) |
| 3 | `9ca17be7` | one task, one 300-line read | **folded**, summary 264 characters |
| 4 | `9ca17be7`-like small run | one task, one 1-line file | **below-floor** (`estTokens 68`), summary 182 characters |
| 5 | `e9419dc4`, `c028073e` | no task; a probe asks the realm engine to compact | realm checkpoint committed (`llmStreamCall: true`) — the construction acceptance |

### 4.1 The fold transaction (session 1, trimmed journal)

```
43 compaction/start
44 compaction/summary   provider=deepseek-official model=deepseek-flash
                       shadowed=[27,30,31,35,37]   (no llmStreamCall, no usage: a self fold)
45 user/message        surfaceOp replace 27..37   source compact-checkpoint
46 compaction/end      (no error)
```

Replayed state: `T1 folded`, `foldIndex 0`, `estTokens 10965`, `folds[0] = {summarySeq 44, nodeSeq 45,
taskId T1, shadowedCount 5, shadowedTokens 10990}`. The node text the model sees is exactly
[`docs/04`](../docs/04-tools-and-prompt.md) §6:

```
# T1 · inspect data files
## Done … (the model's own summary, keeping both access keys) …
— fold of T1 · 5 messages · ~11.0k tokens · outcome: done · originals: fold_recall({ task: "T1" })
```

The fold landed on the `pre-step` of the step after the model's report — the report itself was
written while the span was still in context, as designed.

### 4.2 Nested + relay (session 2)

```
folds: #0 T2 shadowedCount 8 (12658 tokens)   #1 T3 shadowedCount 6 (7611 tokens)
T1 outer   below-floor  est 1859
T2 inner   folded       est 12619
T3 sibling folded       est 7587
```

The relay produced adjacent cuts at close time (`endCut(inner) == beginCut(sibling)`), and after the
inner fold the sibling's `beginCut` translated onto the fold node while its `spanStart` stayed put —
so the sibling still resolved to a valid region and folded afterwards. **Every region was
tool-pairing balanced**; the pairing helpers never rejected a region in any live run.

## 5. Timings

- The runner logs a warning only above the 100 ms budget. **No live run produced one**, so every
  boundary pass in the sessions above stayed under 100 ms.
- Synthetic guard (`test/perf.test.js`, 80k events, 200 tasks): a `pre-step` with nothing due is
  well under 2 ms, and a folding boundary measures ~2.4–2.7 ms with the estimate cache warm
  (`< 10 ms`), with the 5k-vs-80k ratio under 2.
- The first folding boundary in a fresh process is slower (~6–17 ms in the guard) because the
  per-seq estimate cache is cold; it does not repeat.

## 6. The fold floor and the summary guidance after the M2 review

Summary lengths recorded by the fixtures (characters, per task in session order):

| Session | Carried over from M2 | This milestone |
|---|---|---|
| nested + relay | 1277, 827, 972 | 1747 (outer, below-floor), 1545 (inner), 1080 (sibling) |
| single task | — | 264 (folded), 182 (below-floor, one-line file) |
| two 300-line files | 1173 | 1157 |

Reading: the new "size it to the work" guidance did reach the model — the two genuinely small tasks
produced 182 and 264 characters instead of the 800–1,300 seen in M2 — while real work kept its usual
1000–1500 characters. The economy rule (`estTokens − summaryTokens ≥ minSpanTokens`) is visible in
the nested session: `outer` measured 1,859 tokens after its children were folded, so it closed
`below-floor` instead of folding a summary of nearly the same size as its remaining span.

## 7. Realm compaction still works

Yes, and in the same process as our engine (§2). Two findings worth recording:

1. **The realm engine is not built at all when its config is invalid.** A profile patch with
   `thresholdRatio: 0.01` made it fail with `BasicCompactionConfig: retainRatio (0.16) must be less
   than the resolved thresholdRatio (0.01)`, so `ctx.compaction` stayed absent
   (`dsh: warning: 2 entries did not activate`). Our plugin kept working with folds through its own
   engine and logged nothing — the intended degradation. This is a *configuration* trap, not a
   regression of the construction: with the default config the realm engine was present and worked
   (`realm engine is BasicCompactionEngine`).
2. **Our fold and the realm's compaction can contend for the same boundary.** When the probe started
   a realm compaction on `turn-stopping`, our pass in the same tick saw the durable lock and stopped
   with `busy` (no log, no retry cost); the realm checkpoint then absorbed the task (`absorbed`), as
   03 §2.4 predicts. That is the designed behaviour, but it means a task can close `queued` and end
   up `absorbed` if another compaction wins the boundary.

## 8. Deviations, each with its doc change

1. **Fold errors are not wrapped on this entry path.** `compactRegion` with `owner: 'current-turn'`
   throws the summarizer's error unchanged; only `busy` arrives as `ManualCompactionError`. The shrink
   refusal is a plain `Error` starting with `summary is not smaller than the shadowed content`, so the
   adapter classifies on that text, and the contract check pins it.
   → `docs/03` §5.3, `docs/02` §6, ADR 0004.
2. **The runner re-reads the task after every committed fold.** The first version kept the `Task`
   objects `dueTasks` returned; after the inner fold the outer task's `beginCut` had translated onto a
   node the stale object still pointed past, and the sibling was skipped as `inconsistent` (it then
   became `absorbed` by the outer fold). Found by `test/fold-runner.test.js`; fixed by looking the
   task up again in the freshly read state. → `docs/03` §5.3 (last paragraph).
3. **`@deepseek-ai/dsh-compaction` joined `peerDependencies`** (optional, like the others): the
   adapter now consumes its public helpers, and the host gates the range against the runtime.
   → `docs/05` §1 and §4.2 table.
4. **The outer task does not fold over its children's summary nodes** in the live nested run, which
   `HANDOFF.md` §4.6 expected. The economy rule makes it `below-floor` — the fold would save less than
   the floor. The design already allows this (`docs/03` §6.2); no code change, recorded here because
   the handoff expectation differs.
5. **`scripts/contract-check.js` inspects the published bundle as text** instead of importing it: the
   package's own dependencies are not present in a temp directory, so an import would fail for reasons
   unrelated to the contract. It asserts the class shape, `static inject`, the `auto` gate, the shrink
   message and the four public exports of `dsh-compaction`.

## 9. What surprised me

- **A Cordis `Service` registers itself in its constructor.** `Service` calls
  `ctx.reflect.provide(name, …)` before any plugin `apply` runs, so "construct an engine for my own
  use" is really "provide a service" unless the context is a shim. The shim approach worked first
  try; the only care needed was to *omit* `on`/`effect` so a future change cannot silently redirect
  realm hooks into a mock context.
- **A config error silently removes the whole compaction service** (§7.1) while the rest of the host
  keeps running. Worth knowing before debugging "compaction stopped working" in the field.
- **The size pre-check is nearly unreachable in practice.** With `maxSummaryRatio ≤ 0.5` a usable
  summary is always smaller than its span, so the runner's pre-check fires only when the estimate
  methods disagree; the host's own shrink check is the real guard, and the runner treats it as a
  demotion.
- **The first boundary after a restart pays for the estimate cache** (6–17 ms on a 80k-event synthetic
  log, ~2.4 ms after). It is inside budget, but it is the only part of the fold path that grows with
  the log, and it grows only once.

## 10. Deliverables and checks

- Commits on `main`: the engine adapter and the fold runner (+ tests, contract check, peer list),
  then this report and the docs.
- `npm test` — 134 tests (100 before M3). `npm run coverage` — 100% branch/line/function for
  `host/projection.js` and `host/cuts.js`. `npm run typecheck` and `npm run lint` clean.
  `npm run contract` passes against the published 0.2.2-rc.5 packages.
- New tests: `test/fold-runner.test.js` (17 cases: order, relay, busy, demote, backoff, missing
  summary, size pre-check, delegate untouched, in-flight guard, the two handlers, the
  no-snapshot/no-iteration guard), `test/engine-adapter.test.js` (shim, prepared blocks, no LLM seam,
  classification, caching), `test/perf.test.js` (80k/5k guards), `test/m3-journals.test.js`
  (fixtures `m3-fold-and-recall`, `m3-nested-relay`, `m3-realm-compaction`, `m3-single-fold`).
- The scratch home `.m3-scratch/` was deleted after the runs; it is git-ignored in the meantime.

Stopping here: M4 (recall) is not started.
