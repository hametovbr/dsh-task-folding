# 0006 — Delegate summaries are generated in the background and committed like self-summaries

**Status:** Accepted (2026-11-20). Refines the delegate path of [03 §5.4](../03-architecture.md#54-delegate-fold-fallback-path); does not supersede an earlier ADR.

## Context

The original design ran delegate folds through `agent.runMaintenance()` scheduled from `agent/turn-stopping`. M0 (Q3) showed that a user message sent while a maintenance job runs is held until the job settles. A delegate summary takes 30–70 s on dense spans (taskfold's measurements), so the user's next turn could wait that long.

Running the summary inside the compaction engine instead (calling `compactRegion` in the background and letting `summarize()` call the LLM) would hold the durable compaction lock for the whole generation; the host's pressure compaction would then fail with `busy` exactly when it is needed.

## Options

1. `runMaintenance` (original) — blocks the next user message.
2. Background `compactRegion` with an LLM `summarize()` — holds the compaction lock for tens of seconds.
3. **Two-phase:** generate the summary in an un-awaited background promise with no lock; commit it at the next step boundary through the same fast, model-free adapter path as a self-summary, if the region is unchanged.

## Decision

Option 3.

## Consequences

- No step, user message or host compaction ever waits for a delegate summary; the commit costs the same milliseconds as a self fold.
- The plugin builds the summarization request itself instead of receiving the engine's summarization input: surface prefix (with the in-history system message), `tools` and `config` from the latest `request/header`, `toolHistory` ([07 Q12](../07-open-questions.md#q12)).
- A generation can be wasted if the region changes before commit (another compaction, a pruner). The runner checks the region key and regenerates later; at most one generation is in flight per session.
- A generated text is lost on restart; that costs at most one extra call per task per restart.
- Failures happen outside the engine, so the host does not record them. To keep the failure cap durable, each failed generation is recorded as a zero-cost failed compaction attempt ([07 Q11](../07-open-questions.md#q11)); if that proves impossible, the cap becomes per-process and ADR 0005 must say so.
