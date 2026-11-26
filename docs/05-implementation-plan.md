# 05 — Implementation plan

The plan is ordered so that every milestone ends with something testable, and the riskiest host assumptions are checked before code depends on them.

## 1. Technical choices

| Topic | Choice | Reason |
|---|---|---|
| Language | Plain ES modules (`.js`, `"type": "module"`) with JSDoc types, type-checked by `tsc --noEmit --checkJs` | A Host-only bundle needs no build step; taskfold's install failures came partly from packaging. Types still catch shape errors. |
| Runtime | Node ≥ 22 (what DSH ships) | — |
| Tests | `node:test` + `node:assert`, no framework | Zero dependencies in the published package. |
| Property tests | `fast-check` (devDependency only) | Invariants 1–4 in [03 §12](03-architecture.md#12-invariants-tested). |
| Lint/format | `eslint` + `prettier` (devDependencies) | — |
| Packaging | One npm package, one Loader row, Host `apply` + Client module in the same package | Matches the official template; confirmed live in M0. |
| Peer dependencies | `@deepseek-ai/dsh`, `@deepseek-ai/dsh-compaction`, `@deepseek-ai/dsh-compaction-basic`, `@deepseek-ai/dsh-llm`, all `^0.2.2-rc.1` | Hosts with `tool/result.meta` and `agent/turn-stopping`. Live-verified on 0.2.2-rc.5 only; `dsh plugin add` does not link peers ([07 Q4](07-open-questions.md#q4)). |
| Language of all texts | English (code, comments, docs, model-facing text). Locale files: `en` required. | Project rule. |

## 2. Repository layout

```
package.json
cordis.patch.yml
host/
  index.js            plugin object; wires everything in apply()
  projection.js       reducer, schema, wire view (pure)
  cuts.js             cut translation (pure)
  planner.js          due selection, region resolution
  tools.js            task_begin, task_end, fold_recall definitions
  fold-runner.js      pre-step / turn-stopping / idle scheduling
  engine-adapter.js   the only module touching dsh-compaction-basic internals
  summarizer.js       delegate request + instruction + validation
  recall.js           list, index, range, grep
  hints.js            stale-task hint
  estimate.js         span token estimate
  settings.js         Config schema and safe readers
  texts.js            every model-facing string in one place
client/
  client.js           dock + settings card (window.__ModuleLoader__ format)
locale/
  en.json
icon.svg
test/
  fixtures/           recorded session logs (JSONL) + synthetic generators
  *.test.js
scripts/
  pack-check.js       verifies the packed file list
  contract-check.js   downloads published host packages and checks the adapter's assumptions
docs/
```

## 3. Milestones

Each milestone lists tasks, then the acceptance criteria that close it. What to do *first* — the
repairs found while building M0–M3 and the decisions that are not milestones yet — lives in
[08-followups.md](08-followups.md); its §1 is expected to be finished before M4 starts.

### M0 — Host verification spike (no plugin code) — **done 2026-11-20**

Result: [`m0/REPORT.md`](../m0/REPORT.md) (host 0.2.2-rc.5). Q1, Q2, Q3, Q7, Q8 confirmed, Q4 partial (layout-dependent), Q9 refuted. Design changes applied: PTC detection via `exec.callId`, replacement results ignored for `meta`, `step/end` as a batch-close signal, delegate folds moved to background generation ([ADR 0006](adr/0006-background-delegate.md)), dock slot fixed to `conversation.input.dock`. Recorded session journals for fixtures: `m0/sessions/`.

Goal: answer the open questions that could change the design before writing it. Needs a machine with DSH installed and an API key. Ready-to-run instructions for an on-host agent, including the probe bundle and the report format: [`m0/AGENT_PROMPT.md`](../m0/AGENT_PROMPT.md).

Tasks:

1. Minimal bundle with one tool whose `output.presentationMeta` returns `{ probe: 1 }`; confirm the value appears in `tool/result.data.meta` in the session log and survives a restart (Q2).
2. Same bundle: register a projection that logs every `surfaceOp` and `sourceEventSeqs` it sees; run `/compact`; confirm the replacement `user/message` reaches `apply` with `surfaceOp.op === 'replace'` and full `sourceEventSeqs` (Q8).
3. Call the tool from `run_code` and record what the log contains (Q1).
4. In `agent/turn-stopping`, schedule `agent.whenIdle().then(() => agent.runMaintenance(…))` with a dummy 5-second job; confirm it runs after the turn, does not block the next user message from being accepted, and what happens when a message arrives mid-job (Q3).
5. Confirm the single-row Host + Client layout and the dock slot name (Q7).
6. Resolve `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-compaction-basic` from a profile-installed bundle with plain `import`; record what fails (Q4).

Acceptance: every open question in [07](07-open-questions.md) touched here has a recorded answer, and the design docs are updated where an answer differs from the assumption.

### M1 — Pure core — **done 2026-11-20**

Result: `host/projection.js`, `host/cuts.js`, `host/planner.js`, `host/types.js`; fixtures `test/fixtures/{sim,ops,journals}.js`; 53 tests. Branch/line/function coverage of `projection.js` and `cuts.js` is 100% (`npm run coverage`, enforced in CI); 1,000 property cases run in ~0.4 s. Deviation from the original design, reflected in 03: a fold is recognized structurally by its exact span (`spanStart`, `endCut`), not by parsing the summary heading.

Goal: the projection, cut translation and planner, fully tested offline.

Tasks:

0. Tooling: `package.json` with `type: module`, scripts `test` / `typecheck` / `lint`, dev dependencies (`typescript`, `fast-check`, `eslint`, `prettier`), `jsconfig.json` / `tsconfig.json` for `--checkJs`, and a CI workflow running all three on push. Bundle fields (`dsh.*`, `exports`, `files`, peers) are added in M2.
1. `projection.js`: state type, `stateSchema.parse` (hand-written validator, no zod import), `init`, `apply` per the table in [03 §4.3](03-architecture.md#43-reducer), wire `view` with reference memoization.
2. `cuts.js`: `translateCuts(state, replaceEvent)`.
3. `planner.js`: `dueTasks(state)`, `resolveRegion(task, nodes)`.
4. Real-log fixtures: a loader that reads the decoded M0 journals in `m0/sessions/*.jsonl` (one JSON event per line, header line without `seq`) and replays them through `apply`; snapshot the resulting state.
5. Fixture builders: a small DSL that produces event sequences (`msg(calls…)`, `result(callId, meta?)`, `compact(range)`, `prune(seq)`, `fork(at)`), plus a surface simulator that applies `replace` ops so tests can compare planner regions against the real surface.
6. Tests:
   - unit: each reducer row; a pruned task-mark result (replacement keeps `meta`) is not re-applied; interrupted batch; relay `end+begin` in one batch; nested tasks; merged descendants; absorbed begin/end; our fold vs auto fold vs pruner replacement; delegate failure cap;
   - property (fast-check): random interleavings of begin/end/other calls/compactions/prunes → invariants 1–4;
   - replay equivalence: `apply` from scratch vs from a JSON round-tripped checkpoint at every position.

Acceptance: 100% branch coverage of `projection.js` and `cuts.js`; property tests run 1,000 cases in < 10 s.

### M2 — Tools without folding — **done 2026-11-20**

Result: `host/{texts,settings,resolve,estimate,tools,index}.js`, the bundle manifest (`package.json`, `cordis.patch.yml`, `locale/en.json`, `icon.svg`) and 46 new tests (99 total; the prompt surface measures 2,790 of the 3,400-character budget). Installed into a scratch profile as a pnpm link, the plugin registered all three tools and its prompt section; live sessions opened, nested and closed tasks, one message produced the relay `endCut(inner) == beginCut(sibling)`, a merge and a resume after restart, and the journals replay to the expected state (`test/fixtures/logs/`, `test/m2-journals.test.js`). Answers: Q4 settled — peers are not linked. Deviations: the task_end value also carries the fields `presentationMeta` needs, and the absorbed verdict covers any absorbed boundary rather than `beginCut` alone (both reflected in 03/04). Details: [`m2/REPORT.md`](../m2/REPORT.md).

Goal: the plugin installs, the model can open and close tasks, verdicts land in the log, the projection is live. No folds yet.

Tasks:

1. `settings.js` with the Config schema ([03 §10](03-architecture.md#10-settings)) and clamping readers.
2. `estimate.js` over `ctx.tokenMeter.estimateMessage`, with a cache keyed by seq.
3. `tools.js`: `task_begin` and `task_end` with `render`, `presentationMeta`, PTC refusal, id reservation, verdict logic; `texts.js` holding every string.
4. `host/index.js`: register projection (await the promise), tools, prompt section; detect a pre-existing `task_begin` tool and stay inactive with a diagnostic.
5. Package files: `package.json` (exports, files, `dsh.bundle`, `dsh.client`, peers), `cordis.patch.yml`, `locale/en.json`, `icon.svg`.
6. Tests: tool execute/render/meta with a fake session; prompt budget test ([04 §4](04-tools-and-prompt.md#4-token-budget)).

Acceptance: installed in a local profile; a scripted session opens and closes nested tasks, including a relay in one message; the log carries the expected meta; the projection state after restart equals the state before.

### M3 — Self-summary folding — **done 2026-11-21**

Result: `host/engine-adapter.js` (the only module that knows `BasicCompactionEngine`; the subclass is built on a shim context with a no-op `reflect.provide`, so the realm's `ctx.compaction` survives — recorded in 02 §6 and ADR 0004), `host/fold-runner.js` (pre-step and turn-stopping boundaries: in-flight guard, inner-first order, region and pairing checks, size pre-check, busy/demote/backoff), `renderFoldNode`, the wiring in `index.js`, and `scripts/contract-check.js` (`npm run contract`). 34 new tests (134 total), including the 80k-event performance guards and four live journals (`test/fixtures/logs/m3-*.jsonl`). Live: a closed task folded at the next step boundary with the model's own summary (no LLM call, `llmStreamCall` absent), the model answered a follow-up from the checkpoint alone, nested tasks folded inner-first with a relay, and the realm's own checkpoint committed in the same process afterwards. Deviations: fold errors are not wrapped on this path (the shrink refusal is a plain `Error`, classified by message), the runner re-reads the task after every committed fold, and `@deepseek-ai/dsh-compaction` joined the peers. Details: [`m3/REPORT.md`](../m3/REPORT.md).

Goal: folds happen, fast, at the right boundaries.

Tasks:

1. `engine-adapter.js`: resolve the base class (bare import, then the documented fallback), build the subclass whose `summarize()` returns prepared blocks with no LLM call, construct it with `auto: false`; expose `foldRegion(start, end, agent, signal, blocks)`. All `node_modules` probing lives here and nowhere else.
2. `fold-runner.js`: pre-step and turn-stopping handlers; due selection; summary extraction from the end call arguments; node text ([04 §6](04-tools-and-prompt.md#6-fold-node-text)); balanced-edge assertion; error handling per [03 §5.3](03-architecture.md#53-self-summary-fold-default-path); per-session in-flight guard.
3. Timing: measure pre-step handler time; log a warning above 100 ms.
4. Tests: runner against a fake engine (call order, inner-first, busy retry, demotion to delegate); contract test of the adapter against the real published `dsh-compaction-basic` tarball (`scripts/contract-check.js`, run weekly by `.github/workflows/contract.yml`): exports, `summarize` hook dispatch, `compactRegion` signature, constructor injections.

Acceptance: in a live session, a closed task above the floor folds at the next step boundary after the report; the fold node shows the title and footer; pre-step p95 < 100 ms on a session with ≥ 5k events.

### M4 — Recall — **done 2026-11-21**

Result: `host/recall.js` (list with nesting, index with paging, exact range, grep — all over a fold row's `shadowedSeqs` and `deriveEventMessage`, never a log snapshot), the real `fold_recall` dispatch in `host/tools.js`, the renderers in `host/texts.js`, and 19 tests, one of them over the live fixture `test/fixtures/logs/m4-recall.jsonl`. Live: two tasks folded, then a session that used `fold_recall` only — list, index, grep, range — and answered `INV-2026-4417`, a value that exists only inside a shadowed message, without re-reading any file. The same milestone closed §1 of [08](08-followups.md): busy retry inside one pass with one log line (F1), a bulk region estimate and performance guards moved to their own `npm run perf` step (F2), a scheduled `contract` workflow plus the `.tmp` bug it exposed (F4), and the settings/configuration notes (F5, F6). Details: [`m4/REPORT.md`](../m4/REPORT.md).

Tasks:

1. `recall.js`: list (from `state.folds`, nested by shadowed fold nodes), index with paging, range with caps, grep.
2. Message brief renderer (one line per message: role, tool name, first text) — adapt taskfold's `span-preview.mjs` ideas, not its code.
3. Tests: recall output equals `deriveEventMessage` of `shadowedSeqs`; nested fold display; caps and truncation notes.

Acceptance: recall works for task folds, auto compactions and pruned results; no file is written anywhere.

### M5 — Delegate fallback — **done 2026-11-21**

Result: `host/summarizer.js` (prefix-anchored request built exactly like the host's own — the surface prefix plus the span, `tools` from the latest `request/header`; instruction in `texts.js`; generation through the host's `BlockAssembler`; output validation) and the two-phase fold runner (one un-awaited generation per session, commit at a later boundary when the region key still matches, durable failure accounting through `Engine.rejectRegion`), plus `scripts/verify-cache.js`. 44 new tests (195 total). Live: a delegate fold committed with a **99.1 % provider cache-hit against a 99.3 % median of the session's own main requests (−0.2 pp, floor 80 %)** — the cache requirement (03 §12 invariant 9) is met and measured — and three failed generations recorded durable `compaction/end{error}` rows, turning the task `failed` without a billed retry loop (Q11 confirmed). Two silent defects were found and fixed: the region key included the surface length (every generated summary was discarded), and a delegate fold is unmarked by design, so the audit had to classify it by `usage`. Details: [`m5/REPORT.md`](../m5/REPORT.md).

Tasks:

1. `summarizer.js`: prefix-anchored request (surface prefix + span + instruction; `tools`/`config` from the latest `request/header`; `toolHistory`), instruction ([03 §7.2](03-architecture.md#72-delegate-instruction)) with numbered span index and size budget, output validation.
2. Two-phase runner ([03 §5.4](03-architecture.md#54-delegate-fold-fallback-path)): background generation with one in flight per session, commit at the next boundary if the region is unchanged.
3. Durable failure cap: record each failed generation as a zero-cost failed compaction attempt; verify the host appends `compaction/start` + `compaction/end{error}` for a `summarize()` that rejects ([07 Q11](07-open-questions.md#q11)).
4. Port taskfold's cache verification idea as `scripts/verify-cache.js`: from a live session log, compare each delegate fold's `usage` (cache read vs fresh input) with its span size.

Acceptance: a task closed with an empty summary folds at a step boundary after its summary is generated, with no step or user message waiting on generation; three consecutive failures stop retries across a restart; cache-hit ratio ≥ 80% on delegate folds.

### M6 — Hints and UI — **done 2026-11-21**

Result: `host/hints.js` (one stale-task hint per task and bucket, delivered by appending to the `agent/pre-step` decision, latched durably in the projection), `renderStaleTaskHint`, and the browser module `client/client.js` with the dock in `conversation.input.dock` and a configuration card in `plugins.bundle.config` (+ `dsh.client`, `exports["./client"]`, 22 locale keys). 21 new tests (216 total). Live: with `staleTaskSteps: 5` the hint fired at age 5 and at age 10 and never repeated after restarts; in a scratch web profile the dock rendered `T1 · long running` from the wire view with `showTaskBar: true` and disappeared entirely with `showTaskBar: false`. A real defect was found on the way: `exports["./client"]` pointed at a non-existent path, so the host silently dropped the whole client module from its roster — now fixed and pinned by a test that the declared path exists. Writing settings from the card could not be confirmed in the scratch profile (the built-in Subagent settings page behaves the same way there); recorded as F7. Details: [`m6/REPORT.md`](../m6/REPORT.md).

Tasks:

1. `hints.js`: stale-task hint with buckets and the durable latch.
2. `client/client.js`: dock and settings card; locale lookups; theme tokens only.
3. Tests: hint publication sequence over a synthetic session; view memoization.

Acceptance: the dock reflects open/folding/recent tasks live; the hint appears once per bucket and never after a restart for the same bucket.

### M7 — Evaluation and release — **partially done 2026-11-21**

Result: Q5/Q13/Q14 answered, Q6 measured and **rejected** (deferred `fold_recall` saves ≈ 208 tokens but the host cannot load a deferred baseline tool, and the model then never calls it), Q15 fixed at the prompt (live: 3/3 runs keep `task_begin` in its own message, and a 13.6k-token span folds), `scripts/eval-report.js` with the §5.3 metrics (+14 tests), version `0.1.0`, README rewritten. **The acceptance criterion is not met on the suite that ran:** 7 sessions over two short tasks show C billing 307,948 tokens against taskfold's 245,412 — the folds are free (self fold, no LLM call) but the discipline adds steps, and on 6–21-step tasks the bookkeeping costs more than the folds save. All tasks succeeded everywhere, and the delegate fold kept 99.1 % cache-hit. **Not published**: `npm publish` needs the owner's go-ahead and the protocol's real suite (10–20 tasks of 50–300 steps × 3 runs) before the numbers can be published as a comparison. The publish itself is `npm publish --access public` once the owner authenticates: `prepublishOnly` runs `npm run release:check` (docs/06 §1), so the upload cannot bypass the gates — six offline gates, the contract check and a live E2E, about five minutes. A shell whose `~/.npm` is read-only (a confined sandbox) must pass `npm_config_cache=$PWD/.tmp/npm-cache` to the publish itself; the gate's own children already redirect their cache under `.tmp/`. After the upload, `npm run e2e -- --plugin dsh-task-folding@<version>` is the acceptance form of docs/09 T5: the profile installs the package from the registry instead of this checkout. Details: [`m7/REPORT.md`](../m7/REPORT.md) and [`m7/metrics.md`](../m7/metrics.md).

Tasks:

1. Run the evaluation protocol in [06 §5](06-testing.md#5-evaluation-protocol): no plugin vs taskfold 0.40.1 vs this plugin.
2. Fix regressions; tune defaults (`minSpanTokens`, `maxSummaryRatio`, `staleTaskSteps`) from the data.
3. README: install, settings, measured results with the method stated.
4. Publish `0.1.0` to npm; GitHub release with the packed tarball.

Acceptance: billed tokens ≤ taskfold on the suite; task success not worse than no-plugin; numbers published with the method.

### M8 (parallel) — Upstream proposal

File an issue/PR on `deepseek-ai/deepseek-harness` proposing either `compactRegion(start, end, agent, signal, { summary })` or a `compaction/summarize` waterfall, plus an option to replace the checkpoint preamble for mid-history folds. If accepted, delete `engine-adapter.js` and switch to `inject: ['compaction']`.

## 4. Definition of done (every milestone)

- `npm test`, `npm run typecheck`, `npm run lint` pass.
- New behavior is covered by tests at the lowest layer that can express it.
- Docs updated in the same commit when behavior differs from the design.
- No new code path calls `snapshotEvents()` or touches compaction internals outside `engine-adapter.js`.

## 5. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Self-summary quality is worse than a dedicated summarizer | More recalls, worse continuations | Measured in M7; delegate stays available per task and as a global mode |
| `meta` or replace events are not delivered to projections as assumed | Core design breaks | Verified in M0 on 0.2.2-rc.5; the real-log fixtures pin the shapes |
| Host refactors `BasicCompactionEngine` | Folds stop | Isolated adapter + the weekly contract check + upstream proposal (M8) |
| Models ignore the task discipline | No folds | Host auto compaction still works; implicit per-turn task as a follow-up option |
| Background delegate generation races with the main turn (region changes before commit) | Wasted generation calls | Region key check before commit; at most one generation in flight; delegate is a fallback, so the rate is low |
