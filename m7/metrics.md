# Evaluation report

Sessions: 7 · configurations: A, B, C, D

## Method

- **Billed tokens** are sums over `assistant/message.data.usage` (main requests) and `compaction/summary.data.usage` (fold requests). The host counts are disjoint, so the cache-hit share is `cacheReadTokens / (cacheReadTokens + inputTokens)`.
- **Context size** is `cacheReadTokens + inputTokens` per main request. `request/header` in this host carries `config`, `adapterDefaults` and `tools` only, no token count; if a log did carry one it would win over the usage-derived size.
- **Folds, verdicts and task ids** come from replaying the log through `host/projection.js` (`apply` from `initialState`); a task verdict is its final `status`.
- A fold is **`self`** when its `compaction/summary` has no `data.usage` and **`delegate`** when it has one, the rule of `scripts/verify-cache.js`.
- **Span size** is `compaction/summary.data.shadowedTokenCount`, the host token meter. The **summary node size is an estimate**: the character count of the summary text divided by 4, because the token meter is unavailable offline.
- **Recall calls** are `tool/call` events named `fold_recall` (`grep` → grep, `from`/`to` → range), `fold_range` or `fold_grep`.
- A **reread** is a `read` tool result after the first fold whose path was read before that fold; paths are compared after trimming and dropping a leading `./`.
- **Rejected calls** are `tool/result` rows with `data.message.isError === true` for `task_begin`, `task_end` or `fold_recall`.
- **Steps and turns** count `step/start` and `turn/start`; **wall clock** is the latest minus the earliest `event.time`.
- The **first-request prompt** is the first main request's `cacheReadTokens + inputTokens`, because `request/header` has no token count.
- `n/a (why)` marks a metric the journal cannot support: no number is invented and no zero stands in for one.

## Configuration A — 2 sessions

Sessions: session.v4.jsonl, session.v4.jsonl

| Metric | Value | Source |
| --- | --- | --- |
| Billed · main requests | 13 requests · cache-read 161,024 · fresh input 25,683 · output 2,427 · total 189,134 · cache-hit 86.2% | assistant/message.data.usage (main requests) and compaction/summary.data.usage (fold requests); the host TokenUsage counts are disjoint, so cache-hit share = cacheReadTokens / (cacheReadTokens + inputTokens). Summed over the configuration's sessions. |
| Billed · fold requests | n/a (no session in this configuration recorded fold-request usage) | assistant/message.data.usage (main requests) and compaction/summary.data.usage (fold requests); the host TokenUsage counts are disjoint, so cache-hit share = cacheReadTokens / (cacheReadTokens + inputTokens). Summed over the configuration's sessions. |
| Context (main requests) | 23,060 peak · 14,362.1 mean over 13 main requests | assistant/message.data.usage: cacheReadTokens + inputTokens per main request (request/header in this host carries config, adapterDefaults and tools only, no token count). Peak over the configuration; mean weighted by main-request count. |
| Folds | 0 (self 0 · delegate 0) | host/projection.js apply() replay from initialState(): state.folds.length (one row per compaction/summary); verdicts: host/projection.js apply() replay from initialState(): state.tasks[*].status over state.order. Summed over the configuration's sessions. |
| Verdicts | no tasks | host/projection.js apply() replay from initialState(): state.tasks[*].status over state.order |
| Summary / span | n/a (no fold with a measurable span) | summaryEstimateTokens / shadowedTokens; charCount of the text blocks in compaction/summary.data.summary / 4 (estimate: the token meter is unavailable offline) |
| Recall calls | 0 (recall 0 · range 0 · grep 0) · n/a (no session in this configuration has a fold) | tool/call events named fold_recall, fold_range or fold_grep (an assistant/message tool-call block fills a missing call event; deduped by call id); fold_recall arguments: grep → grep, from/to → range, neither → recall; fold_range and fold_grep map by name; per fold: recall calls / folds count |
| Rereads after first fold | n/a (no session in this configuration has a fold, so there is no reread boundary) | read tool calls (data.name "read") paired to their tool/result (data.message.toolCallId): a result after the first compaction/summary whose path was read before it; the path is trimmed and a leading "./" stripped |
| Rejected task-tool calls | 0 | tool/result rows with data.message.isError === true whose call (tool/call data.name) is task_begin, task_end or fold_recall |
| Steps | 13 total · 6.5 median per session | count of step/start events |
| Turns | 2 total · 1 median per session | count of turn/start events |
| Wall clock | 59.7 s total · 29.8 s median | event.time: latest minus earliest (milliseconds since the epoch) |
| First-request prompt | 10,066 tokens · median over 2 sessions | first assistant/message.data.usage: cacheReadTokens + inputTokens (request/header has no token count in this host). Median over the configuration's sessions. |

No folds in this configuration.

## Configuration B — 2 sessions

Sessions: session.v4.jsonl, session.v4.jsonl

| Metric | Value | Source |
| --- | --- | --- |
| Billed · main requests | 15 requests · cache-read 212,096 · fresh input 30,746 · output 2,570 · total 245,412 · cache-hit 87.3% | assistant/message.data.usage (main requests) and compaction/summary.data.usage (fold requests); the host TokenUsage counts are disjoint, so cache-hit share = cacheReadTokens / (cacheReadTokens + inputTokens). Summed over the configuration's sessions. |
| Billed · fold requests | 1 request · cache-read 25,216 · fresh input 2,004 · output 733 · total 27,953 · cache-hit 92.6% | assistant/message.data.usage (main requests) and compaction/summary.data.usage (fold requests); the host TokenUsage counts are disjoint, so cache-hit share = cacheReadTokens / (cacheReadTokens + inputTokens). Summed over the configuration's sessions. |
| Context (main requests) | 25,246 peak · 16,189.5 mean over 15 main requests | assistant/message.data.usage: cacheReadTokens + inputTokens per main request (request/header in this host carries config, adapterDefaults and tools only, no token count). Peak over the configuration; mean weighted by main-request count. |
| Folds | 1 (self 0 · delegate 1) | host/projection.js apply() replay from initialState(): state.folds.length (one row per compaction/summary); verdicts: host/projection.js apply() replay from initialState(): state.tasks[*].status over state.order. Summed over the configuration's sessions. |
| Verdicts | no tasks | host/projection.js apply() replay from initialState(): state.tasks[*].status over state.order |
| Summary / span | 8.6% mean over 1 fold | summaryEstimateTokens / shadowedTokens; charCount of the text blocks in compaction/summary.data.summary / 4 (estimate: the token meter is unavailable offline) |
| Recall calls | 0 (recall 0 · range 0 · grep 0) · 0 per fold | tool/call events named fold_recall, fold_range or fold_grep (an assistant/message tool-call block fills a missing call event; deduped by call id); fold_recall arguments: grep → grep, from/to → range, neither → recall; fold_range and fold_grep map by name; per fold: recall calls / folds count |
| Rereads after first fold | 0 read results after the first fold | read tool calls (data.name "read") paired to their tool/result (data.message.toolCallId): a result after the first compaction/summary whose path was read before it; the path is trimmed and a leading "./" stripped. Summed over the configuration's sessions. |
| Rejected task-tool calls | 0 | tool/result rows with data.message.isError === true whose call (tool/call data.name) is task_begin, task_end or fold_recall |
| Steps | 15 total · 7.5 median per session | count of step/start events |
| Turns | 2 total · 1 median per session | count of turn/start events |
| Wall clock | 1.2 min total · 35.2 s median | event.time: latest minus earliest (milliseconds since the epoch) |
| First-request prompt | 12,238.5 tokens · median over 2 sessions | first assistant/message.data.usage: cacheReadTokens + inputTokens (request/header has no token count in this host). Median over the configuration's sessions. |

### Folds

| Session | Fold seq | Kind | Task | Span tokens | Summary est. tokens | Ratio |
| --- | --- | --- | --- | --- | --- | --- |
| session.v4.jsonl | 65 | delegate | — | 13,524 | 1,161.5 | 8.6% |

## Configuration C — 2 sessions

Sessions: session.v4.jsonl, session.v4.jsonl

| Metric | Value | Source |
| --- | --- | --- |
| Billed · main requests | 21 requests · cache-read 273,280 · fresh input 30,780 · output 3,888 · total 307,948 · cache-hit 89.9% | assistant/message.data.usage (main requests) and compaction/summary.data.usage (fold requests); the host TokenUsage counts are disjoint, so cache-hit share = cacheReadTokens / (cacheReadTokens + inputTokens). Summed over the configuration's sessions. |
| Billed · fold requests | n/a (no session in this configuration recorded fold-request usage) | assistant/message.data.usage (main requests) and compaction/summary.data.usage (fold requests); the host TokenUsage counts are disjoint, so cache-hit share = cacheReadTokens / (cacheReadTokens + inputTokens). Summed over the configuration's sessions. |
| Context (main requests) | 23,858 peak · 14,479.0 mean over 21 main requests | assistant/message.data.usage: cacheReadTokens + inputTokens per main request (request/header in this host carries config, adapterDefaults and tools only, no token count). Peak over the configuration; mean weighted by main-request count. |
| Folds | 1 (self 1 · delegate 0) | host/projection.js apply() replay from initialState(): state.folds.length (one row per compaction/summary); verdicts: host/projection.js apply() replay from initialState(): state.tasks[*].status over state.order. Summed over the configuration's sessions. |
| Verdicts | folded 1 · below-floor 3 | host/projection.js apply() replay from initialState(): state.tasks[*].status over state.order |
| Summary / span | 1.9% mean over 1 fold | summaryEstimateTokens / shadowedTokens; charCount of the text blocks in compaction/summary.data.summary / 4 (estimate: the token meter is unavailable offline) |
| Recall calls | 0 (recall 0 · range 0 · grep 0) · 0 per fold | tool/call events named fold_recall, fold_range or fold_grep (an assistant/message tool-call block fills a missing call event; deduped by call id); fold_recall arguments: grep → grep, from/to → range, neither → recall; fold_range and fold_grep map by name; per fold: recall calls / folds count |
| Rereads after first fold | 0 read results after the first fold | read tool calls (data.name "read") paired to their tool/result (data.message.toolCallId): a result after the first compaction/summary whose path was read before it; the path is trimmed and a leading "./" stripped. Summed over the configuration's sessions. |
| Rejected task-tool calls | 0 | tool/result rows with data.message.isError === true whose call (tool/call data.name) is task_begin, task_end or fold_recall |
| Steps | 21 total · 10.5 median per session | count of step/start events |
| Turns | 2 total · 1 median per session | count of turn/start events |
| Wall clock | 1.3 min total · 40.1 s median | event.time: latest minus earliest (milliseconds since the epoch) |
| First-request prompt | 10,726 tokens · median over 2 sessions | first assistant/message.data.usage: cacheReadTokens + inputTokens (request/header has no token count in this host). Median over the configuration's sessions. |

### Folds

| Session | Fold seq | Kind | Task | Span tokens | Summary est. tokens | Ratio |
| --- | --- | --- | --- | --- | --- | --- |
| session.v4.jsonl | 68 | self | T1 | 13,759 | 266.8 | 1.9% |

## Configuration D — 1 session

Sessions: session.v4.jsonl

| Metric | Value | Source |
| --- | --- | --- |
| Billed · main requests | 12 requests · cache-read 197,376 · fresh input 21,175 · output 1,414 · total 219,965 · cache-hit 90.3% | assistant/message.data.usage (main requests) and compaction/summary.data.usage (fold requests); the host TokenUsage counts are disjoint, so cache-hit share = cacheReadTokens / (cacheReadTokens + inputTokens). Summed over the configuration's sessions. |
| Billed · fold requests | 1 request · cache-read 23,552 · fresh input 210 · output 393 · total 24,155 · cache-hit 99.1% | assistant/message.data.usage (main requests) and compaction/summary.data.usage (fold requests); the host TokenUsage counts are disjoint, so cache-hit share = cacheReadTokens / (cacheReadTokens + inputTokens). Summed over the configuration's sessions. |
| Context (main requests) | 23,629 peak · 18,212.6 mean over 12 main requests | assistant/message.data.usage: cacheReadTokens + inputTokens per main request (request/header in this host carries config, adapterDefaults and tools only, no token count). Peak over the configuration; mean weighted by main-request count. |
| Folds | 1 (self 0 · delegate 1) | host/projection.js apply() replay from initialState(): state.folds.length (one row per compaction/summary); verdicts: host/projection.js apply() replay from initialState(): state.tasks[*].status over state.order. Summed over the configuration's sessions. |
| Verdicts | folded 1 | host/projection.js apply() replay from initialState(): state.tasks[*].status over state.order |
| Summary / span | 2.8% mean over 1 fold | summaryEstimateTokens / shadowedTokens; charCount of the text blocks in compaction/summary.data.summary / 4 (estimate: the token meter is unavailable offline) |
| Recall calls | 0 (recall 0 · range 0 · grep 0) · 0 per fold | tool/call events named fold_recall, fold_range or fold_grep (an assistant/message tool-call block fills a missing call event; deduped by call id); fold_recall arguments: grep → grep, from/to → range, neither → recall; fold_range and fold_grep map by name; per fold: recall calls / folds count |
| Rereads after first fold | 0 read results after the first fold | read tool calls (data.name "read") paired to their tool/result (data.message.toolCallId): a result after the first compaction/summary whose path was read before it; the path is trimmed and a leading "./" stripped. Summed over the configuration's sessions. |
| Rejected task-tool calls | 0 | tool/result rows with data.message.isError === true whose call (tool/call data.name) is task_begin, task_end or fold_recall |
| Steps | 12 | count of step/start events |
| Turns | 3 | count of turn/start events |
| Wall clock | 2.5 min | event.time: latest minus earliest (milliseconds since the epoch) |
| First-request prompt | 10,841 tokens | first assistant/message.data.usage: cacheReadTokens + inputTokens (request/header has no token count in this host). Median over the configuration's sessions. |

### Folds

| Session | Fold seq | Kind | Task | Span tokens | Summary est. tokens | Ratio |
| --- | --- | --- | --- | --- | --- | --- |
| session.v4.jsonl | 98 | delegate | T1 | 13,088 | 367.5 | 2.8% |

## Aggregate

| Configuration | Sessions | Main requests | Main total tokens | Main cache-hit | Fold requests | Fold total tokens | Folds (self/delegate) | Recall calls | Rereads | Rejected | Steps | Wall clock |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 2 | 13 | 189,134 | 86.2% | n/a | n/a | 0 (0/0) | 0 | n/a | 0 | 13 | 59.7 s |
| B | 2 | 15 | 245,412 | 87.3% | 1 | 27,953 | 1 (0/1) | 0 | 0 | 0 | 15 | 1.2 min |
| C | 2 | 21 | 307,948 | 89.9% | n/a | n/a | 1 (1/0) | 0 | 0 | 0 | 21 | 1.3 min |
| D | 1 | 12 | 219,965 | 90.3% | 1 | 24,155 | 1 (0/1) | 0 | 0 | 0 | 12 | 2.5 min |
