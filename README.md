# dsh-task-folding

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): the agent wraps its work in named tasks, and every finished task is folded into a short summary. The original messages stay in the session log and can be brought back on demand with `fold_recall`.

> **Status:** milestones M0–M3 are done on DSH 0.2.2-rc.5: the plugin installs, opens and closes tasks, and folds a finished task into the summary the model wrote (no LLM call), with the originals kept in the log. Recall works too (M4): `fold_recall` lists folds, pages through a fold's message index, and returns the exact original messages or greps them. The delegate fallback is next (M5); see [docs/08-followups.md](docs/08-followups.md) for what comes after.

## Why another plugin

The idea was first implemented by [yindf/taskfold](https://github.com/yindf/taskfold). A review of its v0.40.1 showed that the concept works, but the implementation is built on three decisions that keep generating bugs:

- state is reconstructed by parsing the English text of tool results;
- task boundaries are anchored on whole assistant messages;
- folding is done by subclassing an internal host class located by walking `node_modules`.

Details: [docs/01-background.md](docs/01-background.md).

This project keeps the concept and replaces the foundation:

| | taskfold 0.40.1 | dsh-task-folding |
|---|---|---|
| Source of state | rendered result text (`'Task ended: '…`) | `tool/result.meta` + a session projection |
| Boundaries | anchor on an assistant message; "one task-mark call per message" rules | cuts between completed call batches; no message rules |
| Who writes the summary | a separate LLM call per fold | the model itself, in `task_end`; an LLM call only as a fallback |
| Fold latency | blocks the next agent step for the duration of an LLM call | milliseconds (model-free replacement) |
| Recall | JSONL files on disk + the log | the log only |
| Tools / prompt | 4 tools, ~2k tokens per request | 3 tools, ~730 tokens |

## Documentation

- [HANDOFF.md](HANDOFF.md) — current state and the next milestone, for whoever continues the work
- [docs/README.md](docs/README.md) — index and reading order
- [docs/03-architecture.md](docs/03-architecture.md) — architecture
- [docs/05-implementation-plan.md](docs/05-implementation-plan.md) — staged implementation plan

## License

MIT — see [LICENSE](LICENSE).
