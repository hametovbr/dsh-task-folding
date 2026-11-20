# 06 — Testing and evaluation

## 1. Layers

| Layer | What | Where | Runs |
|---|---|---|---|
| Unit | Pure functions: reducer rows, cut translation, planner, texts, settings readers, recall formatting | `test/*.test.js` | every commit |
| Property | Invariants over random event sequences | `test/properties.test.js` | every commit (1,000 cases) |
| Replay | Projection from scratch vs from checkpoints | `test/replay.test.js` | every commit |
| Component | Tools and fold runner against a fake session and fake engine | `test/tools.test.js`, `test/fold-runner.test.js` | every commit |
| Contract | Adapter assumptions against published host packages | `scripts/contract-check.js` | CI, nightly, and before each release |
| Live | Real DSH host, scripted sessions | `test/live/` (manual, needs API key) | before each release |
| Evaluation | Task suite, three configurations | `eval/` | M7 and on demand |

## 2. Fixtures

### 2.1 Event DSL

A small builder that emits host-shaped events with increasing seqs:

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

Real session logs (JSONL) captured in M0/M2 from a live host, scrubbed of secrets, stored under `test/fixtures/logs/`. They pin the real event shapes (`tool/result` format v4, `meta` placement, replacement envelopes). Every reducer change must still replay them without throwing and with unchanged terminal verdicts (snapshot test).

## 3. Invariants as properties

Generated sequences mix: task begins/ends at random depths (including relays in one batch, ends naming a non-innermost id, begin+end of the same task in one batch), unrelated tool calls with random result counts, interrupted batches, auto compactions over random head ranges, pruner replacements of single results, our own folds of due tasks (applied by a test runner that uses the real planner).

Checks after every event:

1. every region from `resolveRegion` is balanced at both edges (using a reference implementation of tool pairing over the simulated surface);
2. regions of different tasks are disjoint or nested;
3. `apply` replay equivalence at that position;
4. terminal verdicts never change; every closed task has exactly one verdict;
5. `open` equals the set of tasks with status `opening`/`open`, in begin order.

## 4. Performance tests

- `test/perf.test.js`: build a synthetic log of 80k events with 200 tasks; assert that a pre-step handler call with nothing due takes < 2 ms and with one due self fold (fake engine) < 10 ms, independent of log length (compare 5k vs 80k: ratio < 2).
- A guard test that wraps `session.snapshotEvents` in the fake session to throw, and runs the pre-step and turn-stopping handlers.

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
