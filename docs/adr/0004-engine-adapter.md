# 0004 — Fold through one isolated adapter; propose an upstream API

**Status:** Accepted as an interim solution (2026-11-20).

## Context

The public `ctx.compaction.compactRegion(start, end, agent, signal)` always summarizes with the realm engine's stock checkpoint instruction. There is no public way to pass a prepared summary or a custom instruction. `BasicCompactionEngine.summarize()` is documented as "the sole subclass customization hook", and its `SummaryResult` explicitly allows output that did not come from `ctx.llm.stream` ("template, remote, or other summarizer").

## Options

1. **Subclass `BasicCompactionEngine`** with a `summarize()` that returns the prepared blocks (self path) or runs our delegate request; construct it with `auto: false`. Keeps the host's lock, validation, pricing and commit.
2. Append the compaction transaction events ourselves, as the tool-result pruner does for its replacements. No internal imports, but duplicates the lock and pricing protocol.
3. Wrap `ctx.llm.stream` to rewrite the instruction of host compaction calls (taskfold's dead "detailed checkpoint" swap) — rejected outright: global side effects on every plugin's LLM calls.
4. Upstream: `compactRegion(…, { summary } | { instruction })` or a `compaction/summarize` waterfall.

## Decision

Option 1 now, isolated in `host/engine-adapter.js`, with option 4 proposed upstream in parallel (milestone M8). Options 2 and 3 are not used.

## Consequences

- `engine-adapter.js` is the only file that imports or probes for `@deepseek-ai/dsh-compaction-basic`, constructs the engine, or knows its constructor's injections. Everything else calls `foldRegion(start, end, agent, signal, blocks | delegateFn)`.
- A CI contract check downloads the published host package versions in the supported range and verifies the adapter's assumptions (exports, `summarize` dispatch, `compactRegion` signature, constructor injections), replacing taskfold's hand-maintained "27/27 APIs present" table.
- If resolution fails at runtime, the plugin keeps working without folds and says so once.
- When the upstream API lands, the adapter is deleted and the plugin moves to `inject: ['compaction']`.
