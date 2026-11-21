# 07 — Open questions

Each question names the assumption, why it matters, and how it was (or will be) settled. Answered questions keep their record so the reasoning behind the design stays traceable. Evidence for M0 answers: [`m0/REPORT.md`](../m0/REPORT.md) (host 0.2.2-rc.5, 2026-11-20).

| Q | Topic | Status |
|---|---|---|
| [Q1](#q1) | PTC calls | Answered — assumption corrected |
| [Q2](#q2) | `meta` durability | Answered — confirmed |
| [Q3](#q3) | Idle scheduling | Answered — confirmed; design changed (ADR 0006) |
| [Q4](#q4) | Module resolution | Answered — layout-dependent; peers are not linked (M2) |
| [Q5](#q5) | Checkpoint framing | Answered (M7): the host owns it |
| [Q6](#q6) | Deferred `fold_recall` | Answered (M7): rejected — it costs the tool's discoverability |
| [Q7](#q7) | Loader row, dock slot | Answered — confirmed |
| [Q8](#q8) | Replacement events | Answered — confirmed, with precisions |
| [Q9](#q9) | Concurrency in a batch | Answered — refuted (sequential) |
| [Q10](#q10) | Implicit per-turn task | Open (after M7) |
| [Q11](#q11) | Recording a failed delegate generation | Answered — confirmed live in M5 |
| [Q12](#q12) | Source of `system`/`tools` for delegate requests | Answered — request mirrors the host's; measured by `scripts/verify-cache.js` |
| [Q13](#q13) | Collapsing an `outer` task after its children folded | Answered (M7): keep `below-floor` |
| [Q14](#q14) | Re-checking a `below-floor` verdict after later folds | Answered (M7): final |
| [Q15](#q15) | The model packs `task_begin` together with the first work calls | Answered — M7 prompt line, measured live (3/3; large-span run folded) |

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
**Answered (M7):** the framing is not ours to write. `CHECKPOINT_PREAMBLE` is a module constant in
`@deepseek-ai/dsh-compaction-basic/src/summarizer.ts:70`, and `frameSummary` (ibid. ~190) wraps
whatever a `summarize()` returns; this plugin's `summarize()` hands back the model's blocks and the
host adds the preamble around them. Supplying a different framing would mean reaching past the
documented hook into host internals.
**Judged harmless as used:** "build on it without restating it" and "continue the task directly" stay
right when the folded span sits mid-history; only "the messages that follow" shifts meaning from the
start of a conversation to the next piece of work, and the M3/M5 sessions read it that way.
**Left for M8:** the upstream proposal asks for a `framing` field on the compaction contract, so a
host — not a plugin — can say where the span sat.

<a id="q6"></a>
## Q6 — Deferred loading of `fold_recall`

**Assumption:** `deferLoading: true` saves ~210 tokens per request at the cost of a lookup on first use.
**Measured (M7):** the saving is real — the `fold_recall` schema is 833 characters, ≈ 208 tokens, and
the always-on surface drops 2,979 → 2,146 characters (≈ 745 → 536 tokens, host-priced). The cost is
not "a lookup on first use", it is the tool disappearing from the model's view: in 0.2.2-rc.5 a
deferred tool registered before the first request never gets the `tool_addition` block that would load
its definition (`dsh-agent-loop/src/agent.ts:699–707` emits it only for a tool absent from the previous
header; `dsh-llm/src/content.ts:468–469` says a deferred baseline tool still needs its first addition),
so the description and the parameter schema never enter context.
**Live check:** with the flag set, the model asked to "use fold_recall to list the folds" answered with
three `bash` calls and never touched the tool; with the flag removed in the same session shape, its
first call was `fold_recall`. One run each way, so treat it as a strong signal rather than a
measurement — but the mechanism is the host's, and the direction is not in doubt.
**Answered (M7): not deferred.** 208 tokens against a tool the model no longer knows is a bad trade;
the always-on surface stays at ≈ 745 tokens (04 §4), which is still a third of taskfold's.
**Revisit when** the host can activate a deferred baseline tool (a tool-search call, or a
`tool-addition` producer for tools in the first header); then this is a one-line change in
`host/tools/` plus re-pinning `test/prompt-budget.test.js`.

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
**Answered (M7): keep `below-floor`.** Collapsing here buys less than the floor exists to protect: the
span is two summary nodes plus one closing batch, so the saving is a few hundred tokens at best, while
the cost is real — a summary of summaries loses exactly the file paths and decisions that
`fold_recall` exists to bring back, and it would add a second fold level over content that is already
condensed. The floor is also what keeps the tree stable: a rule such as "fold anyway when the span is
only fold nodes" needs every node tagged with its origin, a new node class in the projection, and a
second floor for the resulting summary. Not worth it for ~1.9k tokens; recorded so the next person
does not re-litigate it.

<a id="q14"></a>
## Q14 — Re-checking a `below-floor` verdict after later folds

**Observed:** a task closes `below-floor` because its span is smaller than `minSpanTokens`. A later
fold of a *neighbour* can shrink the surface around it, but the task's own span is fixed at its cuts —
so the verdict cannot become "foldable" by waiting. Only a partial replacement inside the span would
change the arithmetic, and that replacement also makes the span stale.
**Answered (M7): the verdict is final.** Re-checking would mean revisiting every `below-floor` task on
every boundary (O(tasks) on the hot path) to catch a case the cuts make impossible. The verdict is
also durable in the log; rewriting it later would make two sessions with the same events report
different fold counts.
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
**Answer (M7).** The prompt line is `Call task_begin in its own message, before the work it covers.`
— the section is 664 of 800 characters and the whole prompt surface 2,979 of 3,400
([04 §3–4](04-tools-and-prompt.md#3-system-prompt-section)); the hint was not needed. Live, three
fresh headless sessions on a scratch profile (`staleTaskSteps: 5`), the same prompt on two 7-line
files: in every run the `task_begin` call and result were in step 1 while both `read` results arrived
in step 2 — run 1 `049cf597` begin result at seq 21 vs read results 28/29, run 2 `6a75a23a` 20 vs
28/29, run 3 `e2e4420e` 21 vs 32/33 (step 1 there also carried an unrelated `bash ls`, so that call is
outside the span too). The task's `beginCut`/`spanStart` therefore bracket the reads, and the M5 shape
did not reproduce. All
three still closed `below-floor` (estTokens 380, 366, 346): two 7-line files are far below the
2,000-token floor, so that is the economy rule doing its job, not the defect. A supplementary run on
two 247-line files (same profile and prompt) closed `queued` at 13,619 tokens and folded at the next
boundary (fold #0, 5 messages, 13,644 tokens), so a task whose span now contains its work folds.
Three runs are weak evidence: they show the line lands, not how robust it is. A larger sample, a case
that needs real work before closing, and the same prompt without the line as a control would settle
it; no control was run here because the instruction forbade forking the repo, so the M5 observations
quoted above are the baseline.
