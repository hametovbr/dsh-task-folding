# 06 — Testing and evaluation

## 1. Layers

| Layer | What | Where | Runs |
|---|---|---|---|
| Unit | Pure functions: reducer rows, cut translation, planner, texts, settings readers, recall formatting | `test/*.test.js` | every commit |
| Property | Invariants over random event sequences | `test/properties.test.js` | every commit (1,000 cases) |
| Replay | Projection from scratch vs from checkpoints | `test/replay.test.js` | every commit |
| Component | Tools (including recall) and the fold runner against a fake session and fake engine | `test/tools.test.js`, `test/recall.test.js`, `test/fold-runner.test.js`, `test/engine-adapter.test.js`, `test/plugin.test.js` | every commit |
| Package | Manifest and tarball contract: every `exports` path resolves, the `./client` loader form and `dsh.client` pass the host's own rules, patch rows are named after the package, `files` covers every runtime import, and the packed tarball ships no tests or CI | `test/manifest.test.js` (inside `npm test`), `scripts/check-pack.js` (`npm run pack:check`) | every commit, offline |
| Contract | Adapter assumptions against published host packages | `scripts/contract-check.js` | Weekly and on demand (`.github/workflows/contract.yml`), and before each release; it needs network, so it never gates a push |
| Live | Real DSH host, scripted sessions driven headlessly (`dsh --profile <p> --json [--session-id <id>] "<task>"`, profile = `dsh-base` + `dsh-headless` + this plugin; see [02 §11](02-host-api.md#11-operations-live)) | `test/live/` (needs API key) | before each release |
| Evaluation | Task suite, three configurations | `eval/` | M7 and on demand |

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
