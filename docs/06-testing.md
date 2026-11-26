# 06 — Testing and evaluation

## 1. Layers

| Layer | What | Where | Runs |
|---|---|---|---|
| Unit | Pure functions: reducer rows, cut translation, planner, texts, settings readers, recall formatting | `test/*.test.js` | every commit |
| Property | Invariants over random event sequences | `test/properties.test.js` | every commit (1,000 cases) |
| Invariants | The eight promises of docs/03 §12 over generated event streams: monotone cuts, idempotent `apply`, stack/table consistency, cut translation, `shadowedSeqs ⊆ region`, region-key independence, `estTokens` non-growth, checkpoint replay equivalence | `test/invariants.test.js` | every commit (8 × 200 + a non-vacuity guard, fixed seed) |
| Degradation | The plugin with a host service missing or a journal damaged: no engine, no `llm`, no tool sink, no projection sink, malformed `meta`, foreign `stateVersion`, impossible seq, corrupt summary | `test/degradation.test.js` | every commit |
| Fault injection | Every seam throwing: `stateOf`, the pairing checks, `foldRegion` before and after the transaction, `delegate.start` sync-throw/reject/`null`, abort, the compaction lock, a throwing logger, a throwing token meter | `test/faults.test.js` | every commit |
| Replay | Projection from scratch vs from checkpoints | `test/replay.test.js` | every commit |
| Component | Tools (including recall) and the fold runner against a fake session and fake engine | `test/tools.test.js`, `test/recall.test.js`, `test/fold-runner.test.js`, `test/engine-adapter.test.js`, `test/plugin.test.js` | every commit |
| Package | Manifest and tarball contract: every `exports` path resolves, the `./client` loader form and `dsh.client` pass the host's own rules, patch rows are named after the package, `files` covers every runtime import, and the packed tarball ships no tests or CI | `test/manifest.test.js` (inside `npm test`), `scripts/check-pack.js` (`npm run pack:check`) | every commit, offline |
| Contract | Adapter assumptions against published host packages | `scripts/contract-check.js` | Weekly and on demand (`.github/workflows/contract.yml`), and before each release; it needs network, so it never gates a push |
| Live | Real DSH host driven headlessly: `scripts/e2e-headless.js` mounts the plugin into a scratch DSH home built from the shipped `headless` template, runs a scripted session in one process per turn (`dsh --profile <p> --json [--session-id <id>] "<task>"`, so a restart is the normal case; see [02 §11](02-host-api.md#11-operations-live)), and asserts the NDJSON turn stream and the session journal in two scenarios — `self` (the model's summary is used) and `delegate` (the plugin generates one, the cache-hit check of `scripts/verify-cache.js` must pass) | `scripts/e2e-headless.js` (`npm run e2e`), `test/e2e-headless.test.js` | Nightly (`.github/workflows/e2e.yml`) and before each release; needs an API key (`DEEPSEEK_API_KEY` or a credentials file to copy) |
| Evaluation | Task suite, configurations A/B/C/D; `scripts/eval-report.js` computes the protocol's metrics from journals | `scripts/eval-report.js` | M7 and on demand |
| Mutation | Single-operator mutations of `cuts.js`, `projection.js` and `planner.js` in a throwaway copy; a surviving mutant is a missing assertion | `scripts/mutate.js` (`npm run mutation`, `--min-score 0.85`) | before a release; too slow for every commit |

The **release gate** is `npm run release:check`: the six offline gates (lint, typecheck, test, coverage, perf, pack:check), then `npm run contract` and `npm run e2e` — the two a push cannot run. `prepublishOnly` calls it, so a plain `npm publish` runs all eight gates first. Two limits are worth spelling out: the gate inspects the working tree, not the packed tarball (`pack:check` narrows that gap by checking what npm would pack from the same tree), and `npm publish --ignore-scripts` skips the hook entirely; `--static` skips the network- and key-dependent pair for an offline build, and `--full` adds the mutation run. Each child gets its npm cache under `.tmp/`, because `~/.npm` can be read-only.

The **coverage gate** covers every `host/**/*.js` file at ≥ 90 % lines, ≥ 85 % branches and ≥ 80 % functions (`npm run coverage`); the two pure modules `domain/projection.js` and `domain/cuts.js` stay at 100 %. Line coverage is a floor, not a goal — `npm run mutation` answers whether the tests can fail at all: after the move to `host/domain/`, `cuts.js` scores 90 % (18/20) and `planner.js` 86.7 % (39/45); `projection.js` was last measured at 89.1 % before the implicit-turn change, so that number is **stale**: a re-run was started on 2026-11-26 and aborted after about 20 minutes without reaching the end. It is 236 single-operator mutants and each one runs five test files, so the whole run is an hour or more single-threaded — a release job, not a per-commit one. `npm run mutation` prints the survivors by file, line and replacement.

## 2. Fixtures

### 2.1 Event DSL

`test/fixtures/sim.js` emits host-shaped events with increasing seqs, keeps the surface the way the host does, feeds every event to the projection, and emulates the task tools' meta at execution time. `test/fixtures/ops.js` holds the random-program operations and the invariant checks. An interrupted step is modeled as the host's session repair leaves it: synthetic error results for unanswered calls, then `step/end`. The original sketch:

```js
const s = session()
s.user('fix the login loop')
s.assistant(call('task_begin', { title: 'Fix login loop' }, 'c1'))
s.result('c1', { meta: { tf: 1, op: 'begin', id: 'T1', title: 'Fix login loop', parent: null } })
s.assistant(call('read', { path: 'a.ts' }, 'c2'), call('read', { path: 'b.ts' }, 'c3'))
s.result('c2'); s.result('c3')
s.assistant(call('task_end', { summary: '…' }, 'c4'), call('task_begin', { title: 'Next' }, 'c5'))
s.result('c4', { meta: endMeta('T1', 'queued') }); s.result('c5', { meta: beginMeta('T2', null) })
s.compact({ startSeq, endSeq })   // emits compaction/start, summary, replace user/message, end
s.prune(seq)                      // emits compaction/prune + replacing tool/result
```

The DSL also maintains a simulated surface (`nodes`) by applying `replace` ops by position, exactly like the host, so planner output can be checked against it.

### 2.2 Recorded logs

Real session logs (JSONL) captured from a live host, scrubbed of secrets. The M0 journals in `m0/sessions/` are the first set (decoded from `session.v4.jsonl.zstd`; first line is the session header without `seq`): batches of several calls (S2), a resume (S1), three automatic checkpoints (S3b), a `/compact` (S0-S3c-S5), tool-result prunes (S3), PTC dispatches (S4, S4b) and a fork (S6). Later captures go under `test/fixtures/logs/` (`m2-*.jsonl` for tools without folding, `m3-*.jsonl` for self-summary folds, a realm checkpoint and a nested relay), replayed by `test/m2-journals.test.js` and `test/m3-journals.test.js`. They pin the real event shapes (`tool/result` format v4, `meta` placement, replacement envelopes). Every reducer change must still replay them without throwing and with unchanged terminal verdicts (snapshot test).

`e2e-headless-self.jsonl` and `e2e-headless-delegate.jsonl` are the two sessions of one `npm run e2e` run (task → fold → recall, one process per turn). `test/e2e-headless.test.js` replays them and asserts the *whole* check list of the E2E, then breaks the events one defect at a time (no replacement, no summary, no usage, a low `cacheReadTokens`, the wrong verdict, no recall) to prove each check can fail; the paths in them were rewritten to `~/…` and they carry no secrets.

## 3. Invariants as properties

Generated sequences mix: task begins/ends at random depths (including relays in one batch, ends naming a non-innermost id, begin+end of the same task in one batch), unrelated tool calls with random result counts, interrupted batches, auto compactions over random head ranges, pruner replacements of single results, our own folds of due tasks (applied by a test runner that uses the real planner).

Checks after every event:

1. every region from `resolveRegion` is balanced at both edges (using a reference implementation of tool pairing over the simulated surface);
2. regions of different tasks are disjoint or nested;
3. `apply` replay equivalence at that position;
4. terminal verdicts never change; every closed task has exactly one verdict;
5. `open` equals the set of tasks with status `opening`/`open`, in begin order.

## 4. Performance tests

- `test/perf.manual.js` (`npm run perf`, its own CI step, because `npm test` runs a dozen files in parallel and wall-clock budgets would measure the scheduler): build a synthetic log of 80k events with 200 tasks; assert that a pre-step call with nothing due takes < 2 ms and that a cold folding boundary (one due self fold, fake engine) takes < 10 ms. The "does not grow with the log" invariant is pinned by the same absolute budget at 5k and at 80k events on the idle boundary rather than by a ratio of two sub-millisecond medians (that ratio is mostly scheduler noise). A boundary that folds pays three `surface.nodes.indexOf` calls, i.e. O(surface), which the design accepts (`docs/03` §5.2); what must not grow with the log is everything else, and `test/fold-runner.test.js` proves structurally that no code path snapshots or iterates the log.
- A guard test that wraps `session.snapshotEvents` in the fake session to throw, and runs the pre-step and turn-stopping handlers.

### Cache-hit guard

`scripts/verify-cache.js <journal...> [--min-ratio 0.8] [--json]` reads a session journal and prints, per summarization, whether it came from the LLM seam (delegate) or is an unmarked self fold, and its cache-read share; it compares those with the session's own `assistant/message` usages and exits non-zero when an LLM-backed summary is below the floor or more than 10 points below the main median. Self folds have no LLM call and are never counted. Run it on every captured M5+/M7 session: the plugin must not lower the cache-hit rate (invariant 9 in `docs/03` §12).

## 5. Evaluation protocol

### 5.1 Configurations

A. no plugin (host auto compaction only); B. taskfold 0.40.1; C. this plugin, `self` mode; D. this plugin with `minSummaryChars` set very high so every task goes to `delegate` (isolates summary authorship).

### 5.2 Task suite

10–20 long tasks on fixed repository snapshots, each needing 50–300 steps: multi-file refactors, bug hunts with false leads, multi-PR reviews, a feature with tests. Each task has an automated pass/fail check. Three runs per task per configuration, same model and settings.

### 5.3 Metrics

| Metric | Source |
|---|---|
| Billed tokens split into cache-hit input, cache-miss input, output (main requests and fold requests separately) | `usage` on assistant attempts and `compaction/summary` events |
| Peak and mean context size | request headers / token meter |
| Task success rate, steps to completion, wall time | suite checker, log timestamps |
| Fold count, verdict distribution | projection state at the end |
| Summary-to-span token ratio | fold rows |
| Recall calls per fold; repeated file reads after a fold | log |
| Rejected task-tool calls | `tool/result` with `isError` for our tools |
| Pre-step handler latency p50/p95 | plugin timing log |
| First-request prompt tokens | first request header |

### 5.4 Reporting

Publish per-configuration medians with interquartile ranges, the raw table, the model and host versions, and the exact suite revision. State plainly that numbers come from this suite and these models.
