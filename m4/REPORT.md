# M4 — Recall, and the repairs from the M3 review: acceptance report

Date: 2026-11-21. Scope: §1 of [`docs/08-followups.md`](../docs/08-followups.md) (F1, F2, F4, F5, F6) and
milestone M4 from [`docs/05-implementation-plan.md`](../docs/05-implementation-plan.md). M5 is not started.

## 1. Environment

| Fact | Value |
|---|---|
| dsh | 0.2.2-rc.5 (`~/.dsh/runtime`) |
| Node | v24.19.0 |
| Host | Linux 6.17.13-2-pve, 2 vCPU, load average 6–7 during the work (the machine runs other work) |
| Scratch Harness home | `<repo>/.m4-scratch/dsh-home` (deleted after the runs) |
| Profile `m4` | `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless` + this repository |
| Working files | `billing.md` and `ops.md`, 303 lines each, each carrying one value worth recalling |

`~/.dsh/profiles` still holds exactly `node_modules`, `rescue`, `web`; no existing profile was touched.

## 2. Repairs (§1 of 08)

### F1 — a fold no longer loses a boundary silently

When another compaction holds the durable lock, the runner now re-reads the projection and retries the
same task once inside the same pass (the retry through the engine *is* the lock check, so the runner
never looks for a `compaction/end` in the log). If the retry is busy too, the pass stops, the task stays
`queued` for the next boundary and exactly one line per task per process is logged:
`task-folding: folding T1 waits: the compaction lock is held by another compaction`. If the other
transaction already shadowed the span, the runner just continues with the next task. Four runner tests
cover it: retry-then-succeed in one pass, permanently busy stops the pass, one log line for the process,
and "the competitor already folded it" (no stop, no log).

### F2 — the cold folding boundary

`SpanEstimator.regionTokens(session, nodes, startIndex, endIndex)` resolves the per-session cache once
and loops with plain `Map` access; `span()` and `node()` keep their behaviour and the same bound. The
runner's region estimate uses it.

Measuring this honestly turned out to be the interesting part, because the machine was heavily
oversubscribed: `npm test` runs a dozen test files on two vCPUs, and wall-clock budgets then measure the
scheduler. Three changes to the guard:

1. The performance guards moved to **`test/perf.manual.js`** and **`npm run perf`**, run as their own CI
   step; `npm test` stays fast and parallel. `docs/06` §4 says so.
2. The fixture reaches the fold floor with *tokens* (50 per message) instead of thousands of nodes, so
   the guard measures the boundary rather than the cost of walking a huge span.
3. The 5k-vs-80k **ratio** was replaced by the same absolute budget at both sizes. A ratio of two
   sub-millisecond medians swung 2–8× with no code change on this host, which made it a coin flip; the
   absolute budget pins the same invariant and is stable. A boundary that *folds* pays three
   `surface.nodes.indexOf` calls, i.e. O(surface), which `docs/03` §5.2 accepts; the log-side invariant is
   what must not grow, and `test/fold-runner.test.js` proves structurally that no path snapshots or
   iterates the log (its fake session throws on `snapshotEvents` and `events`).

Result: 6 consecutive green runs of `npm run perf` on this host (the guard asserts < 2 ms idle, < 10 ms
cold folding boundary, and the same budget at 80k).

### F4 — the contract check runs somewhere

`.github/workflows/contract.yml` runs `npm run contract` weekly (`cron: '0 6 * * 1'`) and on demand —
never on push, because it downloads published host packages. While wiring it, a real blocker surfaced:
the script created its scratch directory inside `.tmp/`, which does not exist in a fresh checkout, so
`npm run contract` failed with `ENOENT` before touching the network. The script now creates the parent
directory itself, and the check runs green from a clean tree:

```
@deepseek-ai/dsh-compaction-basic@0.2.2-rc.5 (lib/index.js, 50710 bytes)   6 ok
@deepseek-ai/dsh-compaction@0.2.2-rc.5 (lib/index.js, 7462 bytes)         4 ok
all contract checks passed
```

### F5 and F6 — documentation

`docs/03` §10 now names the four settings that are live today and forbids exposing the others before
M5/M6; `docs/02` §6 gained "A realm engine that fails to mount" with the exact message, the constraint
`retainRatio < thresholdRatio`, and the reason it is easy to miss (a plugin-owned engine keeps folding).

## 3. M4 — recall

`host/recall.js` (new) reads a fold back from the log: list with nesting, index with paging, exact range,
grep. It never snapshots the log and its only import is `host/texts.js`. All model-facing text lives in
`texts.js`; `fold_recall` in `host/tools.js` dispatches to it, keeps its schema, writes no meta, and
returns a clean sentence for an unknown task, an unknown fold, a bad page, a bad regex or a mixed
range+grep request.

Caps exactly as `docs/04` §1: 200 index lines per page, 20 messages and ~40k characters per range (with
`[truncated: narrow from/to]`), 50 hits and ~200 characters of context per grep hit.

### Live acceptance (session `87b91323`, fixture `test/fixtures/logs/m4-recall.jsonl`)

Two tasks were folded (4 messages and ~7.1k / ~5.7k tokens each), then the model was asked to work with
`fold_recall` only, "no file reads":

```
fold_recall({})                    → Folds (2):
                                     #1 T1 · billing review · 4 msgs · ~7.1k tokens
                                     #2 T2 · ops review · 4 msgs · ~5.7k tokens
fold_recall({ task: "T1" })        → Fold #1 · T1 · billing review · 4 messages
                                     L1 assistant: read
                                     L2 tool read: 309 lines
                                     L3 assistant: task_end
                                     L4 tool task_end: …
fold_recall({ task: "T1", grep: "invoice" }) → Fold #1 grep "invoice" (2 hits): L2: …billing notes…
fold_recall({ task: "T1", from: 1, to: 4 })  → the exact original JSON messages
```

Asked afterwards for the reference "you found with fold_recall", the model answered `INV-2026-4417` —
the value that only exists inside the fold's shadowed messages. It also correctly reported the ops fold's
`03:40 UTC` window from the summary. No file was re-read in those turns.

## 4. Tests and gates

| Gate | Result |
|---|---|
| `npm test` | 151 tests, all pass (was 134; +19 recall, the perf file moved out of the set) |
| `npm run perf` | 4 guards, 6 consecutive green runs |
| `npm run coverage` | 100% branch/line/function for `host/projection.js` and `host/cuts.js` |
| `npm run typecheck`, `npm run lint` | clean |
| `npm run contract` | 10/10 checks against the published 0.2.2-rc.5 packages |

New tests: `test/recall.test.js` (19: list with nesting and an auto-compaction row, paging and the fold
marker, exact range vs `deriveEventMessage`, 20-message and 40k-character truncation, grep substring and
`/regex/` and invalid regex and the 50-hit cap, unknown task/ordinal, the dispatch errors, the live M4
fixture, and a purity test with a deep-frozen state), plus the four rewritten busy cases in
`test/fold-runner.test.js` and the isolated `test/perf.manual.js`.

## 5. Deviations from the briefs, each reflected in the docs

1. **Perf guards are not in `npm test`.** They assert wall-clock budgets, and the parallel suite on this
   2-vCPU host measures the scheduler. They run as `npm run perf`, their own CI step (`docs/06` §4).
2. **The 5k-vs-80k ratio became "the same absolute budget at both sizes".** Justified in `docs/06` §4:
   a ratio of two sub-millisecond medians is noise; the absolute budget pins the same invariant.
3. **Nesting direction.** The subagent's brief said "nested under the earlier fold"; that is
   chronologically impossible — the shadowing fold is always the later one. `docs/03` §6.3 and `docs/04`
   were already right, and the implementation follows them.
4. **Range with one oversized message.** The first requested message is returned whole even if it alone
   exceeds ~40k characters (a message is indivisible and recall is lossless); the character budget limits
   what follows. Documented in `docs/04`.
5. **Grep scope.** One hit per message (its first occurrence) over the message's textual parts, not its
   JSON framing (`from`/`to` is the exact-JSON reader); a `[truncated: 50 of N hits]` note when capped.
   Documented in `docs/04`.

## 6. What surprised me

- **A wrong measurement is worse than a missing one.** The first perf guard looked green in M3 because
  the fixture was small and the host was idle; under real load it was measuring the scheduler, and it
  took three redesigned versions before it measured the plugin again. The lesson is in `docs/06`: run
  wall-clock guards alone, and prefer "the same budget at both sizes" over a ratio.
- **The contract check had never actually run in a clean checkout.** It passed locally only because
  `.tmp/` existed from earlier work; a fresh clone would have failed at `mkdtempSync`. Exactly the class
  of bug the new workflow exists to catch — it caught it before the first scheduled run.
- **Recall is cheap to get right when the fold row carries pointers.** `shadowedSeqs` plus
  `deriveEventMessage` reproduces the originals exactly, including the model's own `task_end` arguments,
  so no state has to be stored anywhere.
- **The model enjoys `fold_recall`.** Given "no file reads", it called the tool four times — list, index,
  grep, range — and answered from the log instead of asking to re-open a file.

Stopping here: M5 (delegate fallback) is not started.
