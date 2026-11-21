# M5 — Delegate fallback: acceptance report

Date: 2026-11-21. Scope: milestone M5 ([`docs/05-implementation-plan.md`](../docs/05-implementation-plan.md) §3).
The cache-hit requirement is the primary acceptance criterion here and was measured, not assumed.

## 1. Environment

| Fact | Value |
|---|---|
| dsh | 0.2.2-rc.5 (`~/.dsh/runtime`) |
| Node | v24.19.0 |
| Host | Linux 6.17.13-2-pve, 2 vCPU |
| Scratch Harness home | `<repo>/.m5-scratch/dsh-home` (deleted after the runs) |
| Profile `m5` | `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless` + this repository |
| Working files | `ledger.md`, `ledger_extra.md`, `third.md` — 300 rows each |

`~/.dsh/profiles` still holds exactly `node_modules`, `rescue`, `web`.

## 2. What was built

| File | Content |
|---|---|
| `host/summarizer.js` (new) | `buildDelegateRequest` (the surface prefix + the span), `routeOfRequest`, `indexLinesFor`, `generateDelegateSummary` (assembles through the host's `BlockAssembler`), `validateDelegateSummary` |
| `host/texts.js` | `renderDelegateInstruction` and the delegate error strings — every model-facing string still lives in one module |
| `host/fold-runner.js` | two-phase delegate fold: phase 1 starts one generation per session before folding anything, phase 2 commits at a later boundary when the region key still matches; durable failure accounting through `rejectRegion` |
| `host/engine-adapter.js` | `rejectRegion` (a `summarize()` that rejects, so the host writes `compaction/end{error}`) and `usage` forwarding into `SummaryResult` |
| `host/index.js` | the delegate seam: settings override → the session's routed target → agent options; span-sized instruction budget; `usage` carried back |
| `scripts/verify-cache.js` (new) | reads a journal and audits cache-hit per summary against the session's own main requests |

## 3. Cache-hit — the critical requirement

Invariant 9 in [`docs/03`](../docs/03-architecture.md) §12: a delegate request must replay the main
request's prefix byte-for-byte, so its provider cache-hit stays within 10 percentage points of the
session's main requests and above 80 %.

Measured on the live session (`test/fixtures/logs/m5-delegate-fold.jsonl`):

```
$ node scripts/verify-cache.js <session journal>
  seq  kind      provider           model           shadowed  cacheRead  input  ratio
  235  delegate  deepseek-official  deepseek-flash     12950      22912    218  99.1%
  main requests: 29 with usage (min 19.7%, median 99.3%)
  verdict: 1 LLM-backed summary, worst 99.1%; vs median main request 99.3% (delta -0.2 pp, tolerance -10.0 pp); floor 80.0% — ok
```

**−0.2 pp against the session's own median, 99.1 % absolute.** The delegate call reuses the warm
prefix; the only fresh input is the instruction (218 tokens).

Two real defects were found while getting there, both fixed:

1. **The region key included the surface length.** During generation the model keeps appending
   messages, so the key changed on nearly every boundary and every generated summary was discarded —
   the delegate path could never commit. The key now covers exactly the seqs of the region; the test
   `nodes appended after the region do not drop a valid summary` pins it.
2. **The delegate fold was invisible to the audit.** The plugin hands the host prepared blocks, so
   the summary is unmarked (`llmStreamCall` absent, as ADR 0004 requires) — which made it look like a
   self fold to `verify-cache.js`. The classifier now treats a summary that carries `usage` as
   LLM-backed; without that fix the cache requirement would have been unmeasurable for this plugin.
   The plugin also had to forward the provider usage into the summarize result at all: without it the
   host writes no `compaction/summary.data.usage` row.

## 4. Live acceptance

### 4.1 A delegate fold commits

Session `6f8ce5e5`: a task closed with a deliberately short summary (`delegate` verdict), then the
next boundary started a generation (`started for T1` → `result ok`) and a later boundary committed it:

```
234 compaction/start
235 compaction/summary   (unmarked, usage: read 22912 / fresh 218)
237 compaction/end       (clean)
T1 ledger review two → folded, foldIndex 0, 5 shadowed messages, ~12.9k tokens
```

The node the model saw is the delegate text: it names both files, keeps `ACC-9931` and the audit
window, and reports the sizes — a usable continuation.

### 4.2 The durable failure cap (Q11)

Session `96592efd`: the same shape of task, but the profile's `summarizationModel` was pointed at a
model that does not exist. Each boundary started a generation, the provider refused it, and the
runner recorded the failed attempt durably through `rejectRegion`:

```
52 compaction/start → 53 compaction/end { error: "task-folding: the delegate summary could not be generated" }
68 compaction/start → 69 compaction/end { error: … }
… third attempt …
T1 "cap check" → failed, failures 3
```

No surface replacement, no LLM-billed retry loop. This confirms **Q11** live: a rejected `summarize()`
produces exactly the `compaction/start` + `compaction/end{error}` pair the reducer counts, at no cost
(the generation had already failed before the transaction).

### 4.3 What surprised me

- **The model packs `task_begin` together with the reads.** Twice in a row the whole "read two files
  and review" landed in the same assistant message as the `task_begin` call, so `beginCut` was the
  last result of that batch and the task's span was empty (245 tokens → `below-floor`). Asking for
  "step 1: open the task and nothing else" fixed it. This is a discipline issue worth a hint later
  (recorded as Q15), not a projection bug: the cuts behave exactly as designed.
- **Cache-hit is cheap to keep but easy to break silently.** Both defects above failed no test and
  raised no error — one lost every summary, the other made the audit blind. The new
  `scripts/verify-cache.js` and the M5 fixtures are what make it visible.

## 5. Tests and gates

| Gate | Result |
|---|---|
| `npm test` | 195 tests (151 at M4), all pass |
| `npm run coverage` | 100 % branch/line/function for `host/projection.js` and `host/cuts.js` |
| `npm run perf` | 4 guards |
| `npm run typecheck`, `npm run lint` | clean |
| `npm run contract` | 10/10 against published 0.2.2-rc.5 |

New tests: `test/summarizer.test.js` (request shape and tools identity, instruction content, index
lines, generation through a stub `BlockAssembler`, validation branches), `test/verify-cache.test.js`
(13: CLI, fixtures, ratio/verdict, the usage-based delegate classification),
`test/fold-runner.test.js` (+11: start-without-blocking, commit of the generated blocks, region key
semantics including prune and append, durable rejection, one generation per session, no seam, no stale
region, usage forwarding), `test/m5-journals.test.js` (3: the live delegate fold, the failure cap,
meta shapes).

## 6. Deviations and doc changes

1. **`foldRegion` gained a `usage` argument** (adapter + runner + docs/03 §5.4). Without it the host
   records no usage for a fold and the cache audit cannot see the plugin's own folds.
2. **Delegate summaries are unmarked by design** (`llmStreamCall` absent) yet carry provider `usage`;
   `scripts/verify-cache.js` and `docs/06` say how a delegate fold is recognised.
3. **The region key covers the region's seqs, not the surface length** (docs/03 §5.4 corrected after
   the live failure).
4. **`delegate.start` is called synchronously** rather than one microtask later: the region was just
   resolved against this surface, and one microtask is enough for a self fold in the same pass to
   move it (found by the subagent's probe; the summarizer would splice the wrong messages).
5. **The runner prunes generated text for tasks that became terminal** without being due again, so a
   session does not hold stale blocks in memory.

## 7. Deliverables

- Commits on `main`: the summarizer + instruction, the two-phase runner + `rejectRegion` + usage
  forwarding, the cache verifier + Q11/Q12 answers, this report + docs.
- Fixtures: `test/fixtures/logs/m5-delegate-fold.jsonl` (the delegate fold and its cache numbers) and
  `m5-failure-cap.jsonl` (three durable attempts → `failed`), scrubbed.
- The scratch home `.m5-scratch/` was deleted after the runs.

Stopping here: M6 (hints and the dock) is not started.
