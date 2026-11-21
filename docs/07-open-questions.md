# 07 — Open questions

Each question names the assumption, why it matters, and how it was (or will be) settled. Answered questions keep their record so the reasoning behind the design stays traceable. Evidence for M0 answers: [`m0/REPORT.md`](../m0/REPORT.md) (host 0.2.2-rc.5, 2026-11-20).

| Q | Topic | Status |
|---|---|---|
| [Q1](#q1) | PTC calls | Answered — assumption corrected |
| [Q2](#q2) | `meta` durability | Answered — confirmed |
| [Q3](#q3) | Idle scheduling | Answered — confirmed; design changed (ADR 0006) |
| [Q4](#q4) | Module resolution | Answered — layout-dependent; peers are not linked (M2) |
| [Q5](#q5) | Checkpoint framing | Open (M7) |
| [Q6](#q6) | Deferred `fold_recall` | Open (M7) |
| [Q7](#q7) | Loader row, dock slot | Answered — confirmed |
| [Q8](#q8) | Replacement events | Answered — confirmed, with precisions |
| [Q9](#q9) | Concurrency in a batch | Answered — refuted (sequential) |
| [Q10](#q10) | Implicit per-turn task | Open (after M7) |
| [Q11](#q11) | Recording a failed delegate generation | Answered — confirmed live in M5 |
| [Q12](#q12) | Source of `system`/`tools` for delegate requests | Answered — request mirrors the host's; measured by `scripts/verify-cache.js` |
| [Q13](#q13) | Collapsing an `outer` task after its children folded | Open (M7) |
| [Q15](#q15) | The model packs `task_begin` together with the first work calls | Open (M6 hint or M7 prompt) |

<a id="q1"></a>
## Q1 — PTC (`run_code`) calls

**Assumption was:** task tools called from `run_code` produce no `tool/result` of their own; refuse when `exec.rootCallId` is set.
**Answer (M0, S4/S4b):** the first half holds — a nested call produces `tool/ptc-dispatch-start` + `tool/ptc-dispatch` (with the call's `meta` on `tool/ptc-dispatch.data.meta`) and no `tool/result`. The detection was wrong: `exec.rootCallId` is set for **every** call; for a direct call it equals the call's own id. A nested call has `exec.callId = "<rootCallId>:ptc:<n>"`. PTC ships disabled (`tool-executor-ptc: disabled: true`) and requires disabling the native executor.
**Design change:** refuse when `exec.callId !== exec.rootCallId` (03 §6.1); the reducer ignores `tool/ptc-dispatch`.

<a id="q2"></a>
## Q2 — `meta` durability

**Answer (M0, S1/S6):** confirmed. `presentationMeta` output is persisted verbatim as `tool/result.data.meta`, survives a full process restart and resume, and is replayed into a fresh projection (resume: `inheritedEventCount: 0`, whole-log replay; fork: inherited count, prefix replay).
**Design change:** none.

<a id="q3"></a>
## Q3 — Idle scheduling for delegate folds

**Assumption was:** `agent.whenIdle().then(() => agent.runMaintenance(job))` from `turn-stopping` runs `job` after the turn without hurting the user.
**Answer (M0, S5):** it runs right after the turn, but a user message sent meanwhile is **held until the job settles** and does not abort it. A 30–70 s delegate summary would therefore delay the user's next turn by up to that long.
**Design change:** delegate summaries are generated in the background, outside any lock or maintenance slot, and committed at the next step boundary like self-summaries ([ADR 0006](adr/0006-background-delegate.md), 03 §5.4). `runMaintenance` is not used.

<a id="q4"></a>
## Q4 — Resolving host packages from a profile bundle

**Answer (M0):** layout-dependent. With the bundle inside `profiles/<name>/node_modules/` (registry install), bare imports of `@deepseek-ai/dsh-compaction-basic`, `…/dsh-compaction`, `…/dsh-llm` and `@deepseek-ai/schemastery` succeed. With a development install (`dsh plugin add <path>` → pnpm `link:`), they fail because Node resolves the link's real path.
**Design change:** `engine-adapter.js` and `settings.js` try a bare import first, then `createRequire` anchored at the DSH runtime's `node_modules` (development installs only).
**Settled (M2):** declaring them as `peerDependencies` does **not** make `dsh plugin add` link them — the profile's `node_modules` gained only the plugin's own symlink, and the runtime-anchored fallback is what resolves `@deepseek-ai/schemastery` ([report](../m2/REPORT.md)). Peers stay declared anyway, because the runtime gates the plugin on their ranges; they are marked `peerDependenciesMeta.optional` so a dev install of this repository does not pull the whole host, and the host ignores that flag when gating (`docs/02-host-api.md` §1).

<a id="q5"></a>
## Q5 — Checkpoint framing for mid-history folds

**Assumption:** the host frames every summary with a preamble written for head-of-history checkpoints ("…Continue the task directly from the messages that follow…"; confirmed verbatim in M0 journals). For a mid-history fold this is slightly misleading.
**Settle:** evaluate in M7; include a framing option in the upstream proposal (M8).

<a id="q6"></a>
## Q6 — Deferred loading of `fold_recall`

**Assumption:** `deferLoading: true` saves ~210 tokens per request at the cost of a lookup on first use.
**Settle:** M7.

<a id="q7"></a>
## Q7 — One Loader row for Host + Client, and the dock slot

**Answer (M0, S0):** one row named after the package serves both halves. Both dock slots exist; `conversation.input.dock` renders on the home screen and in conversations, `conversation.composer.dock` only in an open conversation. `slots.inject` with a wrong slot name is silent.
**Design change:** use `conversation.input.dock` (03 §9).

<a id="q8"></a>
## Q8 — Replacement events in projections

**Answer (M0, S3/S3b/S3c):** confirmed. Checkpoint (`user/message`) and prune (`tool/result`) replacements reach `apply` with top-level `surfaceOp: { op: 'replace', startSeq, endSeq }` and complete `sourceEventSeqs`. Precisions:
- for a checkpoint, `sourceEventSeqs` = the checkpoint's `compaction/start` and `compaction/summary` seqs + `shadowedSeqs`; cut membership is unaffected (those two are not surface nodes);
- `shadowedSeqs` are in surface order, not numeric order;
- a prune is preceded by `compaction/prune` and its replacement `tool/result` **keeps the original `meta`**.
**Design change:** the reducer reads `meta` only from `append` results (03 §4.3); invariant 8 added.

<a id="q9"></a>
## Q9 — Concurrent tool execution within a batch

**Answer (M0, S2):** refuted for the native executor: the calls of one message run sequentially (`tool/call` → `tool/result` → next), each result committed before the next call starts.
**Design change:** ids come from `state.nextId`; the in-memory high-water mark stays only as a cheap guard (03 §6.1). PTC sub-calls can run in parallel, but task tools refuse PTC.

<a id="q10"></a>
## Q10 — Implicit per-turn task

**Open design question:** should a turn that ends with no open task and a span above the floor be folded automatically (delegate path)? It would cover models that ignore the discipline, at the cost of folding work the model may still want verbatim.
**Settle:** after M7 data on how often tasks are skipped; off by default if added.

<a id="q11"></a>
## Q11 — Recording a failed delegate generation durably

**Assumption:** calling `compactRegion` on a valid region with an adapter `summarize()` that rejects immediately makes the host append `compaction/start` + `compaction/end{ error }` and release the lock, at no LLM cost. The reducer counts that toward the delegate failure cap (03 §5.4).
**Why it matters:** without a durable record, a task whose summary keeps failing would be retried (and billed) after every restart.
**Answer from source (`packages/compaction/compaction-basic/src/region.ts` L211–L250, rc.5):** `compaction/start` is appended before `summarize()` runs; any error thrown from the summarize stage (unless `recover()` handles it — that path is for context-overflow recovery) makes the transaction append `compaction/end { error: errorChain(error) }` before rethrowing. So a rejecting adapter `summarize()` produces exactly the durable failure record the design needs.
**Settled (M5):** confirmed live. The adapter's `rejectRegion` (`engine-adapter.js`) runs `compactRegion` on the task's region with a `summarize()` that rejects immediately; the host appended `compaction/start` + `compaction/end{ error }` and released the lock, at no LLM cost, and the reducer's `compaction/end{ error }` row counted it. The cap turns the third failure into `failed`, so a task whose summary keeps failing is not retried after a restart. Design: 03 §5.4 "Failure accounting"; live evidence: [`m5/REPORT.md`](../m5/REPORT.md). The ADR 0005 fallback (an in-memory cap only) is not needed.

<a id="q12"></a>
## Q12 — Source of `system` and `tools` for delegate requests

**Answer (M5):** the delegate request is built exactly like the host's own summarization request: the surface prefix (the in-history `system` head + the span) followed by the instruction as the final user message, with `tools` (and `config`) from the latest `request/header`; `GenerateOptions` needs no header field beyond those to keep the prefix identical (02 §7). That is the envelope `summarizeWithLlm` builds for host compaction, so the provider's prefix cache applies to a delegate summary too.
**Measurement:** `scripts/verify-cache.js` reads the journals and reports, per journal, one row per `compaction/summary` (LLM-backed via `data.llmStreamCall` vs self fold, provider/model, shadowed tokens, cache read vs fresh input, cache-hit ratio), the session's main-request count with its min/median cache-hit ratio, and a verdict line comparing them. It fails (exit 1) when an LLM-backed summary is below `--min-ratio` (default 0.8) or more than 10 percentage points below the median main-request ratio.
**From the fixtures:** the only LLM-backed checkpoint in `test/fixtures/logs/` is the host engine's own (`m3-realm-compaction.jsonl`, seq 61) — 25,088 cache-read vs 466 fresh input, 98.2 %, against a main-request median of 98.9 % over 6 measured requests. The taskfold folds in the fixtures are self folds and carry no usage by design, so no delegate ratio is readable from them; the delegate number is what the script produces on an M5 journal.

<a id="q13"></a>
## Q13 — Collapsing a span made only of fold nodes

**Observed (M3):** after an inner task and its sibling folded, the outer task's remaining span held
only their two summary nodes and its own closing batch — 1,859 tokens — so the economy rule
(`estTokens − summaryTokens ≥ minSpanTokens`, 03 §6.2) made it `below-floor`. That is consistent with
the design, but it means a three-level session leaves the outer task unfolded while its children are
folded.
**Open:** whether to collapse such a span anyway (it saves little context but flattens the tree), or to
lower the floor for a span that consists only of fold nodes.
**Settle:** M7, with the evaluation data ([08](08-followups.md) Q13).

<a id="q15"></a>
## Q15 — The model packs `task_begin` together with its first work calls

**Observed (M5, twice):** the model answered "open a task and read two files" with ONE assistant
message carrying `task_begin`, `read`, `read`. The begin batch therefore ended after the last read
result, `beginCut` pointed there, and the task's span was the single closing message — 245 tokens, so
it closed `below-floor` and nothing folded. The cuts are behaving exactly as designed (a task's span is
what follows its begin batch); the discipline is not.
**Why it matters:** those tasks never fold, so the plugin's cost is paid (prompt) without the benefit.
**Options:** a prompt line asking for `task_begin` on its own; a hint when a task closes with an empty
span; or (design change) treating a batch that contains `task_begin` as part of the span.
**Settle:** M6 (hint) and M7 (prompt wording), with the evaluation data.
