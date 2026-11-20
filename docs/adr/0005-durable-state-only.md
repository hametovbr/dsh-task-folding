# 0005 — All load-bearing state is durable: `meta` plus a projection

**Status:** Accepted (2026-11-20)

## Context

DSH's first plugin principle: the session log is the only source of truth; plugin memory is a derived cache. Plugins cannot append custom event types (sessions refuse to reopen), and `appendPluginRecord()` is reserved for DSH's experimental packages. taskfold kept give-up decisions, retry counters and "settled" rows in process memory; after a restart it re-billed folds it had given up on, and it needed a view-pruning layer and a settle-aware reducer wrapper to hide rows that would never fold.

## Decision

- The tools write every decision into `tool/result.data.meta` via `output.presentationMeta`. Model-facing text never carries data.
- One projection derives all state from native events plus `meta`, incrementally, as plain JSON with a `stateVersion`.
- Facts the plugin cannot write itself are derived from host events: fold completion from the replacement event and the fold heading, delegate failures from `compaction/end{error}`, the hint latch from our hint messages' `source`.
- In-memory state is allowed only as an optimization or for within-process backoff: id reservation inside a batch, self-fold retry backoff, position caches. Losing it on restart must not change any verdict or cause a billed call.

## Consequences

- Restart, resume and fork need no special handling.
- The delegate failure cap counts all compaction failures while a task waits, not only its own (no durable link from a failure to a task). This over-counts in the safe direction.
- The reducer is pure and fully testable offline, including replay equivalence from checkpoints.
