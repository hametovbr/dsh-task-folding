# 02 — Host API reference

Every DeepSeek Harness surface the plugin depends on, verified against the source of `deepseek-ai/deepseek-harness@2e39e704` (packages `0.2.2-rc.5`) and, where marked **[live]**, observed on a running 0.2.2-rc.5 host during milestone M0 ([`m0/REPORT.md`](../m0/REPORT.md)). Paths are relative to the DSH repository. Anything not listed here is out of bounds: if the implementation needs it, add it here first, with its source location.

Stability legend: **public** = documented service/event contract; **contract** = documented log protocol other consumers rely on; **internal** = implementation detail, isolated behind one adapter module.

## 1. Plugin shape

Source: `packages/preset/agent-preset/skills/dsh-doc/references/host-plugin.md`, `practices.md`.

- A bundle is an npm package whose `package.json` declares `dsh.bundle.patch` (a YAML patch inserting Loader rows). **[live]** One Loader row named after the package carries both the Host `apply` and the Client module (§10).
- Host entry: `export default { name, inject, Config?, apply(ctx, config) }`. The loader keeps only `exports.default`, so `Config` must sit on that object.
- `inject` lists required services; optional services go through `ctx.inject([...], fn)` so the plugin stays inactive rather than throwing.
- Every registration is an effect on the owning context (`ctx.effect`, `ctx.on`, service `register` calls return disposers).
- Display metadata: `locale/<lang>.json` with `meta.title` / `meta.description`, an icon export, both listed in `files`.
- Peer version gating: DSH ≥ 0.2.0 checks `peerDependencies` at install and startup with `semver.satisfies(…, { includePrerelease: true })`. Only peers named `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` are checked, an own `engines.dsh` range decides alone, and `peerDependenciesMeta` is ignored (`packages/app-boot/src/plugin-compatibility.ts`, `unmetRequirements`). **[live]** The check compares the installed **runtime** version, not the peer's own installed version.

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
- **[live]** `surfaceOp` is the string `'append'` for ordinary surface events and an object only for `replace`.
- **[live]** For a compaction checkpoint, `sourceEventSeqs` is a **superset** of the summary's `shadowedSeqs`: it also lists the checkpoint's own `compaction/start` and `compaction/summary` seqs (e.g. `[83, 85, 8, 9, …, 75]` for `shadowedSeqs` `[8, 9, …, 75]`). Those two are not surface nodes, so membership tests on surface seqs (cuts) are unaffected. `surfaceOp.startSeq/endSeq` equal `shadowedRange.start/end`. For a prune the two sets are identical.
- **[live]** `shadowedSeqs` are in **surface order**, not numeric order: a second checkpoint shadowed `[86, 79, 81, 89, …]`, where 86 is the previous summary node and 79/81 were appended while that earlier summary was being generated.
- `session.surface.nodes: readonly SessionSeq[]` — current model-visible order. `surface.replaceGeneration` increments on every committed replacement (a cheap cache key).
- `session.eventAt(seq)`, `session.deriveEventMessage(event): Message | null` — rebuild the model-facing message of any event, shadowed or not. This is what recall uses.
- `session.snapshotEvents()` — O(n) copy of the log. **The plugin MUST NOT call it on a per-step path.**
- `session.toolHistory()` — passed by the stock summarizer in `GenerateOptions`; the delegate path must pass it too.
- Custom event types are refused on reopen unless `ignorable: true`, which live `append()` cannot set. **The plugin MUST NOT append events.**
- Session repair (`packages/core/session/src/repair.ts`, `openTurnClosers`): an open tail turn is closed with synthetic **error** `tool/result`s for every unanswered call, then `step/end` and `turn/end`. The same closers seed a fork cut inside an open turn.

### Relevant event shapes

| Event | Fields the plugin reads |
|---|---|
| `assistant/message` | `data.message.content[]` blocks with `type: 'tool-call'`, `id`, `name`, `arguments`; `data.message.source.kind === 'model'` |
| `tool/call` **[live]** | Non-surface. `data.callId`, `data.name`. One per call, appended right before that call's execution. |
| `tool/result` | `data.message.toolCallId`, `data.message.isError`, `data.message.source = { kind: 'tool', callId }`, `data.turn`, `data.step`, `data.meta` (tool-private JSON), `surfaceOp`, `sourceEventSeqs` (`[<tool/call seq>]` for an append) |
| `user/message` | **[live]** `data` IS the message: `data.content`, `data.role`, `data.source` (`{ kind: 'user' }`, `'agent-instructions'`, `'runtime-context'`, `'skill-catalog'`, …). `surfaceOp` is `replace` for checkpoints; the checkpoint's `data.content` is the framing preamble block followed by the summary blocks. |
| `step/start`, `step/end` **[live]** | Non-surface step boundaries. `step/end` follows the last `tool/result` of a step. |
| `compaction/prune` **[live]** | Emitted by the tool-result pruner before its replacement: `data.shadowedSeqs`, `data.shadowedRange`, `data.shadowedTokenCount`. The replacement is a `tool/result` with `surfaceOp: replace` that **keeps the original result's `meta`**. |
| `compaction/start` | `data.compactionId`, `data.turn` |
| `compaction/summary` | `data.compactionId`, `data.summary` (unframed blocks — the first text block is the summary as produced), `data.shadowedRange`, `data.shadowedSeqs`, `data.shadowedTokenCount`, `data.provider`, `data.model`, `data.usage`, `data.llmStreamCall`, `data.rawOutput`, `data.maxTokens` |
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
- `init` receives `inheritedEventCount`. **[live]** A plain resume reports `0` and replays the whole log through `apply` (including every `meta`); a fork reports the inherited event count (e.g. `28`) and replays the inherited prefix, then continues the parent's seq numbering. Open tasks therefore carry into forks naturally.
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
  execute(args, exec: ToolRunContext): Promise<unknown>   // exec.agent, exec.signal, exec.callId, exec.rootCallId
}
```

- `meta` is "persisted on `tool/result` or `tool/ptc-dispatch` for Host presenters and Client renderers", replayable, and never sent to the model. **This is the plugin's only durable write channel.** **[live]** Confirmed persisted on `tool/result.data.meta`, surviving process restart, resume and fork.
- **[live] Call identity.** For a direct call, `exec.rootCallId === exec.callId` (the call's own id). For a call nested in a PTC `run_code` program, `exec.callId` is `<rootCallId>:ptc:<n>` and `exec.rootCallId` is the enclosing `run_code` call. **Nested-call test: `exec.callId !== exec.rootCallId`.** (`rootCallId` alone is set for every call.)
- **[live] PTC.** `tool-executor-ptc` ships `disabled: true`; only one executor may be registered per scope, so enabling PTC means disabling the native executor. A nested call produces no `tool/result`; it is recorded as `tool/ptc-dispatch-start` + `tool/ptc-dispatch`, and its `presentationMeta` lands on `tool/ptc-dispatch.data.meta`. Task-mark tools MUST refuse nested calls.
- **[live] Execution order.** The native executor runs the calls of one assistant message **sequentially**: `tool/call` → `tool/result` for the first call, then the next, in call order. A call's result is committed before the next call starts.
- `tools/pre-execute` (waterfall) and `ctx.tools.guard()` exist; the plugin does not need them in the base design.
- **Schema subset.** `parameters` and `output.schema` must use only `type` (exactly one string: type arrays are refused), `oneOf`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, plus the annotations `description`, `title`, `default`, `examples` — enforced by `assertSupportedJsonSchema` (`packages/core/tools/src/json-schema.ts`, L76–L90, L302–L374). A nullable field is written as `oneOf: [{ "type": "string" }, { "type": "null" }]`.
- **Arguments are not validated.** The registry validates the *returned value* against `output.schema` and nothing checks `exec.arguments` against `parameters` (`packages/core/tools/src/pipeline.ts` `dispatchToolBody`; neither the registry nor `dsh-tool-executor-native` reads `parameters` on execution). A tool must validate its own arguments.
- **Errors.** A tool that throws yields `isError: true` with `content: [{ type: 'text', text: 'Error: <message>' }]` and **no** `meta` (`toolErrorResult`, `pipeline.ts` L719). Error text is therefore model-facing and belongs in `host/texts.js`.

## 5. Agent hooks (public)

Source: `packages/core/agent/src/runtime-types.ts`, `packages/core/agent-loop/src/agent.ts`.

| Hook | Mode | Payload | Use |
|---|---|---|---|
| `agent/created` | serial | `{ agent, source, signal? }` | per-agent registrations on `agent.ctx` |
| `agent/pre-step` | waterfall | `{ agent, messages, turn, step, signal, modelSelection }`, `next(): Promise<PreStepDecision>` | run due self-summary folds (fast); MUST return `next()`'s decision (spread it if rewriting) |
| `agent/turn-stopping` | serial | `{ agent, turn, signal }` | run due self-summary folds at turn end |

Agent methods:

- `agent.inject(message: UserMessage)` — model-facing context for the next pre-step, does not wake the agent. Used for hints.
- `agent.runMaintenance(task: (signal) => Promise<T>)` — run a non-turn job while idle; throws synchronously if the agent is busy. **[live]** Scheduled from `agent/turn-stopping` as `agent.whenIdle().then(() => agent.runMaintenance(job))` (not awaited), the job starts right after the turn; a user message sent meanwhile is **held until the job settles** (it is not aborted by the message), so a job delays the next turn by its full remaining duration. Agent disposal (e.g. a one-shot headless process exiting) aborts it. `idle` can arrive up to ~3 s after `turn-stopping`. Not used by the current design (see [ADR 0006](adr/0006-background-delegate.md)).
- `agent.whenIdle()` — **[live]** present; listeners must not await it.
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
- The constructor registers an `answeredRoute` projection (key `compactionAnsweredRoute`; a second registration of the same key at the same `stateVersion` shares it — `packages/session/session-projection/src/index.ts` ~L405–L420) and, if `config.auto` (default `true`), the automatic pressure hooks. `static inject = ['llm', 'tokenMeter', 'sessions', 'sessionProjections']`.
- `CompactionEngine extends Service` and calls `super(ctx, 'compaction')` (`packages/compaction/compaction/src/index.ts` ~L119): constructing an engine on a real context provides it under the `compaction` name. A plugin-owned instance must be built so that it does not replace the realm's engine (taskfold used a shim context with a no-op `reflect.provide`); see [ADR 0004](adr/0004-engine-adapter.md).
- `SummaryResult` = `{ summary: ContentBlock[], provider: string, model: string, maxTokens?, usage? }` plus either `{ rawOutput, llmStreamCall: true }` (a call through `ctx.llm.stream`) or neither (an unmarked template/remote result). `compactRegion` on the engine runs with `{ owner: 'current-turn', stability: 'whole-surface' }`.
- `region.ts` rejects a summary that is not smaller than the shadowed content: it compares `tokenMeter.estimateMessage(<framed checkpoint message>)` with the span's **route-priced** token count (`summarizeCompaction`, ~L415). The plugin's own size check before committing should use the same estimator on the framed text.
- Transaction order (`region.ts` L211–L250): `compaction/start` is appended, then `summarize()` runs, then the span is re-checked, then the body commits and `compaction/end` is appended. Any failure before the body commit appends `compaction/end { error }`. During summarization only the selected span must stay stable; nodes appended outside it are allowed (`assertSelectedSpanStable`).
- `frameSummary()` wraps every summary in a fixed preamble + `<compacted-summary>` tags. This framing applies to our folds too; it cannot be changed without an upstream option.

There is no public way to pass a ready-made summary or a custom instruction to `ctx.compaction.compactRegion`. See [ADR 0004](adr/0004-engine-adapter.md).

### Construction of a plugin-owned engine (M3 spike, live on 0.2.2-rc.5)

`new BasicCompactionEngine(shim, { auto: false })` works when `shim` is a plain object that
provides exactly what the constructor and the transaction read:

| Member | Why | Evidence |
|---|---|---|
| `reflect.provide(name, value)` → no-op | `Service`'s constructor registers the instance as `compaction` through this call; a no-op keeps the realm's service untouched | `packages/cordis/src/service.ts` L42–L58; live: `ctx.compaction` still the realm's `BasicCompactionEngine` afterwards |
| `tokenMeter` | `compactSurfaceRegion` prices the span and the framed summary with it | `region.ts` `prepareCompaction`, `summarizeCompaction` |
| `waterfall` | `recover()` dispatches `compaction/summary-error` | `index.ts` `regionDependencies()` |
| `logger` | diagnostics during the transaction | `region.ts` |
| `get` | optional sibling services during automatic compaction (unused with `auto: false`) | `index.ts` ~L303 |

`on`/`effect` are deliberately **not** provided: with `auto: false` the constructor registers
nothing, so a call to either would be a bug worth failing on. `{ auto: false }` is required —
with `auto: true` the constructor registers pressure hooks on the shim instead of the realm,
which would silently disable automatic compaction.

`compactRegion` on a real session works unchanged against such an instance: it appends
`compaction/start` → `compaction/summary` (provider/model from our prepared route, no
`llmStreamCall`, no `usage`) → the replacement `user/message` → `compaction/end`. Errors are
**not** wrapped in `ManualCompactionError` for this entry point — only `busy` arrives that way
(`assertCompactionInactive`); the shrink refusal is a plain `Error` whose message starts with
`summary is not smaller than the shadowed content` (`region.ts` ~L415–L422). The adapter
classifies on that text, and `scripts/contract-check.js` pins it in CI.

## 7. LLM and token meter (public)

- `ctx.llm.stream(options: GenerateOptions)` — async iterable of `StreamChunk`; `BlockAssembler` from `@deepseek-ai/dsh-llm` assembles blocks, usage and finish. Used by the delegate path only.
- `ctx.tokenMeter.estimateMessage(message): number` (`packages/llm/token-meter/src/index.ts` L219) — the host's own estimator. Use it for the fold floor instead of a private heuristic.

## 8. System prompt (public)

- `ctx.systemPrompt.section({ name, order, text })` returns a disposer. Do not listen to `system-prompt/assemble`.

## 9. Settings (public)

- A `Config` schema built with `@deepseek-ai/schemastery`; fields marked `.volatile()` render as live rows on the Plugins page and are re-resolved without reload. The plugin reads them through the reactive `config` passed to `apply`.
- **[live] Module resolution is layout-dependent.** With the bundle physically inside `profiles/<name>/node_modules/` (registry installs), bare `import('@deepseek-ai/schemastery')`, `…/dsh-compaction`, `…/dsh-compaction-basic` and `…/dsh-llm` all succeed, because the profiles directory holds `node_modules/@deepseek-ai/*` links to the runtime. With a development install (`dsh plugin add <local path>` creates a pnpm `link:`), Node resolves the real path and the same imports fail. Use bare imports first, then fall back to `createRequire` anchored at the DSH runtime (`process.argv[1]`'s `node_modules`). See [07 Q4](07-open-questions.md#q4).
- **[live] Declaring the packages as `peerDependencies` does not link them.** After `dsh plugin add <local path>` the profile's `node_modules` held only the plugin's own symlink — no `@deepseek-ai/*` entries at all — and the runtime fallback in `host/resolve.js` is what makes `@deepseek-ai/schemastery` available. A row's `config` is still applied: setting `minSpanTokens` in the profile's `cordis.patch.yml` changed the verdicts of the next session (M2, [report](../m2/REPORT.md)).

## 10. Client (public)

Source: `references/ui-plugin.md`, `practices.md`.

- A Client module is a script calling `window.__ModuleLoader__.load({ id: '<package name>', factory(require) { … return { inject, apply(ctx) {} } } })`; React comes from `require('react')`. The package declares `dsh.client: { platform: 'web', immediately, inject }` and exports `./client`. Template: `packages/preset/agent-preset/skills/dsh-doc/templates/decoration/`.
- **[live]** ONE Loader row named after the package serves both the Host `apply` and the Client module. taskfold needed two rows only because its Host row was a package subpath.
- Contribute through `ctx.slots.inject(ownerKey, () => ctx.slots.register(…))`. **[live]** Both dock slots exist: `conversation.input.dock` ("full-width entries above the composer card") renders on the home screen and in conversations; `conversation.composer.dock` ("ambient entries below the composer card") mounts only once a conversation is open. **Use `conversation.input.dock`.** `slots.inject` with a misspelled slot name fails silently. The settings card: `plugins.bundle.config`.
- Read projection values through slot-prop selector hooks; style with `--dsw-alias-*` tokens; never import Harness Client packages as modules.

## 11. Operations (live)

Observed on 0.2.2-rc.5 (Linux, Node 24). Useful for live tests and fixtures.

- **Session storage:** `$DSH_HOME/sessions/<escaped-cwd>/session-<uuid>/session.v4.jsonl.zstd` — JSONL, one event per line, compressed as concatenated zstd frames. Decode frame by frame with `node:zlib.zstdDecompressSync`. The first line is the session header (`{"type":"session","version":4,…}`, no `seq`).
- **Headless driving:** a profile composed with `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless` (without `dsh-web-app`, whose CLI claims the whole command line) runs one task per process: `dsh --profile <p> --json [--session-id <id>] "<task>"`. `--json` streams NDJSON whose first line carries `sessionId`; `--session-id` resumes a persisted session.
- **Composition dump:** `dsh --profile <p> --dump-config`.
- **Development install:** `dsh plugin --profile <p> add <absolute local path>` (pnpm `link:`; see §9 for the resolution consequence).
