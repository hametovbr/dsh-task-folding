# 0003 — The model writes the summary in `task_end`

**Status:** Accepted (2026-11-20); quality to be validated in M7.

## Context

taskfold summarizes every fold with a separate LLM call that replays the whole surface prefix plus the span plus a long instruction. Even with ~90% cache hits, its author's session paid 3.55M tokens for 26 summaries (~136k per fold), mostly re-reading context. The call takes 30–70 s on dense spans and ran on the agent's critical path.

At the moment `task_end` is called, the main model already has the whole span in context and is generating anyway.

## Options

1. Delegate every fold (taskfold).
2. **Self-summary:** a required `summary` argument on `task_end`; the fold is a model-free replacement. Delegate only when the summary is missing, too short, or too large for the span.
3. Self-summary only, no fallback.

## Decision

Option 2.

## Consequences

- Cost per fold drops to the summary's output tokens, which the delegate path pays too; the re-read of the context disappears.
- Fold latency drops to milliseconds, so folds can run in `pre-step` without stalling the agent.
- The summary text lives in the `task_end` call arguments in the log, inside the span — no duplication, fully replayable.
- Quality risk: the main model writes a summary under a short parameter description instead of a long dedicated instruction. Mitigations: a section template in the parameter description, length validation with fallback, and the M7 comparison against an all-delegate configuration.
- The summary cannot cite span line numbers (the model sees no index while writing it). Recall relies on the index and `grep` in `fold_recall` instead.
