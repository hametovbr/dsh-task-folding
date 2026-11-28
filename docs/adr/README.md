# Architecture decision records

| # | Decision | Status |
|---|---|---|
| [0001](0001-rewrite-not-fork.md) | Write a new plugin instead of forking taskfold | Accepted |
| [0002](0002-cuts-not-anchors.md) | Task boundaries are cuts after completed call batches | Accepted |
| [0003](0003-self-summary.md) | The model writes the summary in `task_end`; a summarizer call is only a fallback | Accepted, to be validated in M7 |
| [0004](0004-engine-adapter.md) | Fold through one isolated adapter over `BasicCompactionEngine`; propose an upstream API | Accepted (interim) |
| [0005](0005-durable-state-only.md) | All plugin state lives in `meta` and a projection; no in-memory state is load-bearing | Accepted |
| [0006](0006-background-delegate.md) | Delegate summaries are generated in the background and committed like self-summaries | Accepted |
| [0007](0007-surface-epoch.md) | The surface has an epoch; regions and skips are compared by it | Accepted |
| [0008](0008-host-ports.md) | The host is reached through ports, and the compaction shim is one of them | Accepted |
| [0009](0009-fold-keeps-user-text.md) | A fold node keeps the inbound user text of its region | Accepted |

Template for new records: Context → Options → Decision → Consequences. Never edit an accepted record's decision; supersede it with a new record.
