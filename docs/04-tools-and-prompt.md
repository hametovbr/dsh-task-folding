# 04 — Tools and prompt

Everything the model sees from this plugin. Texts here are the starting point for implementation; changes must keep the budget in section 4 and follow DSH's tool-design guidance (`references/tool-design.md`): describe behavior, put parameter rules on parameters, say each fact once.

## 1. Tool schemas

### `task_begin`

```json
{
  "name": "task_begin",
  "description": "Open a task: a unit of work with a verifiable outcome (a fix, a feature, an investigation, a review). When it ends, task_end replaces its messages with your summary. Tasks nest: a task_begin while a task is open opens a subtask. Returns the task id.",
  "parameters": {
    "type": "object",
    "properties": {
      "title": { "type": "string", "description": "Short title, one line, at most 80 characters." }
    },
    "required": ["title"]
  }
}
```

Output value (validated by `output.schema`):

```json
{ "ok": true, "id": "T7", "title": "Fix login redirect loop", "parent": "T6", "depth": 2 }
```

Rendered text: `Task T7 opened (inside T6).` / `Task T7 opened.`

Errors (rendered as `task_begin failed: …`, no meta):

- `title` empty after normalization (whitespace collapsed, newlines removed, trimmed, capped at 120 characters);
- called from `run_code`.

### `task_end`

```json
{
  "name": "task_end",
  "description": "Close a task. Its messages since task_begin are replaced by your summary, so write the summary for yourself later: someone continuing this work with only the summary in view. The originals stay retrievable with fold_recall. Closing a task also closes its open subtasks.",
  "parameters": {
    "type": "object",
    "properties": {
      "summary": {
        "type": "string",
        "description": "Markdown. Sections, omitting empty ones: ## Done (what was done and why this way), ## Decisions (user requests and corrections, verbatim when wording matters), ## Changed (exact file paths, identifiers, values), ## Pitfalls (what failed and why), ## Outcome. Keep it to about a tenth of the work it replaces."
      },
      "id": { "type": "string", "description": "Task id to close. Default: the innermost open task." },
      "outcome": { "type": "string", "enum": ["done", "failed", "abandoned"], "description": "Default: done." }
    },
    "required": ["summary"]
  }
}
```

Output value:

```json
{ "ok": true, "id": "T7", "verdict": "queued", "merged": [], "remaining": ["T6"] }
```

The value also carries `estTokens`, `summaryChars`, `outcome` and `callId`: `presentationMeta` copies them into the meta (it receives only the arguments and the value, and `callId` is known only inside `execute`), while `render` shows none of them.

Rendered text by verdict:

| Verdict | Text |
|---|---|
| `queued` | `Task T7 closed; it will be folded into your summary. Open: T6.` |
| `delegate` | `Task T7 closed; the summary was too short or too long for this span, so it will be summarized automatically. Open: T6.` |
| `below-floor` | `Task T7 closed; it is small, so its messages stay as they are. Open: T6.` |
| `absorbed` | `Task T7 closed; its beginning was already compacted, so it gets no separate fold. Open: T6.` |

`Open: …` becomes `No open tasks.` when the stack is empty. When `merged` is non-empty, append ` Subtasks closed with it: T8, T9.`

Errors: no open task; unknown `id` (list the open ids); called from `run_code`.

### `fold_recall`

```json
{
  "name": "fold_recall",
  "description": "Read folded work back from the session log. Without arguments: the list of folds. With task or fold: that fold's message index (one line per message). Add from/to for the exact original messages, or grep to search them.",
  "parameters": {
    "type": "object",
    "properties": {
      "task": { "type": "string", "description": "Task id, e.g. T7." },
      "fold": { "type": "integer", "description": "Fold number from the list; also covers automatic compactions." },
      "from": { "type": "integer", "description": "First message line, 1-based. With to: at most 20 lines." },
      "to": { "type": "integer", "description": "Last message line, inclusive." },
      "grep": { "type": "string", "description": "Case-insensitive text, or /regex/, to find in the fold's messages." },
      "page": { "type": "integer", "description": "Index page, 1-based, 200 lines each. Default 1." }
    }
  }
}
```

Rendered shapes:

```
Folds (4):
#1 T2 · Set up test fixtures · 31 msgs · ~9.8k tokens
#2 auto compaction · 112 msgs · ~61k tokens
#4 T6 · Review PR #98 · 18 msgs · ~7.1k tokens
   #3 T5 · Reproduce the loop · 12 msgs · ~4.2k tokens
```

```
Fold #3 · T6 · Review PR #98 · 18 messages
L1 assistant: read src/auth/redirect.ts
L2 tool read: 214 lines
L3 assistant: [fold #1 T5 "Reproduce the loop"]
…
```

```
Fold #3 lines 2-3:
L2 {"role":"tool", …exact message JSON…}
L3 …
```

```
Fold #3 grep "redirect_uri" (4 hits):
L2: …const redirect_uri = buildRedirect(…
…
```

Output caps: index 200 lines per page; range 20 messages and ~40k characters total, with `[truncated: narrow from/to]` when cut; grep 50 hits, 200 characters of context each.

## 2. `meta` payloads

Defined in [03 §4.1](03-architecture.md#41-meta-payloads-durable-written-by-the-tools). `fold_recall` writes no meta.

## 3. System-prompt section

`ctx.systemPrompt.section({ name: 'task-folding', order: 650, text })`. Draft:

```
Task folding. Wrap each unit of work that has a verifiable outcome in task_begin … task_end. A single lookup is a step, not a task. When a unit has distinct parts, open a subtask for each part. task_end replaces the task's messages with your summary, so close a task as soon as its outcome is clear and put in the summary everything you will still need: decisions, changed paths and values, failures and their causes. Report to the user as usual; the report may come before or after task_end. When a summary does not answer a concrete question, read the originals with fold_recall instead of guessing.
```

## 4. Token budget

| Part | Characters (draft) | Budget |
|---|---|---|
| Prompt section | 601 | ≤ 800 |
| `task_begin` schema (compact JSON) | 442 | ≤ 500 |
| `task_end` schema | 914 | ≤ 1,100 |
| `fold_recall` schema | 833 | ≤ 1,000 |
| **Total** | **2,790 (≈ 700 tokens)** | **≤ 3,400 characters** |

For comparison, taskfold 0.40.1 spends ~8,100 characters (≈ 2,000 tokens) on the same surface. The prompt section plus the two lifecycle tools come to ~1,960 characters (≈ 490 tokens). `fold_recall` is a candidate for `deferLoading: true` once its first-use latency is measured ([07 Q6](07-open-questions.md#q6)). A unit test (`test/prompt-budget.test.js`) fails when the total exceeds the budget.

## 5. Hint text

```
Task T7 "Fix login redirect loop" has been open for 25+ steps. If it is finished, call task_end with a summary; if it has distinct parts, wrap the remaining parts in nested tasks.
```

Buckets: 25+, 50+, 100+. Delivered as a `user/message` with `source: { kind: 'task-folding:hint', key: 'T7:25' }`.

## 6. Fold node text

```
# T7 · Fix login redirect loop
<summary>

— fold of T7 · 42 messages · ~18.4k tokens · outcome: done · originals: fold_recall({ task: "T7" })
```

The host wraps it in its checkpoint preamble and `<compacted-summary>` tags (not controllable without an upstream change; see [07 Q5](07-open-questions.md#q5)).
