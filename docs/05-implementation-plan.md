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
| Packaging | One npm package, one Loader row, Host `apply` + Client module in the same package | Matches the official template ([07 Q7](07-open-questions.md#q7) to confirm). |
| Peer dependencies | `@deepseek-ai/dsh`, `@deepseek-ai/dsh-compaction-basic`, `@deepseek-ai/dsh-llm`, all `^0.2.2-rc.1` | Hosts with `tool/result.meta` and `agent/turn-stopping`. |
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

Each milestone lists tasks, then the acceptance criteria that close it.

### M0 — Host verification spike (no plugin code)

Goal: answer the open questions that could change the design before writing it. Needs a machine with DSH installed and an API key. Ready-to-run instructions for an on-host agent, including the probe bundle and the report format: [`m0/AGENT_PROMPT.md`](../m0/AGENT_PROMPT.md).

Tasks:

1. Minimal bundle with one tool whose `output.presentationMeta` returns `{ probe: 1 }`; confirm the value appears in `tool/result.data.meta` in the session log and survives a restart (Q2).
2. Same bundle: register a projection that logs every `surfaceOp` and `sourceEventSeqs` it sees; run `/compact`; confirm the replacement `user/message` reaches `apply` with `surfaceOp.op === 'replace'` and full `sourceEventSeqs` (Q8).
3. Call the tool from `run_code` and record what the log contains (Q1).
4. In `agent/turn-stopping`, schedule `agent.whenIdle().then(() => agent.runMaintenance(…))` with a dummy 5-second job; confirm it runs after the turn, does not block the next user message from being accepted, and what happens when a message arrives mid-job (Q3).
5. Confirm the single-row Host + Client layout and the dock slot name (Q7).
6. Resolve `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-compaction-basic` from a profile-installed bundle with plain `import`; record what fails (Q4).

Acceptance: every open question in [07](07-open-questions.md) touched here has a recorded answer, and the design docs are updated where an answer differs from the assumption.

### M1 — Pure core

Goal: the projection, cut translation and planner, fully tested offline.

Tasks:

0. Tooling: `package.json` with `type: module`, scripts `test` / `typecheck` / `lint`, dev dependencies (`typescript`, `fast-check`, `eslint`, `prettier`), `jsconfig.json` / `tsconfig.json` for `--checkJs`, and a CI workflow running all three on push. Bundle fields (`dsh.*`, `exports`, `files`, peers) are added in M2.
1. `projection.js`: state type, `stateSchema.parse` (hand-written validator, no zod import), `init`, `apply` per the table in [03 §4.3](03-architecture.md#43-reducer), wire `view` with reference memoization.
2. `cuts.js`: `translateCuts(state, replaceEvent)`.
3. `planner.js`: `dueTasks(state)`, `resolveRegion(task, nodes)`.
4. Fixture builders: a small DSL that produces event sequences (`msg(calls…)`, `result(callId, meta?)`, `compact(range)`, `prune(seq)`, `fork(at)`), plus a surface simulator that applies `replace` ops so tests can compare planner regions against the real surface.
5. Tests:
   - unit: each reducer row; interrupted batch; relay `end+begin` in one batch; nested tasks; merged descendants; absorbed begin/end; our fold vs auto fold vs pruner replacement; delegate failure cap;
   - property (fast-check): random interleavings of begin/end/other calls/compactions/prunes → invariants 1–4;
   - replay equivalence: `apply` from scratch vs from a JSON round-tripped checkpoint at every position.

Acceptance: 100% branch coverage of `projection.js` and `cuts.js`; property tests run 1,000 cases in < 10 s.

### M2 — Tools without folding

Goal: the plugin installs, the model can open and close tasks, verdicts land in the log, the projection is live. No folds yet.

Tasks:

1. `settings.js` with the Config schema ([03 §10](03-architecture.md#10-settings)) and clamping readers.
2. `estimate.js` over `ctx.tokenMeter.estimateMessage`, with a cache keyed by seq.
3. `tools.js`: `task_begin` and `task_end` with `render`, `presentationMeta`, PTC refusal, id reservation, verdict logic; `texts.js` holding every string.
4. `host/index.js`: register projection (await the promise), tools, prompt section; detect a pre-existing `task_begin` tool and stay inactive with a diagnostic.
5. Package files: `package.json` (exports, files, `dsh.bundle`, `dsh.client`, peers), `cordis.patch.yml`, `locale/en.json`, `icon.svg`.
6. Tests: tool execute/render/meta with a fake session; prompt budget test ([04 §4](04-tools-and-prompt.md#4-token-budget)).

Acceptance: installed in a local profile; a scripted session opens and closes nested tasks, including a relay in one message; the log carries the expected meta; the projection state after restart equals the state before.

### M3 — Self-summary folding

Goal: folds happen, fast, at the right boundaries.

Tasks:

1. `engine-adapter.js`: resolve the base class (bare import, then the documented fallback), build the subclass whose `summarize()` returns prepared blocks with no LLM call, construct it with `auto: false`; expose `foldRegion(start, end, agent, signal, blocks)`. All `node_modules` probing lives here and nowhere else.
2. `fold-runner.js`: pre-step and turn-stopping handlers; due selection; summary extraction from the end call arguments; node text ([04 §6](04-tools-and-prompt.md#6-fold-node-text)); balanced-edge assertion; error handling per [03 §5.3](03-architecture.md#53-self-summary-fold-default-path); per-session in-flight guard.
3. Timing: measure pre-step handler time; log a warning above 100 ms.
4. Tests: runner against a fake engine (call order, inner-first, busy retry, demotion to delegate); contract test of the adapter against the real published `dsh-compaction-basic` tarball (`scripts/contract-check.js`, run in CI): exports, `summarize` hook dispatch, `compactRegion` signature, constructor injections.

Acceptance: in a live session, a closed task above the floor folds at the next step boundary after the report; the fold node shows the title and footer; pre-step p95 < 100 ms on a session with ≥ 5k events.

### M4 — Recall

Tasks:

1. `recall.js`: list (from `state.folds`, nested by shadowed fold nodes), index with paging, range with caps, grep.
2. Message brief renderer (one line per message: role, tool name, first text) — adapt taskfold's `span-preview.mjs` ideas, not its code.
3. Tests: recall output equals `deriveEventMessage` of `shadowedSeqs`; nested fold display; caps and truncation notes.

Acceptance: recall works for task folds, auto compactions and pruned results; no file is written anywhere.

### M5 — Delegate fallback

Tasks:

1. `summarizer.js`: prefix-anchored request (with `toolHistory`), instruction ([03 §7.2](03-architecture.md#72-delegate-instruction)) with numbered span index and size budget, output validation.
2. Idle scheduling via `whenIdle()` + `runMaintenance()` (per the M0 answer to Q3).
3. Durable failure cap via the projection.
4. Port taskfold's cache verification idea as `scripts/verify-cache.js`: from a live session log, compare each delegate fold's `usage` (cache read vs fresh input) with its span size.

Acceptance: a task closed with an empty summary folds after the turn without delaying the user's next message; three consecutive failures stop retries across a restart; cache-hit ratio ≥ 80% on delegate folds.

### M6 — Hints and UI

Tasks:

1. `hints.js`: stale-task hint with buckets and the durable latch.
2. `client/client.js`: dock and settings card; locale lookups; theme tokens only.
3. Tests: hint publication sequence over a synthetic session; view memoization.

Acceptance: the dock reflects open/folding/recent tasks live; the hint appears once per bucket and never after a restart for the same bucket.

### M7 — Evaluation and release

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
| `meta` or replace events are not delivered to projections as assumed | Core design breaks | M0 verifies before M1 |
| Host refactors `BasicCompactionEngine` | Folds stop | Isolated adapter + contract test in CI + upstream proposal (M8) |
| Models ignore the task discipline | No folds | Host auto compaction still works; implicit per-turn task as a follow-up option |
| `runMaintenance` semantics differ from the reading in 02 | Delegate folds block or never run | M0 task 4; fallback: run delegate in `turn-stopping` (blocks idle, not steps) |
