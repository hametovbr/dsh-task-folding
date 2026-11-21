# dsh-task-folding

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): the agent wraps
its work in named tasks, and every finished task is folded into a short summary. The original messages
stay in the session log and can be brought back on demand with `fold_recall`.

- **Two tools** open and close a unit of work. The model writes the summary itself in `task_end`, so a
  fold costs no LLM call and does not delay the next step; an LLM-generated summary is a fallback for
  tasks the model closed without a usable one.
- **State comes from the log**, not from the text of tool results: a session projection reads
  `tool/result.data.meta` plus the host's own lifecycle events, so a restart replays the same state.
- **Folding is a host compaction transaction** over the finished span. The originals remain in the
  journal and `fold_recall` brings them back verbatim.

## Install

```sh
dsh plugin add dsh-task-folding          # from the registry, once published
dsh plugin add /path/to/dsh-task-folding  # or from a checkout, as a link
```

Requires DSH `0.2.2-rc.5` or newer; the plugin declares its host peers and refuses nothing silently —
if the compaction engine is unavailable it says so and leaves folding off while the tools keep working.

## What the model gets

| Tool | Purpose |
|---|---|
| `task_begin` | Open a task: `{ title }`. Nesting is allowed; the tool result reports the id, the depth, the span start and the verdict threshold. |
| `task_end` | Close the innermost task: `{ summary, outcome? }`. The verdict (`folded` / `below-floor` / `delegated`) comes back as data, so no phrasing depends on it. |
| `fold_recall` | Read a fold back: `index` (page through the span's messages), `range` (return those messages) or `grep` (search them). |

A prompt section teaches the discipline: open a task before a stretch of work, close it with a summary
that says what changed and what remains, and nest only when the work really has parts.

## Settings

Every setting is live (changing it takes effect without a restart) and reachable from the plugin's page
in the Plugins section of the web app:

| Setting | Default | Meaning |
|---|---|---|
| `minSpanTokens` | `2000` | A closed task smaller than this is never folded. |
| `delegateEnabled` | `true` | Generate a summary with the LLM when the model's own is missing or unusable. |
| `minSummaryChars` | `200` | A summary shorter than this counts as missing. |
| `maxSummaryRatio` | `0.5` | A summary larger than this share of the task is unusable. |
| `staleTaskSteps` | `25` | Remind the model about a task open this many assistant messages. |
| `showTaskBar` | `false` | Show the task dock above the composer. |
| `summarizationProvider` | `''` | Provider for generated summaries; empty uses the session's route. |
| `summarizationModel` | `''` | Model for generated summaries; set together with the provider. |

## Measured cost

Folding must not cost the provider's cache: a generated summary replays the session's own request
prefix, so only its instruction is new input. The delegate fold measured **99.1 % cache-hit against a
median of 99.3 % over the session's main requests** (−0.2 pp; floor 80 %). Reproduce it on any journal:

```sh
node scripts/verify-cache.js <session journal>
```

The evaluation protocol, the configurations and the metrics live in
[docs/06-testing.md §5](docs/06-testing.md#5-evaluation-protocol); [M7's report](m7/REPORT.md) holds
the measured numbers with the method that produced them.

## Why another plugin

The idea was first implemented by [yindf/taskfold](https://github.com/yindf/taskfold). Its v0.40.1
showed the concept works, but the implementation rests on three decisions that keep producing bugs:
state reconstructed by parsing the English text of tool results, task boundaries anchored on whole
assistant messages, and folding done by subclassing an internal host class located by walking
`node_modules`.

This project keeps the concept and replaces the foundation:

| | taskfold 0.40.1 | dsh-task-folding |
|---|---|---|
| Source of state | rendered result text (`'Task ended: '…`) | `tool/result.meta` + a session projection |
| Boundaries | anchor on an assistant message; "one task-mark call per message" rules | cuts between completed call batches; no message rules |
| Who writes the summary | a separate LLM call per fold | the model itself, in `task_end`; an LLM call only as a fallback |
| Fold latency | blocks the next agent step for the duration of an LLM call | milliseconds (model-free replacement) |
| Recall | JSONL files on disk + the log | the log only |
| Tools / prompt | 4 tools, ~2k tokens per request | 3 tools, ~730 tokens |

## Development

```sh
npm test            # unit, property, replay and component tests
npm run coverage    # tests + the 100 % gate for host/projection.js and host/cuts.js
npm run typecheck   # tsc --noEmit --checkJs
npm run lint        # eslint + prettier --check
npm run perf        # latency guards (kept out of `npm test`: they measure wall time)
npm run contract    # live check against a published DSH release (weekly in CI)
```

The design lives in [`docs/`](docs/README.md); [`HANDOFF.md`](HANDOFF.md) says where the work stands.

## License

MIT — see [LICENSE](LICENSE).
