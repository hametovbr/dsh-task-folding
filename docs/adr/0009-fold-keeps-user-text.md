# 0009 — A fold node keeps the inbound user text of its region

**Status:** Proposed (2026-11-28). Extends [0003](0003-self-summary.md) and
[0006](0006-background-delegate.md): it fixes what a committed node must contain, not how the summary
is written.

## Context

A fold replaces a region with one checkpoint node carrying the model's summary. Everything the model
itself wrote — its reasoning, its tool calls and their results — is re-derivable by continuing the
work. Inbound user text is not: once folded, it exists nowhere else in the session.

A live run measured the gap. In 8 folds of a homelab session, 8 inbound `user/message` nodes fell
inside a region. Seven were kinds the host re-injects every turn (`agent-instructions` × 6,
`time-context` × 1), so folding them loses nothing. The eighth was an advisor intervention
(386 characters) that arrived mid-turn while the task was open, and was folded into that task's
checkpoint. Its text is absent from the summary — no verbatim marker survives — and `fold_recall`
was not called once in 8 folds, so the recovery path the trailer points at was never used.

Two more facts shape the fix.

- The node form is produced in one place (`host/runtime/scheduler.js:336`, `renderFoldNode`), but a
  node is committed by three paths: self (`scheduler.js`), delegate (`generation.js:259`) and the
  implicit turn fold (`generation.js:505`, `blocks: job.blocks ?? []`). A fix at the self path alone
  would leave two of three paths unchanged.
- The model can copy the plugin's own trailer into its summary: 2 of 3 folds in the authoring session
  produced a node with two `— fold of T<n>` trailers and two `fold_recall` pointers, one of them
  naming metrics that belong to no fold. The projection never parses the text, so nothing breaks —
  the cost is a misleading node.

## Options

1. Never fold a region that contains an inbound user message: split the region into two, or re-anchor
   `spanStart` past the message. The host allows it — `compactRegion` takes one contiguous range and
   the busy lock is released on `compaction/end`, so two transactions in one step are legal — but the
   price lands in this plugin: `foldIndex` is a scalar and `status: 'folded'` is terminal
   (`projection.js:264`, `:281`), so "folded in two checkpoints" needs new state; `coversSpan`
   (`:468`) requires exact equality of `spanStart`/`endCut`, so a split node loses attribution and the
   predicate has to change too; `fold_recall({ task })` would have to gather two nodes; and
   `region.ts` rejects a summary that is not smaller than its span, which the tail of a split region
   can easily be. Re-anchoring alone only defers the loss: the message lands in the next region.
2. **Pin the verbatim text of every inbound user message into the node**, in one function at the
   three commit sites.
3. Keep folding as it is and rely on `fold_recall`.

## Decision

Option 2. `finalizeFoldBlocks(blocks, ctx)` becomes the single producer of node form and runs at all
three commit sites; `renderFoldNode` keeps rendering the self-path header and trailer, and gains the
pinned section as an argument.

The pin is decided by three rules, in this order:

- **Role gate.** Only `user/message` nodes are candidates. Assistant text, tool calls and tool results
  are never pinned — they are what the summary is for.
- **Kind deny-list, default keep.** `compact-checkpoint` is denied because pinning a checkpoint into
  the next one recurses; `agent-instructions`, `runtime-context`, `time-context`, `skill-catalog` and
  `dsh-mnemon` are denied because the host or a memory plugin re-injects them every turn, and a frozen
  copy competes with the live one. Every other kind — including kinds this plugin has never seen — is
  pinned. The list is extended by an explicit change, never by a heuristic.
- **Caps.** 2,000 characters per node and 4,000 per section, plus an adaptive
  `pinBudget = floor(spanTokens / 2) − nodeTokens` estimated with the plugin's estimator. The adaptive
  budget is what protects the economy rule: a folded node that is not smaller than its span is
  rejected, and a micro-span (200 tokens) with a long paste would otherwise stop folding entirely.
  When the budget falls below ~40 tokens the pin is replaced by a marker naming the kind and the
  length, never silently truncated.

Each pinned line carries its origin kind (`> [advisor:concern] …`) because the checkpoint arrives as
`source.kind: 'compact-checkpoint'`, and a plugin that filters advisor messages by kind cannot tell a
quoted intervention from noise.

The same commit sanitises text in both directions, with two modes: `summary` strips a copied
`— fold of T<n> · …` trailer and a leading `# T<n> · …` heading from the model's summary; `pin` strips
only the trailer, because a user's own text may legitimately start with `# T1 · …` and stripping it
would break verbatim fidelity. A `<compacted-summary>` block inside either is replaced by a marker.

## Consequences

- A node is no longer a pure summary of the model's own discourse: it quotes inbound user lines. Its
  size is bounded by `summary + 4,000 characters + trailer`, independent of how many generations of
  folds precede it.
- The loss the plugin can still cause is bounded to non-verbatim kinds, and each fold states in the
  node what it kept.
- For other plugins the transaction is unchanged: one `user/message` with
  `source.kind: 'compact-checkpoint'` and `surfaceOp: replace`. The plugin adds no event type and
  never writes a foreign `source.kind`. `dsh-advisor@0.7.4` re-reads the surface whenever
  `surfaceOp !== 'append'`, so a replace node is already the shape it expects.
- The observed corpus cost is one pinned message (+386 characters on a fold of ~17.5k summary
  characters); the worst case (+4,000) drops the tightest fold's margin from 7.6× to 3.6×, which
  still commits.
- Not settled by this record: whether a quoted pin is enough where the model needed the message as a
  real turn. The test that would settle it is a session whose later turn depends on the exact wording
  of a folded requirement — not on the work it produced.
- The delegate path was not exercised in the observed run (every verdict was `queued` or
  `below-floor`), so its node shape is verified by reading `generation.js:230-273` and by the
  fixtures `m5-delegate-fold.jsonl` and `e2e-headless-delegate.jsonl`, not by a corpus.
