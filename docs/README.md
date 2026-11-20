# Documentation index

Read in order the first time; afterwards each document stands on its own.

| # | Document | What it answers |
|---|---|---|
| 01 | [Background](01-background.md) | What problem this solves, what taskfold got right and wrong, and what we keep |
| 02 | [Host API reference](02-host-api.md) | Every DeepSeek Harness API the plugin relies on, with source locations and verified signatures |
| 03 | [Architecture](03-architecture.md) | Concepts, data model, projection, fold planning and execution, recall, hints, UI, failure modes, invariants |
| 04 | [Tools and prompt](04-tools-and-prompt.md) | Exact tool schemas, rendered texts, `meta` payloads, the system-prompt section and the token budget |
| 05 | [Implementation plan](05-implementation-plan.md) | Repository layout, milestones, per-milestone tasks and acceptance criteria |
| 06 | [Testing and evaluation](06-testing.md) | Unit, property, contract and live tests; the evaluation protocol and metrics |
| 07 | [Open questions](07-open-questions.md) | Things that must be verified against a live host before or during implementation |
| — | [Architecture decision records](adr/) | One file per decision, with context, options and consequences |

## Vocabulary

| Term | Meaning |
|---|---|
| **Surface** | The ordered list of event seqs the model currently sees (`session.surface.nodes`). Compaction replaces ranges of it. |
| **Log** | The append-only session event log. Nothing is ever removed from it. |
| **Batch** | One `assistant/message` plus the `tool/result`s of every tool call it carries. |
| **Cut** | A boundary on the surface located right after the last node of a completed batch. Always tool-pairing balanced. |
| **Task** | A half-open surface interval `(beginCut, endCut]` opened by `task_begin` and closed by `task_end`. |
| **Fold** | Replacing a closed task's interval with one summary node via the host's compaction transaction. |
| **Self-summary** | The summary the model writes itself in the `summary` argument of `task_end`. |
| **Delegate** | Fallback: a separate summarization LLM call over the task's span. |
| **Verdict** | The durable decision about a closed task: `queued`, `below-floor`, `delegate`, `folded`, `absorbed`, `failed`. |
| **Recall** | Reading a fold's original messages back from the log by its `shadowedSeqs`. |

## Conventions

- The DeepSeek Harness revision referenced throughout is `deepseek-ai/deepseek-harness@2e39e704` (2026-11-18, packages at `0.2.2-rc.5`). Paths like `packages/core/session/src/types.ts` are relative to that repository.
- "taskfold" always means `yindf/taskfold` v0.40.1, the plugin this project replaces.
- MUST / SHOULD / MAY follow RFC 2119.
