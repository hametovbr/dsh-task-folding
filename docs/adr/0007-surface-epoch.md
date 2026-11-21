# 0007 — The surface has an epoch, and regions are compared by it

**Status:** Accepted (2026-11-21). Supersedes the `regionKey` string of the M5 delegate fold.

## Context

A fold is decided against a surface — the ordered list of session nodes — and committed later, in a
host transaction that replaces the span. Two observations made the original design wrong:

1. The first delegate fold identified its region with a string `${start}:${end}:${startIndex}:${endIndex}:${nodes.length}`.
   The model keeps appending messages while the summary is generated, so the length changed on almost
   every boundary and every generated summary was discarded (M5).
2. The fold runner read the projection once at the start of a pass. `startDelegate` is the pass's only
   suspension point, so a competing compaction could replace a node while the generation started; the
   due list then resolved against a surface that had moved, the region came back `inconsistent`, and
   the runner marked the task **unfoldable for the whole process**. The T4 suite found this (F9) and
   pinned it as a defect.

A string rebuilt from positions cannot express "the region is unchanged"; and a skip stored without a
version cannot say what it was a statement about.

## Options

1. **Rebuild the key from the region's seqs** and re-read the state before every resolution. Fixes the
   length bug, not the race: a skip decided on an old state still outlives it.
2. **Give the surface a version.** The projection increments `State.surfaceEpoch` on every
   `surfaceOp.replace` (and only then — appending a node changes no existing node). A generation is
   bound to the epoch it started at; a commit compares epochs; a skip records the epoch it was decided
   at and stops applying when the epoch moves.
3. Re-read the state after every await and never store skips. Simpler, but leaves "commit against a
   moved surface" as a thing the code must remember to check, not a thing that cannot compare equal.

## Decision

Option 2. `State.surfaceEpoch` is part of the projection; the runner reads a `Snapshot { state, nodes,
epoch }` in one go, resolves regions against it, binds every generation and every skip to its epoch,
and re-reads the snapshot after the pass's suspension point.

## Consequences

- A commit compares epochs, so "the surface moved" is a normal transition (`stale`) rather than a race
  to be remembered; a skip is a statement about a version, not about a session.
- `regionKey` stays as a value the summarizer echoes, but the runner no longer trusts it: the region is
  a pair of seqs inside a snapshot, and the seqs are what the host transaction replaces.
- An appending model no longer discards its own generated summary, which was the M5 defect.
- The property suite pins the invariant: appends leave the epoch alone, each replacement moves it once.
- Checkpoints written before the field existed still replay: the reducer defaults it to zero and
  `parseState` accepts a missing epoch.

Acceptance lives in `test/f9-surface-epoch.test.js`: a replacement that lands while a pass runs must
not cost the task its later folds.
