# 0002 — Task boundaries are cuts after completed call batches

**Status:** Accepted (2026-11-20)

## Context

The host's `compactRegion` requires a range whose both edges are tool-pairing balanced. taskfold anchored a task on the seq of the assistant message carrying `task_begin` and derived the region from message positions. That made `task_end(A)` + `task_begin(B)` in one message put B's anchor inside A's span, which taskfold "fixed" by rejecting such messages and teaching the model message-shape rules, plus two special-case guards for partner calls.

## Options

1. Keep message anchors; enforce shapes with `tools/pre-execute` instead of execute-time rejection.
2. Anchor on the `task_begin` result event.
3. **Cuts:** a boundary is the position after the last node of a completed batch (assistant message + all its results). A task is `(beginCut, endCut]`. When a replacement shadows the node a cut points at, the cut moves to after the replacement if that node was the last shadowed one, otherwise the task is absorbed.

## Decision

Option 3.

## Consequences

- Both edges of every region are balanced by construction; the parallel-begin and parallel-end guards disappear.
- A relay batch makes `endCut(A) == beginCut(B)`; any combination of calls in one message is allowed.
- The begin message (with its opening reasoning) stays on the surface as a bookmark; the closing batch is inside the span.
- Cut translation must observe every surface replacement, including ones made by other plugins (pruners). It relies on the `sourceEventSeqs` contract ([07 Q8](../07-open-questions.md#q8)).
- The projection tracks the in-flight batch, which requires seeing every result of a batch that carries a task call — including error results synthesized by session repair.
