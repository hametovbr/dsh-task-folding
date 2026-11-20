# 02 — Host API reference

Every DeepSeek Harness surface the plugin depends on, verified against `deepseek-ai/deepseek-harness@2e39e704` (packages `0.2.2-rc.5`). Paths are relative to that repository. Anything not listed here is out of bounds: if the implementation needs it, add it here first, with its source location.

Stability legend: **public** = documented service/event contract; **contract** = documented log protocol other consumers rely on; **internal** = implementation detail, isolated behind one adapter module.

## 1. Plugin shape

Source: `packages/preset/agent-preset/skills/dsh-doc/references/host-plugin.md`, `practices.md`.

- A bundle is an npm package whose `package.json` declares `dsh.bundle.patch` (a YAML patch inserting Loader rows). One Host row and, separately, one Client row (a Client package may have exactly one owning Loader row).
- Host entry: `export default { name, inject, Config?, apply(ctx, config) }`. The loader keeps only `exports.default`, so `Config` must sit on that object.
- `inject` lists required services; optional services go through `ctx.inject([...], fn)` so the plugin stays inactive rather than throwing.
- Every registration is an effect on the owning context (`ctx.effect`, `ctx.on`, service `register` calls return disposers).
- Display metadata: `locale/<lang>.json` with `meta.title` / `meta.description`, an icon export, both listed in `files`.
- Peer version gating: DSH ≥ 0.2.0 checks `peerDependencies` at install and startup with `semver.satisfies(…, { includePrerelease: true })`.

## 2. Session log and surface (public)

Source: `packages/core/session/src/types.ts`, `index.ts`, `surface.ts`.

```ts
type SessionEvent = {
  type: K; seq: SessionSeq; time: number; data: SessionEventMap[K]; ignorable?: true
} & (K extends SurfaceEventType            // system/message, user/message, assistant/message, tool/result
      ? { surfaceOp: 'append' | { op: 'replace'; startSeq; endSeq }; sourceEventSeqs?: SessionSeq[] }
      : { surfaceOp?: never; sourceEventSeqs?: never })
```

- A `replace` surface op shadows the surface range `startSeq..endSeq` **by position** (not numeric order). Its `sourceEventSeqs` "must include every shadowed surface node" (`types.ts` ~L465). The plugin uses this to detect which tracked cuts were shadowed, without access to the surface inside the pure projection.
- `session.surface.nodes: readonly SessionSeq[]` — current model-visible order. `surface.replaceGeneration` increments on every committed replacement (a cheap cache key).
- `session.eventAt(seq)`, `session.deriveEventMessage(event): Message | null` — rebuild the model-facing message of any event, shadowed or not. This is what recall uses.
- `session.snapshotEvents()` — O(n) copy of the log. **The plugin MUST NOT call it on a per-step path.**
- `session.toolHistory()` — passed by the stock summarizer in `GenerateOptions`; the delegate path must pass it too.
- Custom event types are refused on reopen unless `ignorable: true`, which live `append()` cannot set. **The plugin MUST NOT append events.**

### Relevant event shapes

| Event | Fields the plugin reads |
|---|---|
| `assistant/message` | `data.message.content[]` blocks with `type: 'tool-call'`, `id`, `name`, `arguments` |
| `tool/result` | `data.message.toolCallId` (v4 format), `data.message.isError`, `data.meta` (tool-private JSON), `surfaceOp`, `sourceEventSeqs` |
| `user/message` | `surfaceOp` (`replace` for compaction checkpoints), `sourceEventSeqs` |
| `compaction/start` | `data.compactionId`, `data.turn` |
| `compaction/summary` | `data.compactionId`, `data.summary`, `data.shadowedRange`, `data.shadowedSeqs`, `data.shadowedTokenCount`, `data.provider`, `data.model`, `data.usage` |
| `compaction/end` | `data.compactionId`, `data.error?` |

`compaction/summary` is immediately followed by the replacement `user/message` (adjacency is contractual, `packages/compaction/compaction/src/types.ts`).

## 3. Session projections (public)

Source: `packages/session/session-projection/src/index.ts`.

```ts
ctx.sessionProjections.register({
  key, stateSchema /* .parse() */, init(header, inheritedEventCount), apply(state, event),
  stateVersion /* non-negative integer; bump on semantic change */,
  wire?: { viewSchema, view(state), summary?: boolean },
}): Promise<ProjectionHandle<S>>   // handle.stateOf(session)
```

- `apply` MUST be pure, synchronous, and return the same reference for ignored events.
- State MUST be plain JSON (it is checkpointed to the projection cache; old checkpoints are discarded on `stateVersion` mismatch and the log is replayed).
- `init` receives `inheritedEventCount` for forks: a forked session replays its inherited prefix through `apply`, so open tasks carry into forks naturally.
- The returned value is a promise; the callable form is deprecated (taskfold still uses it and gets a deprecation warning per key).
- `wire.view` is how the Client gets derived state; the Client never folds events itself.

## 4. Tools (public)

Source: `packages/core/tools/src/contracts.ts`, `pipeline.ts`.

```ts
interface ToolDefinition extends ToolSchema {        // name, description, parameters, deferLoading?
  output: {
    schema: JsonSchemaNode                           // validated against the returned value
    render(args, value): ContentBlock[]              // model-facing content
    presentationMeta?(args, value): JsonValue        // → persisted as tool/result.data.meta
  }
  execute(args, exec: ToolRunContext): Promise<unknown>   // exec.agent, exec.signal, exec.rootCallId
}
```

- `meta` is "persisted on `tool/result` or `tool/ptc-dispatch` for Host presenters and Client renderers", replayable, and never sent to the model. **This is the plugin's only durable write channel.**
- `exec.rootCallId` is set when the call is nested inside a PTC `run_code` program. Nested calls do not produce their own `tool/result` events (they are recorded in `tool/ptc-dispatch`), so task-mark tools MUST refuse to run under PTC (see [07](07-open-questions.md#q1)).
- `tools/pre-execute` (waterfall) and `ctx.tools.guard()` exist; the plugin does not need them in the base design.

## 5. Agent hooks (public)

Source: `packages/core/agent/src/runtime-types.ts`, `packages/core/agent-loop/src/agent.ts`.

| Hook | Mode | Payload | Use |
|---|---|---|---|
| `agent/created` | serial | `{ agent, source, signal? }` | per-agent registrations on `agent.ctx` |
| `agent/pre-step` | waterfall | `{ agent, messages, turn, step, signal, modelSelection }`, `next(): Promise<PreStepDecision>` | run due self-summary folds (fast); MUST return `next()`'s decision (spread it if rewriting) |
| `agent/turn-stopping` | serial | `{ agent, turn, signal }` | run due self-summary folds at turn end |

Agent methods:

- `agent.inject(message: UserMessage)` — model-facing context for the next pre-step, does not wake the agent. Used for hints.
- `agent.runMaintenance(task: (signal) => Promise<T>)` — run a non-turn job while idle; throws synchronously if the agent is busy. Used for delegate folds.
- `agent.session`, `agent.options.{provider, model}`.

## 6. Compaction (public service + internal implementation)

Source: `packages/compaction/compaction/src/index.ts`, `types.ts`, `tool-pairing.ts`; `packages/compaction/compaction-basic/src/index.ts`, `region.ts`, `summarizer.ts`.

Public contract (`ctx.compaction: CompactionEngine`):

- `compactRegion(start, end, agent, signal?)` — replace the inclusive surface-position range with one summary node. Rejects active (lock held), missing, reversed or unbalanced ranges. Appends `compaction/start` → `compaction/summary` → replacement `user/message` → `compaction/end`.
- `toolPairingBalancedBefore(session, seq)` / `toolPairingBalancedAfter(session, seq)` — exported edge checks.
- `ManualCompactionError` with `code ∈ busy | cancelled | changed | summary | commit | persistence`.
- Waterfall `compaction/summary-error`.

Internal (`BasicCompactionEngine`):

- `summarize(input, agent, signal): Promise<SummaryResult>` is "the sole subclass customization hook". `SummaryResult` may omit `llmStreamCall`/`rawOutput` for "template, remote, or other summarizer" output — exactly what a self-summary is.
- The constructor registers an `answeredRoute` projection and, if `config.auto`, the automatic pressure hooks. `static inject = ['llm', 'tokenMeter', 'sessions', 'sessionProjections']`.
- `region.ts` rejects a summary that is not smaller than the shadowed content (`ManualCompactionError('summary')`).
- `frameSummary()` wraps every summary in a fixed preamble + `<compacted-summary>` tags. This framing applies to our folds too; it cannot be changed without an upstream option.

There is no public way to pass a ready-made summary or a custom instruction to `ctx.compaction.compactRegion`. See [ADR 0004](adr/0004-engine-adapter.md).

## 7. LLM and token meter (public)

- `ctx.llm.stream(options: GenerateOptions)` — async iterable of `StreamChunk`; `BlockAssembler` from `@deepseek-ai/dsh-llm` assembles blocks, usage and finish. Used by the delegate path only.
- `ctx.tokenMeter.estimateMessage(message): number` (`packages/llm/token-meter/src/index.ts` L219) — the host's own estimator. Use it for the fold floor instead of a private heuristic.

## 8. System prompt (public)

- `ctx.systemPrompt.section({ name, order, text })` returns a disposer. Do not listen to `system-prompt/assemble`.

## 9. Settings (public)

- A `Config` schema built with `@deepseek-ai/schemastery`; fields marked `.volatile()` render as live rows on the Plugins page and are re-resolved without reload. The plugin reads them through the reactive `config` passed to `apply`.
- Resolving `schemastery` from a profile-installed bundle is a known problem (taskfold uses `createRequire` from host anchors). See [07](07-open-questions.md#q4).

## 10. Client (public)

Source: `references/ui-plugin.md`, `practices.md`.

- A Client module is a script calling `window.__ModuleLoader__.load({ id: '<package name>', factory(require) { … return { inject, apply(ctx) {} } } })`; React comes from `require('react')`. The package declares `dsh.client: { platform: 'web', immediately, inject }` and exports `./client`. Template: `packages/preset/agent-preset/skills/dsh-doc/templates/decoration/`.
- In the official template, ONE Loader row named after the package serves both the Host `apply` and the Client module. taskfold needed two rows only because its Host row was a package subpath. See [07 Q7](07-open-questions.md#q7).
- Contribute through `ctx.slots.inject(ownerKey, () => ctx.slots.register(…))`. The dock slot: taskfold uses `conversation.input.dock`, the template uses `conversation.composer.dock` — verify with `cordis_inspect` `Slots.listSubTree`. The settings card: `plugins.bundle.config`.
- Read projection values through slot-prop selector hooks; style with `--dsw-alias-*` tokens; never import Harness Client packages as modules.
