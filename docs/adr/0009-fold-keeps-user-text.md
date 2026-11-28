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

Measuring the advisor's own feedback path then changed what that eighth node deserves — a quoted line
would return to its author as a fresh instruction — so plugin text is referenced rather than quoted
(§ Why plugin text is referenced, not quoted).

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

The pin is decided by these rules, applied in order:

- **Role gate.** Only `user/message` nodes are candidates. Assistant text, tool calls and tool results
  are never pinned — they are what the summary is for.
- **Principal gate.** Verbatim pinning applies to `source.kind: 'user'` — the human, the only author
  whose text cannot be regenerated and who does not re-read the transcript as a machine.
- **Everything else is referenced, not quoted.** A plugin-authored node (`advisor`, and every kind
  this plugin has never seen) becomes one reference line — kind, seq and the `fold_recall` pointer.
  Quoting it is a feedback loop; the measurement is below.
- **Re-injected kinds are dropped.** `compact-checkpoint` is denied because pinning a checkpoint into
  the next one recurses, and `agent-instructions`, `runtime-context`, `time-context`, `skill-catalog`
  and `dsh-mnemon` are re-injected every turn by the host or a memory plugin, so a frozen copy competes
  with the live one. These produce nothing at all.
- **Caps.** 2,000 characters per node and 4,000 per section, plus an adaptive
  `pinBudget = floor(spanTokens / 2) − nodeTokens` estimated with the plugin's estimator. The adaptive
  budget is what protects the economy rule: a folded node that is not smaller than its span is
  rejected, and a micro-span (200 tokens) with a long paste would otherwise stop folding entirely.
  When the budget falls below ~40 tokens the pin is replaced by a marker naming the kind and the
  length, never silently truncated.

The verbatim section quotes the principal, so it needs no origin tag: every line in it is `user`. The
reference section carries the origin kind instead:

```
## Folded inbound messages (references)
> [advisor:concern · seq 469] folded into this node; the text is in fold_recall({ task: "T5" })
```

Acceptance is a unit property, not an advisor end-to-end run: the verbatim section holds only
`source.kind: 'user'` text, and the reference section never holds a quote.

### Why plugin text is referenced, not quoted

Measured offline against the installed `dsh-advisor@0.7.4`, no model call:
`scripts/advisor-compat-probe.mjs` (`npm run probe:advisor`) drives the reviewer's own
`DeltaRenderer` and `EmissionGuard` over a synthetic fold transaction — the shape
`host/ports/compaction-shim.js` commits — and reads the delta back. It renders the same fold twice,
once with the note quoted and once referenced, which is what makes the first bullet below a
measurement rather than a reading of the source. Five checks, exit code 1 on any regression and 2 when
the advisor package is absent, so it stays runnable offline without becoming a build dependency.

- A fold is a rewrite. `transcript.js:72-77` treats any surface event with `surfaceOp !== 'append'` as
  a reset, so the reviewer's next delta is a **full replay** of the post-fold surface (bounded by
  `maxDeltaMessages`, default 60).
- That replay renders the checkpoint as one `**user**:` message: `transcript.js:151-160` joins the
  text blocks and prefixes the role only, with no source-kind annotation. A quoted
  `[advisor:concern] …` line therefore reaches the reviewer as user-role text, indistinguishable from
  an instruction the user just gave.
- The same rewrite clears the advisor's anti-repeat state: `index.js:670-672` `onRewrite` calls
  `delivery.reset(sessionId)` and `runtimes.get(sessionId)?.resetGuard()`, and `emission-guard.js`
  documents the dedupe history as swept by that reset ("a note already advised before the rewrite may
  legitimately be advised again"). The probe shows the same note suppressed before a reset and
  accepted after one.

An origin tag is prompt-level wording; it does not survive the mechanism above. Quoting a plugin's own
words back into the surface that plugin re-reads is a feedback loop, and this plugin's stated
constraint is not to disturb the plugins around it. A reference line keeps provenance and the recovery
path without re-feeding the text.

The same commit sanitises text in both directions, with two modes: `summary` strips a copied
`— fold of T<n> · …` trailer and a leading `# T<n> · …` heading from the model's summary; `pin` strips
only the trailer, because a user's own text may legitimately start with `# T1 · …` and stripping it
would break verbatim fidelity. A `<compacted-summary>` block inside either is replaced by a marker.

## Consequences

- A node is no longer a pure summary of the model's own discourse: it quotes inbound user lines. Its
  size is bounded by `summary + 4,000 characters + trailer`, independent of how many generations of
  folds precede it.
- The loss the plugin can still cause is bounded to plugin-authored text: the node names its kind and
  seq, and `fold_recall` still holds the wording. Nothing is silently dropped any more, but a plugin's
  sentence is no longer reproduced inside the checkpoint.
- For other plugins the transaction is unchanged: one `user/message` with
  `source.kind: 'compact-checkpoint'` and `surfaceOp: replace`. The plugin adds no event type and
  never writes a foreign `source.kind`. `dsh-advisor@0.7.4` re-reads the surface whenever
  `surfaceOp !== 'append'`, so a replace node is already the shape it expects — and, with the rule
  above, the replay never contains the advisor's own words.
- The observed corpus cost of the verbatim section is zero: no `source.kind: 'user'` node fell inside a
  region in that run, and the one advisor intervention becomes a ~60-character reference line. The
  worst case (+4,000 characters of a human paste) drops the tightest fold's margin from 7.6× to 3.6×,
  which still commits.
- Not settled by this record: whether a quoted pin is enough where the model needed the message as a
  real turn. The test that would settle it is a session whose later turn depends on the exact wording
  of a folded requirement — not on the work it produced.
- The delegate path was not exercised in the observed run (every verdict was `queued` or
  `below-floor`), so its node shape is verified by reading `generation.js:230-273` and by the
  fixtures `m5-delegate-fold.jsonl` and `e2e-headless-delegate.jsonl`, not by a corpus.
