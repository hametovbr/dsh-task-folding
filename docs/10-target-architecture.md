# 10 — Target architecture

Status: proposal, 2026-11-21. This document describes the architecture this plugin *should* have had,
derived from 4 483 lines of working code, 357 tests and every defect those tests and the live sessions
found. It is a design, not a migration log: [`docs/05`](05-implementation-plan.md) says where the
current code stands, [`docs/08`](08-followups.md) lists the open defects, and §14 here says what to
delete.

The premise is the lesson of M3–M7 and T0–T4: **the pure core was right; the seams were not.** Every
real defect lived in a boundary — between the runner and the projection, between the plugin and the
host, between a contract and a field added later, between the journal and the code that trusted it.
The target architecture moves those boundaries into named modules with named guarantees.

## 1. Principles

1. **The domain is pure and total.** Everything that can be a function of `(state, event, config)` is
   one: no `ctx`, no clock, no I/O, no promises, 100 % branch coverage, property-tested.
2. **Every boundary is a port with a written guarantee.** The host, the logger, the clock, the journal
   and the LLM are ports. A port states what it may throw and what callers may assume; the plugin code
   never assumes more.
3. **Time is explicit.** The surface changes; therefore the surface has a version. Nothing compares two
   observations without naming the version each was taken at.
4. **Contracts are objects with a schema version.** No positional argument lists longer than three, no
   field appended to a shape that already crossed a module boundary.
5. **One owner per concern.** One module decides when a fold is due, one commits it, one writes the
   log record, one delivers a hint. A second owner is a bug in waiting.
6. **Failures are first-class states, not exceptions.** `waiting | generating | committing | folded |
   cancelled | failed | stale` are states with defined transitions; an exception is only how a port
   reports that a state could not be reached.

## 2. Layers

```
                    ┌──────────────────────────────────────────────┐
   host services →  │ ports/    compaction · llm · logger · clock  │  (the only impure edge)
                    └──────────────┬───────────────────────────────┘
                                   │
   session events →  ┌────────────┴───────────────┐
   journal gateway   │ domain/  projection · cuts │  pure, total, 100 %
                     │          planner · verdict │
                     │          estimate · texts  │
                     └────────────┬───────────────┘
                                   │  (state, surfaceSnapshot)
                     ┌────────────┴───────────────┐
                     │ runtime/  session-runtime  │  one state object per session
                     │           scheduler        │  transitions, no I/O
                     │           generation       │  deferred summaries, epoch-bound
                     └────────────┬───────────────┘
                                   │  actions
                     ┌────────────┴───────────────┐
                     │ tools/    task_begin        │  schemas + durable meta
                     │           task_end          │
                     │           fold_recall       │
                     │ prompt/   section · hints   │
                     └────────────┬───────────────┘
                                   │
                     ┌────────────┴───────────────┐
                     │ plugin/   mount · pre-step  │  the only place that touches ctx
                     │           turn-stopping     │
                     └────────────┬───────────────┘
                                   │ projection wire view
                     ┌────────────┴───────────────┐
                     │ client/   module · dock     │  browser; texts generated from locale
                     │           settings-card     │
                     └────────────────────────────┘
```

Dependency rule: an arrow points down only. `domain/` imports nothing but itself (`texts` is a leaf).
`runtime/` imports `domain/` and port *types*. `tools/` imports `domain/` and `runtime/` (for
`stateOf`). `plugin/` is the only directory that may import `ctx`, and the only one allowed to import
`ports/` implementations rather than interfaces.

## 3. Module tree

```
host/
  domain/
    types.js            shapes shared by every layer (no runtime code)
    journal.js          event classification: is this a surface event? a task result? a compaction?
    projection.js       State reducer; the only place task state is derived
    surface.js          SurfaceSnapshot { epoch, nodes }, replace/prune application, epoch bumps
    cuts.js             cut translation on replacement
    planner.js          dueTasks(state), resolveRegion(task, snapshot)
    verdict.js          the economy rule and the terminal verdicts
    estimate.js         token estimation with a session cache
    texts.js            every model-facing string; one leaf module
  ports/
    host-services.js    the only module calling ctx.get(...) / ctx.tools / ctx.systemPrompt
    compaction.js       CompactionPort: fold(request) | reject(region, reason)
    compaction-native.js  implementation against a public host API (upstream, §15)
    compaction-shim.js  implementation against today's BasicCompactionEngine (the only file
                        importing @deepseek-ai/dsh-compaction-basic)
    llm.js              LlmPort: supports() | generate(request) → SummaryResult
    logger.js           LogPort with the guarantee "never throws"
    clock.js            ClockPort: now()
  runtime/
    session-runtime.js  SessionRuntime: per-session state, explicit transitions
    scheduler.js        pass(snapshot) → actions; owns ordering and retry policy
    generation.js       deferred generation jobs bound to an epoch
  tools/
    index.js            createTools: composes the three tools and the shared direct-call guard
    meta.js             the durable payload writer, versioned (the reducer owns the validating reader)
    task-begin.js       task_begin
    task-end.js         task_end (uses domain/verdict)
    recall.js           fold_recall (uses domain/ + journal view)
  prompt/
    section.js          assembles the prompt section from parts, enforces the budget
    hints.js            the stale/empty-span rule (pure)
  plugin/
    mount.js            registration of projection, tools, prompt, hooks
    pre-step.js         the single pre-step orchestrator: fold → hint → decision
    turn-stopping.js
client/
  module.js             the loader entry
  client.dock.js        conversation.input.dock       (package-local chunk)
  client.settings-card.js  plugins.bundle.config      (package-local chunk)
  client.locale.generated.js  generated from locale/en.json at build time (package-local chunk)

The `client.` prefix is the host's package-local chunk contract, not a naming preference: the loader
serves a sibling file only when its name matches `^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$`
(`@deepseek-ai/dsh-client-modules`, `CLIENT_CHUNK`), so `dock.js` and `settings-card.js` cannot be
fetched with `require.async`. `module.js` is the entry because the host reads its path from
`exports["./client"]`.
scripts/
  contract-check.js  eval-report.js  verify-cache.js  mutate.js  check-pack.js  e2e-headless.js
```

## 4. Contracts

### 4.1 SurfaceSnapshot — the fix for F9 and for `regionKey`

```js
/** @typedef {{ epoch: number, nodes: readonly number[] }} SurfaceSnapshot */
```

`domain/surface.js` owns the epoch. It increments on **every** event that changes the node list —
`surfaceOp.replace`, a prune, a compaction — and `projection.js` stores it in `State.surfaceEpoch`
alongside `State.surfaceNodes`. The projection is the only producer; a consumer receives the pair
together, never the list alone.

Resolution and commit then compare versions instead of rebuilding a key:

```js
resolveRegion(task, snapshot)          // → { kind:'fold', startSeq, endSeq, from, to } | …
generation = { taskId, epoch, region }  // captured at start
if (snapshot.epoch !== generation.epoch) drop();   // one integer, no string assembly
```

A `regionKey` string is no longer needed: the epoch *is* the identity of the node list, and the region
is a pair of seqs. This is what makes the T4 race (F9) impossible by construction rather than by a
careful re-read: a commit against a moved surface cannot compare equal, and the scheduler's "stale"
transition is a normal outcome, not a permanent skip.

### 4.2 SessionRuntime — one object instead of seven WeakMaps

```js
/** @typedef {object} TaskRuntime
 *  @property {'waiting'|'generating'|'committing'|'folded'|'cancelled'|'failed'|'skipped'} phase
 *  @property {number} epoch            the surface epoch this task's phase was decided at
 *  @property {number} attempts         durable failures so far (the cap lives here)
 *  @property {number|null} retryAfter  boundary number for the backoff
 *  @property {string|null} skipReason  why it cannot fold (epoch-scoped, not process-scoped)
 *  @property {PendingSummary|null} pending
 */

/** @typedef {object} SessionRuntime
 *  @property {SurfaceSnapshot} snapshot
 *  @property {Map<string, TaskRuntime>} tasks
 *  @property {Generation|null} generation   at most one per session
 *  @property {ImplicitJob|null} implicit    the turn fold's generation (03 §5.6); span-keyed, no task
 *  @property {number|null} implicitTurn      the turn that already ran an implicit fold
 *  @property {number} boundary               monotone pass counter
 */
```

The seven WeakMaps (`skipped`, `waiting`, `backoff`, `pending`, `generating`, `generationFailed`,
`rejectLogged`) become fields of one object with one `reduce(runtime, action) → runtime`. That reducer
is pure and property-tested, so illegal transitions (commit after fold, a second generation in flight,
a skip outliving an epoch) are test failures, not production surprises.

### 4.3 Request and result objects

```js
/** @typedef {object} FoldRequest
 *  @property {SurfaceSnapshot} snapshot
 *  @property {{startSeq:number, endSeq:number, from:number, to:number}} region
 *  @property {ContentBlock[]} blocks
 *  @property {{provider:string, model:string}} route
 *  @property {TokenUsage|undefined} usage   present from day one: a fold without it is unauditable
 *  @property {AbortSignal|undefined} signal
 */

/** @typedef {object} SummaryResult
 *  @property {ContentBlock[]} blocks
 *  @property {{provider:string, model:string}} route
 *  @property {TokenUsage|undefined} usage
 *  @property {'self'|'delegate'} source     our own record of who wrote it (see §8)
 */
```

`CompactionPort.fold(request)` replaces `foldRegion(agent, start, end, blocks, route, signal, usage)`.
Adding a field to an object is a compatible change; adding an eighth positional argument is not, and
`usage` proved it.

## 5. The pre-step flow

```
agent/pre-step
  │
  ├─ 1. snapshot ← stateOf(session)                 (State + SurfaceSnapshot, one call)
  ├─ 2. actions  ← planner.plan(snapshot, runtime)  (pure: which tasks are due, why others wait)
  ├─ 3. if a generation is possible and none in flight:
  │       runtime = startGeneration(runtime, task, snapshot)   (un-awaited; job bound to epoch)
  ├─ 4. for each due task, in plan order:
  │       outcome ← scheduler.step(task, snapshot, runtime)
  │         'folded' | 'busy' | 'deferred' | 'stale' | 'skipped' | 'failed' | 'cancelled'
  │       runtime ← transition(runtime, outcome)
  │       snapshot ← stateOf(session) when the outcome changed the surface
  ├─ 5. hint ← prompt/hints.maybeHint(state, runtime, settings)
  └─ 6. return decision.messages + (hint ? [hintMessage] : [])
```

One orchestrator (`plugin/pre-step.js`) owns all of it. Today two handlers are registered on the same
event — the runner's `preStep` and a second closure in `index.js` that folds in the hint — and they can
disagree about what the decision is. Here the order is code, not convention.

The hint rule gains the case Q15 exposed: a task that closes with a **span below the floor because the
begin batch swallowed the work** gets a hint at the moment of closing (one line: "the begin call shared
its message with the work; open the next task on its own"), in addition to the age-based one. The
latch key includes the reason, so it publishes once per task and reason.

## 6. The generation and commit protocol

```
start(task):
  job = { taskId, epoch: snapshot.epoch, region, promise: llm.generate(request) }
  runtime.generation = job                      // at most one per session
  return immediately                            // never awaited on the hot path

commit(task):
  if (runtime.generation?.taskId !== task.id) → 'nothing'
  job = runtime.generation
  current = stateOf(session)
  if (current.epoch !== job.epoch)            → 'stale'   (drop; regenerate later, never permanent)
  if (region no longer resolves)               → 'stale'
  result = await job.promise                   (already settled or settles now; never blocks a step)
  if (result === null)                         → 'failed' (one durable record, cap in TaskRuntime)
  if (signal.aborted)                          → 'cancelled' (no durable record, no cap movement)
  compaction.fold({ snapshot: current, region, blocks, route, usage })
```

Every outcome is a named transition of `SessionRuntime`, so the scheduler cannot forget one. Today the
same logic is spread over `startDelegate`, `delegateStep`, `commitDelegate`, `recordFailure`,
`regionKeyOf` and three WeakMaps — and F9 was the cost of one missing re-read.

The implicit turn fold (03 §5.6) does not add a second pipeline: it is the same `start` → `ready` →
`commit` protocol with a span-keyed job instead of a task id, the same region key, and the same
compaction port. Its one difference is the failure accounting: a task's failed generation is recorded
durably because the cap must survive a restart, while the implicit fold has no task and no cap, so a
failed or cancelled generation is dropped with one info line.

## 7. Ports and their guarantees

| Port | Methods | Guarantee the plugin may rely on |
|---|---|---|
| `CompactionPort` | `fold(request) → {committed:true}` / `reject(region, reason)` | `fold` either writes the whole host transaction or throws without writing; `reject` records a durable failed attempt at zero LLM cost |
| `LlmPort` | `supports()`, `generate(request) → SummaryResult` | `generate` never runs on the pre-step/turn-stopping stack; it resolves `null` rather than throwing for a rejection; it is abort-aware |
| `LogPort` | `warn`, `info`, `error` | **never throws** — a broken sink cannot change behaviour or replace an error |
| `ClockPort` | `now()` | monotone within a process; tests inject a fake |
| `HostServices` | `stateOf`, `registerTool`, `registerProjection`, `registerSection`, `onHook` | a missing service is reported once and the plugin deactivates cleanly (no partial registration) |

`ports/compaction-shim.js` is the **only** module that imports `@deepseek-ai/dsh-compaction-basic`, uses
`createRequire`/`loadHostModule`, or builds a shim context. `ports/compaction-native.js` is a stub with
the same contract, ready for the upstream API (docs/07 Q5's framing request is the same proposal).

## 8. Durability and the audit

The journal stays the only source of truth, and `tool/result.meta` stays the only write channel. Three
changes:

1. **Versioned meta.** `meta = { tf: 1, ... }`; the journal gateway drops any meta whose `tf` is not
   `META_TAG` *before* the reducer sees it. Today the check sits inside `onBegin`/`onEnd` and the guard
   against a foreign `stateVersion` had to be added after T1 found its absence.
2. **Journal gateway.** `domain/journal.js` exports `classify(event)`: `surface | task-result | compaction
   | header | hint | ignore`. It rejects an impossible `seq` (negative, non-integer) once, for all
   consumers, instead of a guard in the reducer.
3. **Summary source.** The host records our summary unmarked (we hand it prepared blocks), so the
   audit cannot rely on `llmStreamCall`. The plugin keeps `source: 'self' | 'delegate'` in
   `SummaryResult` and logs it; `verify-cache.js` keeps classifying by `usage` presence — the one
   observable fact — and the docs say why. This is not a workaround but the strongest available
   contract until the host lets a plugin mark a summary.

## 9. Tools and their meta

Each tool is a small module: `{ name, description, parameters, execute(ctx) }`, where `execute` returns
`{ text, meta? }` and `meta` is built by `tools/meta.js` — the only writer of `tf` payloads. The tool
receives a `stateOf` adapter (not a raw projection handle), so the async registration of the projection
is invisible to it (today `projection.handle` is a `Promise` and every consumer knows it).

`tools/meta.js` also owns the rule that a `task_end` payload is written *after* the verdict is
computed, so a `task_end` whose summary is unusable still records `summaryChars` and `callId` — the
behaviour the T4 suite pinned.

## 10. Prompt and hints

`prompt/section.js` composes the section from named parts (`protocol`, `begin`, `end`, `recall`,
`discipline`) and asserts the byte budget per part, so a change names the part it grew. The budget test
compares the rendered section, not a constant.

`prompt/hints.js` is pure: `(state, runtime, settings) → { key, message } | null`, with the latch in
the projection (`state.hintKey`) as today. Two rules, one module:

- **age** — the innermost open task at `staleTaskSteps × {1,2,4}` (the numbers in the design are
  examples, not literals);
- **empty span** — a task that closes with `spanStart` after `endCut` because the begin batch carried
  the work (Q15), hinted once at closing, keyed by task and reason.

The implicit turn fold (03 §5.6, 07 Q10) is now the answer to forgotten discipline, so the prompt
does not gain a "start a task" nag: the hint stays for the model case — a task that is open and
unfinished — and a turn that ends without any task is handled silently by the plugin instead.

## 11. Client

`client/module.js` loads, `client/client.dock.js` and `client/client.settings-card.js` register through
slots. `locale/en.json` is the single source: a build step emits `client.locale.generated.js`, and a test
asserts the generated dictionary equals the JSON. Today the same 22 keys are maintained twice and a test compares
the two copies — a test that compensates for a missing generator.

The dock reads the projection through `useProjection('taskFolding')` only; the settings card reads and
writes through the same service the host uses for bundle config, and its E2E check (docs/09 T6) closes
F7 by writing a value and proving it survives a restart.

## 12. Failure transitions (the table the runtime must never violate)

| Situation | State transition | Durable effect |
|---|---|---|
| Engine unavailable | plugin inactive, one log line | none |
| No `llm` service | tasks stay `waiting`; no generation | none |
| Generation throws / rejects | `failed`; `attempts += 1` | one `compaction/end{error}` per attempt |
| `attempts` reaches the cap | `failed` terminal | none further |
| Aborted turn | `cancelled`; `attempts` unchanged | none |
| Surface moved under the generation | `stale`; generation dropped | none |
| Compaction lock held | `busy` → one retry in the pass → `waiting` | none |
| Region unbalanced | `skipped` **for this epoch** | none |
| Journal meta foreign / seq impossible | event ignored by the gateway | none |
| Logger throws | swallowed by the port | none |

The last two lines are the T1/T3 lessons: the journal is untrusted input, and diagnostics are not
allowed to decide behaviour.

## 13. Every known defect and where the design closes it

| Defect (found in) | Root cause it exposed | Closed by |
|---|---|---|
| Region key included the surface length; every generated summary was discarded (M5) | no identity for the node list | §4.1 `SurfaceSnapshot.epoch` — the key cannot encode the wrong thing because it does not exist |
| F9: state read once, surface moved during the pass, task skipped for the process (T4) | a transient inconsistency was made permanent | §4.1 + §6: a commit compares epochs; `stale` is a transition, and a skip is epoch-scoped |
| Fold summary had no `usage`, cache-hit unmeasurable (M5) | a contract grew a field after it shipped | §4.3 `FoldRequest`/`SummaryResult` carry `usage` and `source` from the start |
| `foldRegion` took seven positional arguments (M5) | same | §4.3: one object |
| The logger threw and replaced the original error, rejected the hook (T3) | a diagnostic treated as infallible | §7 `LogPort` guarantee "never throws" |
| An aborted generation counted toward the durable cap (T3) | cancellation modelled as failure | §6 and §12: `cancelled` is its own transition, `attempts` untouched |
| A missing projection service threw a `TypeError` mid-registration (T1) | partial registration | §7 `HostServices`: a missing service deactivates cleanly and disposes what was registered |
| `meta` written under a foreign `stateVersion` was applied as ours (T1) | the version check sat inside two reducers | §8 journal gateway: one check before the reducer |
| An impossible `seq` became a cut (`-1` is `ABSORBED`) (T1) | the reducer trusted its input | §8 journal gateway rejects it once, for all consumers |
| `exports["./client"]` pointed at a missing file; the client vanished silently (M6) | a manifest read only by the host | docs/09 T0 (`test/manifest.test.js`, `pack:check`) — found and pinned, not an architecture change |
| Settings written from the card did not persist (F7, unconfirmed) | the write path was never exercised live | docs/09 T6 E2E writes a value and proves it survives a restart |
| The dock's injected client package is undeclared (F8) | client-graph dependency invisible to the package | a declared dependency check in the manifest test, plus the T6 render check |
| Two handlers on `agent/pre-step` could disagree (M6) | a concern added beside another instead of inside | §5 one orchestrator |
| Prompt line needed for `task_begin` discipline (Q15) | the model could pack begin with the work | §10 empty-span hint at closing, plus the prompt line |
| Buckets had to be scaled (Q15/M6) | the design pinned both a threshold and literal numbers | §10: thresholds only |
| Two copies of 22 locale keys (M6) | the bundle cannot import JSON | §11 generated dictionary, with the equality test kept as a regression guard |
| `deferLoading` hid `fold_recall` from the model (M7) | the host cannot load a deferred baseline tool | not architectural: the flag stays off; §15 asks the host for a load path |
| A head-of-history checkpoint preamble framed a mid-history fold (Q5) | host constant | §15 upstream ask, behind a port that can swap framing when the host allows |

Two entries are deliberately *not* architectural: a manifest typo and a host limitation are not fixed by
structure, and pretending otherwise would be the same mistake as patching the seams.

## 14. What is deleted or rewritten

The left column records the tree as it was before migration step 8; the right column is the fate each
file actually had. Paths in the left column no longer exist.

| Before step 8 | Fate | Why |
|---|---|---|
| `host/fold-runner.js` (743) | **deleted**, split into `runtime/session-runtime.js`, `runtime/scheduler.js`, `runtime/generation.js` | seven WeakMaps and a string region key; F9 lives here |
| `host/engine-adapter.js` (187) | **deleted**, split into `ports/compaction.js` + `ports/compaction-shim.js` | the host boundary was mixed with fold logic |
| `host/index.js` (239) | **rewritten** as `plugin/mount.js` + `plugin/pre-step.js` | two concerns on one hook, `projection.handle` leaking everywhere |
| `host/tools.js` (332) | **split** into `tools/*` + `tools/meta.js` | three tools and the meta writer in one file |
| `host/recall.js` (544) | **kept** as `tools/recall.js`, imports `domain/` only | the caps and formatting are behaviour, not seams |
| `host/projection.js` (610) | **kept**, gains `surfaceEpoch`, moves `surface` bookkeeping to `domain/surface.js` | the reducer was right; the surface version was missing |
| `host/cuts.js`, `planner.js`, `estimate.js`, `settings.js`, `texts.js` | **kept** (renamed into `domain/`) | pure and property-tested; 100 % coverage |
| `host/hints.js` | **kept**, gains the empty-span rule | pure |
| `host/summarizer.js` | **kept** as `ports/llm.js` internals | request building is behaviour worth keeping |
| `host/resolve.js` | **kept** as `ports/host-services.js` internals | the `createRequire` path is the shim's detail |
| `client/client.js` (506) | **split** into `module.js` + `client.dock.js` + `client.settings-card.js` + generated locale | two slots and the dictionary in one file |
| `scripts/*` | **kept** (eval-report, verify-cache, mutate, check-pack, contract-check), plus new `e2e-headless.js` | the tooling proved itself |

Estimated shape: domain ≈ 2 300 lines (kept), ports ≈ 450, runtime ≈ 650, tools/prompt ≈ 800,
plugin ≈ 300, client ≈ 400 — roughly the same total, with every seam named.

## 15. Upstream asks (M8, and now earlier)

These are the three places where the plugin pays for a contract the host does not offer. Each has a
port, so the ask is a swap, not a rewrite:

1. **`compaction.fold(request)` for prepared blocks** — the plugin already has the summary; the host
   wraps it. Today this needs a subclass of `BasicCompactionEngine` behind a shim context.
2. **A summary marker** (`source: 'self' | 'llm'`, or honouring `llmStreamCall` on prepared blocks) —
   makes the cache audit independent of `usage` presence.
3. **A framing field** (Q5) — so a mid-history fold can say where it sat, instead of inheriting the
   head-of-history preamble.

## 16. Migration plan

Each step is independently releasable and each keeps the live suite green:

| Step | Change | Fixes | Risk | State |
|---|---|---|---|---|
| 1 | `ports/logger.js`, `ports/clock.js`; every runner log goes through the port | T3 logger | none | **done** (`9b74d0d`) |
| 2 | `SurfaceSnapshot` with `surfaceEpoch` in the projection, threaded through the scheduler | groundwork | low | **done** (`9b74d0d`) |
| 3 | Epoch-bound snapshots replace the stale reads; a skip is keyed by the epoch it was decided at | **F9**, M5 region-key defect | medium | **done** (`9b74d0d`; `test/f9-surface-epoch.test.js` is the acceptance test) |
| 4 | Fold the seven WeakMaps into `SessionRuntime` with a pure `reduce`; property-test the transitions | structural debt | medium | **done** (`test/runtime.test.js`, reducer at 100 % lines / 98 % branches) |
| 5 | `FoldRequest`/`SummaryResult` objects; `usage` and `source` in the contract | M5 usage, audit clarity | low | **done** |
| 6 | `engine-adapter` split into `ports/compaction.js` + `ports/compaction-shim.js` + `compaction-native.js` stub; the adapter file is deleted | host boundary | low | **done** |
| 7 | One `plugin/pre-step.js` orchestrator; the empty-span hint (Q15); generated client locale | Q15 hint, F7 groundwork | low | **done** |

| 8 | The §3 module tree: `domain/` (including `journal.js`, `surface.js`, `verdict.js`), `ports/host-services.js` and `ports/llm.js`, `runtime/scheduler.js` + `runtime/generation.js`, `tools/*`, `prompt/`, `plugin/mount.js` + `plugin/index.js`, and the client split; `fold-runner.js`, `tools.js`, `resolve.js`, `summarizer.js`, `hints.js`, `recall.js` deleted from their old paths | structural debt only | low | **done** |

All eight steps are implemented. Step 3 was first because it closes the only known behavioural defect
(F9), and it is what makes step 4's transitions testable: the runtime's `reduce` compares epochs, so
"commit after the surface moved" is a legal transition rather than a race. Step 8 was a rename: every
moved module kept its exported names, JSDoc and behaviour, and the 393-test suite, typecheck, lint,
coverage, perf and pack checks all stayed green across the move.

## 17. Acceptance

The target architecture is reached when every line below holds. State as of 2026-11-22:

| Criterion | State |
|---|---|
| Every host import is inside `ports/` (a lint rule, not a habit) | **Met** — `eslint.config.js` restricts `@deepseek-ai/*` imports to `host/ports/**` (type-only references are JSDoc and invisible to the rule); `ports/host-services.js` is the only module calling `ctx.tools`, `ctx.sessionProjections`, `ctx.systemPrompt`, `ctx.get`, `ctx.tokenMeter` and `ctx.logger` |
| No module outside `runtime/` keeps per-session state | **Met** for fold scheduling: one `WeakMap<session, SessionRuntime>` in `runtime/scheduler.js`; the runtime and its reducer are pure |
| An epoch is part of every region resolution and every commit (F9 acceptance) | **Met** — `domain/surface.js` + `test/f9-surface-epoch.test.js` |
| `foldRegion` no longer exists; `FoldRequest` carries `usage` and `source` | **Met** — `CompactionPort.fold(FoldRequest)`; `SummaryResult.source` is recorded, and the delegate commit logs it once (`runtime/generation.js`) |
| Mutation score ≥ 85 % on `domain/`; the coverage gate covers `host/**/*.js` | **Met**: the gate covers every `host/**/*.js` (99.9 / 94.0 / 98.4) and `npm run mutation` targets `domain/cuts.js`, `domain/projection.js`, `domain/planner.js`; the score is recorded in `docs/06` after the rename |
| F9, F7 and F8 acceptance; docs/09 T5/T6 E2E green | **F9, F7 and F8 done**; T6 done (`scripts/e2e-browser.js`, 10/10); T5, T7 and T8 not started |

The **module tree of §3 is the tree on disk** since step 8. What is still missing from the acceptance list
is not structural: F7 and F8 (live settings persistence and the declared client-graph dependency) and the
T5/T6 E2E checks. The `client.` prefix on the two component chunks is the host's chunk contract, recorded
in §3, not a leftover of the old single file.
