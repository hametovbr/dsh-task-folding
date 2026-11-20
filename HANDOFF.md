# Handoff — continuing dsh-task-folding inside DeepSeek Harness

You are a coding agent running inside DeepSeek Harness (DSH) on the developer's machine. This file is your brief. Read it fully, then `AGENTS.md`, then the documents it points to. Everything in this repository is English-only — code, comments, docs, commit messages, model-facing text.

Last updated: 2026-11-20, after milestone M2 and its review follow-up (commits `5e261a5`, `7471698`).

## 1. What this project is

A DSH plugin: the agent wraps work in tasks (`task_begin` / `task_end`); each finished task is folded into a short summary that the model itself wrote in `task_end`; the originals stay in the session log and can be read back with `fold_recall`. It replaces the earlier `yindf/taskfold` plugin, whose problems are listed in `docs/01-background.md`.

## 2. Where things stand

| Milestone | Status | Where |
|---|---|---|
| Design | done | `docs/` (start at `docs/README.md`) |
| M0 — live-host verification | done | `m0/REPORT.md`, `m0/sessions/`, answers in `docs/07-open-questions.md` |
| M1 — pure core | done | `host/projection.js`, `host/cuts.js`, `host/planner.js`, `host/types.js` |
| M2 — tools without folding | done | `host/{texts,settings,resolve,estimate,tools,index}.js`, `m2/REPORT.md`, `test/fixtures/logs/m2-*.jsonl` |
| **M3 — self-summary folding** | **your job** | section 4 below; plan in `docs/05-implementation-plan.md` |
| M4–M8 | not started | do not start them |

Checks that must stay green (all pass at handoff): `npm test` (100 tests), `npm run coverage` (100% for `projection.js` and `cuts.js`), `npm run typecheck`, `npm run lint`. CI runs the same on every push to `main`.

### Changed after M2 review (verify these live in M3)

1. **The fold floor judges what a self-summary fold saves.** The span measured at `task_end` includes the `task_end` message, whose arguments carry the summary. A usable summary now folds only when `estTokens − summaryTokens ≥ minSpanTokens` (`decideVerdict` in `host/tools.js`, `docs/03` §6.2). An unusable summary still goes to `delegate` on the span alone.
2. **Leaner summary guidance.** The `summary` parameter now asks for the work itself (not task bookkeeping), only sections with content (never "None"), and a size matched to the work ("a line or two for a small task"). M2's live summaries narrated "opened T3 and closed it", wrote "Pitfalls: None", and ran 800–1,300 characters for tasks that stayed below the floor. In your live runs, record whether that changed (section 4.6).

## 3. Read before writing code

1. `AGENTS.md` — the hard constraints. In M3 the critical ones are: rule 4 (nothing on the `pre-step`/`turn-stopping` path calls `session.snapshotEvents()` or iterates the log), rule 5 (no awaited LLM call there — M3 makes none at all), rule 6 (only `host/engine-adapter.js` touches `@deepseek-ai/dsh-compaction-basic`), rule 7 (never wrap or patch host services).
2. `docs/03-architecture.md` §5 (fold planning and execution, especially §5.3), §7.3 (fold node format), §11 (failure modes), §12 (invariants).
3. `docs/02-host-api.md` §5 (agent hooks) and §6 (compaction: public contract, internal engine, transaction order).
4. `docs/adr/0004-engine-adapter.md` — why folding goes through one isolated adapter over the internal engine.
5. `host/planner.js` — `dueTasks` and `resolveRegion` already exist and are fully tested; the runner uses them, it does not re-derive regions.

## 4. M3 — self-summary folding

Goal: a closed `queued` task folds into the summary the model wrote, at the next step boundary after the model's report, in milliseconds. `delegate` tasks are **not** folded in M3 (that is M5): leave them waiting. No LLM call anywhere in M3.

### 4.1 Step 0 — the construction spike (do this first, write down the answer)

The engine adapter must create a `BasicCompactionEngine` subclass instance **without** disturbing the realm's own `ctx.compaction` service or registering automatic compaction hooks. Facts from the host source (rc.5):

- `class BasicCompactionEngine extends CompactionEngine`, and `CompactionEngine extends Service` with `super(ctx, 'compaction')` (`packages/compaction/compaction/src/index.ts` ~L119). A Cordis `Service` constructed with a name provides itself under that name — constructing one on the plugin's real `ctx` risks replacing or colliding with the realm engine.
- The constructor calls `this.ctx.sessionProjections.register(answeredRouteProjectionDefinition)` (key `compactionAnsweredRoute`; sharing a key at the same `stateVersion` is allowed — `packages/session/session-projection/src/index.ts` ~L405–L420) and, when `config.auto` is true, registers pressure hooks. Pass `{ auto: false }`.
- `static inject = ['llm', 'tokenMeter', 'sessions', 'sessionProjections']`.
- `protected async summarize(input, agent, signal): Promise<SummaryResult>` is the documented single customization hook. `SummaryResult` = `{ summary: ContentBlock[], provider: string, model: string, maxTokens?, usage? }` plus either `{ rawOutput, llmStreamCall: true }` or nothing (an unmarked result: "template, remote, or other summarizer"). A self-summary is an unmarked result.
- `compactRegion(start, end, agent, signal)` runs the whole transaction (`region.ts` L211–L250): `compaction/start` → `summarize()` → re-check → body commit → `compaction/end`; any failure before the commit appends `compaction/end { error }`. It compares the framed summary's estimate with the span's route-priced tokens and rejects a summary that is not smaller.
- taskfold 0.40.1 solved construction with a shim context whose `reflect.provide` is a no-op (`yindf/taskfold`, `plugins/fold-engine.mjs` ~L466–L480). That shim predates the constructor's `sessionProjections` call, so it is a reference, not something to copy.

Find a construction that works on the installed host and record it:

- Candidates: (a) a shim context exposing exactly what the constructor and `compactRegion` read (`llm`, `tokenMeter`, `sessions`, `sessionProjections`, `logger`, `effect`, `reflect.provide` no-op, and whatever else it turns out to need); (b) a Cordis isolation mechanism for the `compaction` name, if Cordis offers one (check the installed `@deepseek-ai/cordis` and the `dsh-doc` skill); (c) anything better you find in the host source.
- Acceptance for the spike: the realm engine still serves `/compact` and automatic compaction afterwards (verify live, section 4.6); no second set of pressure hooks; `ctx.compaction` is unchanged.
- Write the result into `docs/02-host-api.md` §6 and append a "Construction" section to `docs/adr/0004-engine-adapter.md`. If none of the candidates is safe, stop and report — do not ship a construction that replaces the realm engine.

### 4.2 Files to create or change

| File | Content |
|---|---|
| `host/resolve.js` | Generalize to `loadHostModule(spec)` (bare import, then the runtime-anchored `createRequire`), keep `loadSchemastery` as a thin wrapper. Used for `@deepseek-ai/dsh-compaction-basic` (adapter only) and `@deepseek-ai/dsh-compaction` (public: `toolPairingBalancedBefore/After`, `ManualCompactionError`). |
| `host/engine-adapter.js` | The only module that knows `BasicCompactionEngine`. Exports `createFoldEngine(ctx)` → `Promise<FoldEngine | null>`; `FoldEngine.foldRegion(agent, start, end, blocks, route, signal)` returns the host's `CompactionResult`. The subclass's `summarize()` returns `{ summary: blocks, provider: route.provider, model: route.model }` — the prepared blocks for this call, no LLM. Build once per process and cache; on failure cache `null` and log once (the plugin keeps working without folds, `docs/03` §11). |
| `host/fold-runner.js` | The `agent/pre-step` and `agent/turn-stopping` handlers (section 4.3). |
| `host/texts.js` | `renderFoldNode(task, summary, stats)` producing the node text of `docs/04` §6. |
| `host/index.js` | Wire the runner: `ctx.on('agent/pre-step', …)` returning `next()`'s decision unchanged; `ctx.on('agent/turn-stopping', …)`. Extend `inject` only with what you use. |
| `scripts/contract-check.js` | Downloads published `@deepseek-ai/dsh-compaction-basic` tarballs in the peer range (`npm pack <pkg>@<v>`, untar into a temp dir), and checks the adapter's assumptions: default export is a class with `summarize` and `compactRegion` on its prototype, `static inject` as expected, `Config` accepts `auto`. Add `"contract": "node scripts/contract-check.js"` to `package.json`. It needs network, so it is not part of `npm test`. |

### 4.3 Fold runner behavior (`docs/03` §5.1–§5.3)

For each handler call:

1. Per-session in-flight guard (a `WeakSet` of sessions): if a pass is running for this session, return at once.
2. `state = stateOf(session)`; `due = dueTasks(state, { turnStopping })`, keep only `status === 'queued'` and tasks not demoted or backing off in this process.
3. For each due task, inner-first (the order `dueTasks` returns):
   - `region = resolveRegion(task, session.surface.nodes)`; anything but `fold` → skip (`inconsistent` is a bug: log once per task, mark it skipped for the process).
   - If the pairing helpers resolved, assert `toolPairingBalancedBefore(session, region.start)` and `toolPairingBalancedAfter(session, region.end)`; a failure is a bug: log once, skip for the process.
   - Summary: `session.eventAt(task.endMsgSeq)` → the `tool-call` block with `id === task.endCallId` → `JSON.parse(arguments).summary`. Missing or empty → demote (in memory) and skip.
   - Node text: `renderFoldNode(task, summary, { messages: endIndex − startIndex + 1, tokens: <estimator over the region nodes>, outcome })`.
   - Pre-check size: if `estimator.text(nodeText) ≥ region tokens`, demote and skip (the host would reject it anyway).
   - Route: provider/model from the latest `request/header` (`state.lastHeaderSeq` → `session.eventAt(…).data.header.config`), else `agent.options`.
   - `await engine.foldRegion(agent, region.start, region.end, [{ type: 'text', text: nodeText }], route, signal)`. After success, re-read `state` before the next task (the outer task's cuts moved).
   - Errors: `ManualCompactionError` code `busy` → stop this pass, retry at the next boundary (no backoff, no cost); code `summary` → demote; anything else → log once per task, back off 1, 2, 4, 8 boundaries (in memory).
4. Measure the handler's wall time; log a warning above 100 ms.

The runner never calls `snapshotEvents()`, never iterates `session.events`, never awaits an LLM. Demotion and backoff are in memory only; that is allowed because they cost nothing and change no verdict (ADR 0005). Demoted tasks become the delegate path's input in M5; in M3 they simply stay `queued`.

### 4.4 Fold node text (`docs/04` §6)

```
# T7 · Fix login redirect loop
<summary as the model wrote it>

— fold of T7 · 42 messages · ~18.4k tokens · outcome: done · originals: fold_recall({ task: "T7" })
```

`fold_recall({ task })` itself arrives in M4; keep the footer as specified anyway (M3 and M4 ship together). The projection recognizes the fold structurally (exact `spanStart..endCut` replacement), never from this text.

### 4.5 Tests to add

- `test/fold-runner.test.js` with the simulator, a fake engine that applies the replacement through `Sim.compact`, and fake pairing helpers: inner-first order across nested tasks; the relay case; busy → retried next boundary; `summary` error → demoted; other error → backoff schedule; missing summary → demoted; size pre-check; `delegate` tasks untouched; in-flight guard; `pre-step` returns `next()`'s decision object unchanged; `turn-stopping` folds a task that is not yet `reported`.
- A guard test: the fake session's `snapshotEvents` and `events` getters throw; run both handlers over a session with folds due.
- `test/perf.test.js` (`docs/06` §4): an 80k-event simulated log with 200 tasks; a `pre-step` call with nothing due < 2 ms, and with one due fold (fake engine) < 10 ms; 5k vs 80k events ratio < 2.
- `test/engine-adapter.test.js`: with a stub base class standing in for `BasicCompactionEngine`, check that `summarize()` returns exactly the prepared blocks and route, never touches `ctx.llm`, and that construction failure yields `null` once.
- Keep `npm run coverage` at 100% for the pure modules.

### 4.6 Live acceptance (on this machine)

Same isolation as M0/M2 (`m2/REPORT.md` §1): scratch `DSH_HOME` inside the workspace, credential file copied in, `npm_config_store_dir` and `XDG_*` inside the workspace, headless profile `dsh-base` + `dsh-headless` + this repository. **Never touch the existing profiles in `~/.dsh`.**

1. **Fold happens.** Ask the model to open a task, read two ~300-line files and summarize them, close the task, then report. Expect: `compaction/start` → `compaction/summary` → replacement `user/message` covering exactly `spanStart..endCut` → `compaction/end`; replay shows the task `folded` with a `foldIndex`. Record the pre-step handler time from the plugin's log.
2. **The model continues coherently.** In the next run (`--session-id`), ask a question answerable only from the summary (e.g. a value from one of the files the summary mentions). Note whether it answered from the summary or re-read files.
3. **Nested + relay.** outer → inner (reads) → in ONE message close inner and open sibling → sibling (reads) → close sibling → close outer. Expect inner and sibling folded first, then outer folded over a span containing their summary nodes; every region balanced.
4. **Realm compaction still works.** In the same profile, run `/compact` (or force pressure compaction with a small `thresholdRatio` on the `dsh-compaction-basic` row) after our engine has been built. Expect a normal checkpoint and the plugin's tasks translated or absorbed per the projection. This is the acceptance test for the construction spike.
5. **Floor and guidance changes.** One small task (expect `below-floor` and, hopefully, a one- or two-line summary) and one borderline task. Record the summary lengths you observe.
6. Replay every journal with `node scripts/replay-journal.js`; copy scrubbed journals to `test/fixtures/logs/m3-*.jsonl` and add replay tests asserting the `folded` states and fold rows.

### 4.7 Deliverables

- Code, tests and docs committed to `main` in small logical commits (`AGENTS.md` "Commits"). Push when green.
- `m3/REPORT.md`: environment; the construction spike's answer; what was run; replayed final states (trimmed); handler timings; whether realm compaction still works; summary lengths before/after the guidance change; deviations from the docs with the doc change for each; surprises.
- Update `docs/05-implementation-plan.md`: mark M3 done with a one-paragraph result.
- Then **stop** and report. Do not start M4.

## 5. Things learned the hard way (do not rediscover)

From M0:

- `tool/result` replacements made by the tool-result pruner keep the original `meta`. The reducer already ignores replacements; never "fix" that.
- `user/message` data is the message itself (`data.content`, `data.source`); `tool/result` and `assistant/message` wrap it in `data.message`.
- Session journals are concatenated zstd frames; `zlib.zstdDecompressSync` on the whole buffer silently returns only the first frame. Use `scripts/replay-journal.js` (`--decode` writes JSONL) or `scripts/journal.js`.
- A profile with both `dsh-web-app` and `dsh-headless` hands the whole command line to the web app; use a headless-only profile for scripted runs.
- `~/.dsh` is read-only to the agent's sandbox; `dsh plugin add` needs `npm_config_store_dir` and `XDG_*` pointed into the workspace. `cordis_inspect` is not available.

From M2:

- The host does **not** validate tool arguments against `parameters`; every argument is defended by hand.
- The JSON-schema subset refuses type arrays; nullable is `oneOf: [{ type: 'string' }, { type: 'null' }]`.
- A thrown tool error reaches the model as `Error: <message>` with `isError: true` and no meta; error strings live in `host/texts.js`.
- Other tools (`read`) write their own `data.meta`; always filter on `tf === 1`.
- Two `task_begin` calls in one message nest (sequential commit), they are not siblings.
- `peerDependencies` are not linked by `dsh plugin add <path>`; host packages come through `host/resolve.js`'s runtime-anchored fallback.
- A `Config` value out of range fails when the row mounts, not in the reader.
- With the default floor, small sessions fold nothing by construction — make the live tasks read real amounts of text.

## 6. When something does not fit

If the design is wrong or a host fact differs from `docs/02-host-api.md`: change the code to match reality, update the doc in the same commit, add an ADR for a real decision, and list it in `m3/REPORT.md`. If you are blocked (missing credentials, a command that does not exist, no safe engine construction), write it down in the report and finish what you can. Do not weaken tests to make them pass.
