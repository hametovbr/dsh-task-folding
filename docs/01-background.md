# 01 — Background

## The problem

A coding agent's context fills with finished work: tool output from steps that already succeeded, debugging detours, abandoned attempts. Every later request re-sends all of it. Costs grow roughly quadratically with session length, the model gets distracted by stale material, and eventually the window overflows.

DeepSeek Harness ships token-pressure compaction (`@deepseek-ai/dsh-compaction-basic`): when the window is nearly full, the *oldest* history is summarized into a checkpoint. That is a safety net, not a strategy:

- it fires late, after the expensive requests have already been paid for;
- it cuts by token count, not by meaning, so a summary can split a piece of work in half;
- it summarizes history that went stale long ago, often a summary of a previous summary.

## The idea

Let the model mark semantic units of work. When a unit is finished, fold exactly that unit into a short titled summary, written while the whole unit is still in context. Keep the originals in the log so nothing is lost and any detail can be recalled precisely.

This is the idea `yindf/taskfold` introduced. Its author's measurement on one 411-step session: total prompt tokens down 63.5% (142.7M → 52.1M), peak window use down from 59.5% to 20.7%. The number is a counterfactual estimate from a single session, not an A/B test, but the mechanism is sound.

## What taskfold got right (keep)

| Decision | Why it is right |
|---|---|
| No custom session event types; all state derived from the log | Matches DSH's first principle; fork/resume/replay stay correct. taskfold learned this the hard way: its v1 `task/mark` events made sessions unloadable after a host upgrade. |
| Lossless recall from `compaction/summary.data.shadowedSeqs` | Folds never delete events, so originals can be rebuilt exactly with `session.deriveEventMessage(session.eventAt(seq))`. |
| Numbered span index in the summarization request, `L<N>-<M>` citations in summaries | The model copies visible numbers instead of counting; makes recall addressable. |
| Prefix-anchored summarization request (surface prefix + span + instruction) | The request is a strict prefix of the main conversation, so the provider's KV cache is reused (~90% hit measured). Kept for the delegate fallback. |
| The summary title is constructed by code, not requested from the model | Models translate or paraphrase titles; construction makes them exact. |
| A fold floor (`minSpanTokens`, default 2000) | Spans under ~1000 tokens cost more to summarize than they save. The derivation in taskfold's `docs/fold-floor.md` is reusable. |
| A task-stack dock in the Web UI fed by the projection's `wire.view` | The canonical DSH way to show session-derived state. |

## What went wrong (fix)

Ranked by severity. File references are to `plugins/*.mjs` in taskfold v0.40.1.

### A. Architectural

1. **State lives in rendered result text.** The reducer recognizes `Task begun: ` / `Task ended: ` / legacy `Task folded: ` prefixes, splits the name at `' —'` (so names containing it are forbidden), and detects verdicts by marker phrases (`indexOf`, `endsWith`). Any wording change is a data-format change, results cannot be localized, and any plugin that rewrites tool output can corrupt the state machine. A live bug follows directly: `BELOW_FLOOR_MARKER` is matched with `indexOf` over a text that also contains the names of every still-open task, so a task named like the marker silently never folds (`task-marks.mjs:546`). DSH already provides the right channel — `output.presentationMeta` → `tool/result.data.meta` — and taskfold does not use it.
2. **Tasks are anchored on assistant messages.** A mark stores the seq of the message that carried `task_begin`; the region is computed as "from the node after the last result of the begin message to the last result of the end message". When the model naturally relays `task_end(A)` + `task_begin(B)` in one message, B's anchor lands inside A's span. Instead of fixing the model, taskfold rejects both calls and teaches a ritual: one task-mark call per message, the report must come in the *next* message, and that report must also carry a tool call or the turn ends. Two "parallel guards" in `deferredArchivePlan` and roughly 2,000 tokens of system prompt plus tool descriptions (8.1k characters, each rule stated up to three times) exist to support this.
3. **Folding subclasses an internal class.** `BasicCompactionEngine` and `BlockAssembler` are imported from a path found by walking ten levels of `node_modules` up from `process.argv[1]` and `cwd`; the engine is constructed on a hand-made shim context that bypasses the Cordis lifecycle; `schemastery` is loaded with `createRequire` from a fictitious anchor file. When resolution fails, the engine is cached as `null` for the process lifetime and every fold silently degrades to "closed without folding".

### B. High

4. **A dead global monkey-patch.** `taskfold.mjs:200-235` wraps `ctx.llm.stream` for the whole host to swap the built-in compaction instruction, matching `source.plugin === 'dsh-compaction-basic'` on the instruction message. In `dsh-compaction-basic` 0.2.0-rc.1, 0.2.2-rc.1 and 0.2.2-rc.5 that message has no `source` at all, so the swap never fires — while the wrapper still sits on every LLM call of every plugin.
5. **Folds block the agent.** The `agent/pre-step` listener awaits the fold (a full summarization LLM call, 30–70 s on dense spans per the author's own notes, 300 s timeout) before calling `next()`, so a mid-turn fold stalls the next step.
6. **Retry and give-up state is in memory only.** After a host restart, folds the plugin had given up on are retried and billed again. When the host rejects an unbalanced end boundary, the drain shrinks the region and may commit a fold that does not cover the close result; the row stays queued and the next attempt re-summarizes the summary it just produced.

### C. Medium

7. **Nested tasks produce summaries of summaries.** The prompt makes nesting mandatory, but an outer fold's region contains the inner summary nodes, and the fold instruction does not tell the summarizer so. The README claim "never a summary of a summary" does not hold for the recommended workflow.
8. **Full log rescans every step.** Each pre-step snapshots the whole log and runs several linear scans (plan per queued row, `terminalArchiveKeys` over every row including stuck ones, hint predicates, fold numbering). Synthetic benchmark with 20 queued rows: ~8 ms at 5k events, ~43 ms at 20k, ~200 ms at 80k.
9. **JSONL artifacts on disk.** Every fold and every full recall writes the span to a new file next to the session (or in `os.tmpdir()`) with `writeFileSync`. Files duplicate the log, are never cleaned up, survive session deletion, may contain secrets, and their absolute paths are baked into summaries forever.
10. **Unbounded summaries.** The instruction demands exhaustive sections, a `why:` clause on every bullet, and explicitly strips `maxTokens`. Each node also carries the host's checkpoint preamble (written for head-of-history compaction) and an 11-line index footer with a file path.
11. **Hints as persistent user messages.** Lifecycle hints are appended as `user/message`s and the prompt orders the model to treat them as directives. The "no open task during tool work" hint, together with "MANDATORY… when in doubt, treat the work as a task", pushes the model to wrap tiny actions that the floor then closes unfolded.

### D. Low

12. Legacy ballast (v1 `task/mark`, `task_fold`, `Task folded:`, three `tool/result` grammars); 42% of plugin lines are comments, mostly bug history; 40 releases in about seven weeks.

## What this means for the new design

The fixes for A1–A3 are not local. Moving data to `meta`, replacing anchors with cuts and moving to self-summary each change the projection, the planner and the tool contracts together. That is why this project is a rewrite rather than a fork. Everything listed under "keep" carries over.
