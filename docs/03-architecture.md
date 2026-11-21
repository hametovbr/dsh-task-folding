# 03 — Architecture

This document is the design the implementation follows. Host APIs are referenced by the section numbers of [02-host-api.md](02-host-api.md). Decisions with real alternatives have ADRs in [adr/](adr/).

## 1. Goals and non-goals

**Goals**

1. The model marks finished units of work; each unit leaves the surface as one short titled summary.
2. Folding never blocks the agent or the user's next message noticeably (commit p95 < 100 ms per step; summary generation, when needed, runs in the background).
3. All plugin state is derived from the session log; fork, resume and replay need no plugin-side storage.
4. Originals are recoverable exactly, from the log only.
5. The protocol the model must follow is small: three tools, at most ~850 tokens (3,400 characters) for the prompt section and all tool schemas together, and one guidance line — call `task_begin` in its own message — that nothing enforces: a `bash` call in the same batch is legal, it simply falls outside the span.
6. Per-step cost does not grow with log length.

**Non-goals**

- Replacing the host's token-pressure compaction. It stays the safety net; the two coexist through the compaction lock.
- Cross-session memory. Memory plugins work at a different layer.
- Pruning individual tool outputs. Pruners (`dsh-compaction-tool-result-pruner` and community ones) compose with this plugin.

## 2. Concepts

### 2.1 Batch

A **batch** is one `assistant/message` plus the `tool/result` of every `tool-call` block it carries. A batch is **complete** when every call id has a result. Until then, pairing is unbalanced at any position inside the batch.

### 2.2 Cut

A **cut** `after(s)` is the boundary immediately after surface node `s`, where `s` is the last node of a complete batch (the last result, or the message itself if it carried no calls). A cut after a complete batch is tool-pairing balanced by construction, on both sides.

### 2.3 Task

A **task** is the half-open surface interval `(beginCut, endCut]`:

- `beginCut` — the cut after the batch that carried `task_begin`;
- `endCut` — the cut after the batch that carried `task_end`.

Consequences:

- The `task_begin` call message stays on the surface as the task's bookmark; everything after it up to and including the closing batch is the span.
- `task_end(A)` and `task_begin(B)` in one batch give `endCut(A) == beginCut(B)`: adjacent, non-overlapping intervals. There is no "one task-mark call per message" rule. ([ADR 0002](adr/0002-cuts-not-anchors.md))
- The user-facing report may be written before, alongside, or after `task_end`. No message-shape rules exist.

### 2.4 Cut translation

When a surface `replace` commits (our fold, the host's auto compaction, a pruner), a tracked cut `after(s)` is affected only if `s` is in the replacement's `sourceEventSeqs`:

- `s` is the **last** shadowed node (`s == surfaceOp.endSeq`) → the cut moves to `after(R)`, where `R` is the replacement node's seq;
- `s` is shadowed anywhere else → the cut is **absorbed**: the boundary no longer exists on the surface.

The projection applies this to every tracked cut on every replacement event. Translation is O(tracked cuts) per replacement and needs no surface access, so it stays inside the pure projection.

### 2.5 Verdicts

Every closed task gets exactly one terminal or pending verdict:

| Verdict | Meaning | Set by |
|---|---|---|
| `queued` | Self-summary accepted; fold when due | `task_end` meta |
| `delegate` | No usable self-summary; fold via the summarizer fallback | `task_end` meta |
| `below-floor` | Span smaller than `minSpanTokens`; never folds | `task_end` meta |
| `absorbed` (at close) | The task's start was already swallowed by another compaction | `task_end` meta |
| `merged` | Closed implicitly because its parent was closed; covered by the parent's fold | `task_end` meta (parent) |
| `folded` | Our fold committed | projection, on the replacement event |
| `absorbed` | A cut or the span was swallowed by another replacement | projection, on cut translation |
| `failed` | Delegate gave up after the durable failure cap | projection, from `compaction/end{error}` count |

`queued` and `delegate` are the only non-terminal verdicts. Every verdict is derivable from the log, so the same rows exist after a restart with no in-memory registry.

## 3. Components

```
host/
  index.js            plugin object: inject, Config, apply()
  projection.js       pure reducer + schema + wire view           (no ctx, no I/O)
  cuts.js             cut translation helpers                      (pure)
  planner.js          due-task selection and region resolution     (reads surface)
  tools.js            task_begin / task_end / fold_recall          (execute + render + meta)
  fold-runner.js      runs due folds from pre-step / turn-stopping; delegate scheduling
  ports/compaction-shim.js the ONLY module touching dsh-compaction-basic internals
  ports/compaction.js the port (fold/reject/classify); ports/logger.js, clock.js
  summarizer.js       delegate path: prefix-anchored request, instruction, validation
  recall.js           index, range, grep over a fold's shadowed messages
  hints.js            stale-task hint, durable latch
  estimate.js         span token estimate via ctx.tokenMeter.estimateMessage
  settings.js         Config schema and safe readers
client/
  index.js            dock + settings card
```

Dependency direction: `projection`, `cuts` are leaves; `planner`, `recall`, `hints`, `estimate` read the projection and the session; `tools` and `fold-runner` orchestrate; only `ports/compaction-shim` and `summarizer` know about compaction internals or the LLM.

## 4. Data model

### 4.1 `meta` payloads (durable, written by the tools)

Every successful `task_begin` / `task_end` result carries `data.meta` with a version tag. Failed calls carry no meta and change no state.

```ts
type BeginMeta = {
  tf: 1; op: 'begin'
  id: string            // 'T7' — unique within the session (see 6.1)
  title: string
  parent: string | null // innermost open task at execute time
}

type EndMeta = {
  tf: 1; op: 'end'
  id: string                       // the task being closed
  merged: string[]                 // open descendants closed with it (verdict 'merged')
  verdict: 'queued' | 'delegate' | 'below-floor' | 'absorbed'
  outcome: 'done' | 'failed' | 'abandoned'
  estTokens: number                // span estimate at execute time (-1 = unknown)
  summaryChars: number             // 0 when absent
  callId: string                   // this task_end call's id, to locate the summary argument
}
```

The summary text itself is NOT copied into meta: it already lives in the `task_end` call arguments inside the `assistant/message`, and that message is inside the span, so it is shadowed together with everything else. The projection stores a pointer.

### 4.2 Projection state

Key `taskFolding`, `stateVersion: 1`. The authoritative typedefs are in `host/types.js`; this is a summary.

```ts
type State = {
  nextId: number                   // highest numeric id seen + 1
  open: string[]                   // stack, outermost first
  tasks: Record<string, Task>
  order: string[]                  // task ids in creation order
  batch: Batch | null              // the in-flight batch IF it carries one of our calls
  assistantCount: number           // running count of assistant/message events (task age)
  folds: FoldRow[]                 // every compaction/summary in log order (recall index)
  pendingSummary: number | null    // index of a FoldRow whose replacement has not arrived yet
  hintKey: string | null           // durable latch for the stale-task hint
  lastHeaderSeq: number | null     // latest request/header (tools + config for delegate requests)
}

type Task = {
  id: string; title: string; parent: string | null; depth: number
  status: 'opening' | 'open' | 'closing' | 'queued' | 'delegate'
        | 'below-floor' | 'merged' | 'folded' | 'absorbed' | 'failed'
  beginCut: number | null          // last node of the begin batch; null until it closes; -1 = absorbed
  spanStart: number | null         // first surface node after the begin batch; same encoding
  endCut: number | null            // last node of the end batch; same encoding
  endMsgSeq: number | null; endCallId: string | null   // where the summary argument lives
  verdict: EndVerdict | null       // from task_end meta; applied when the end batch closes
  outcome: Outcome | null; estTokens: number; summaryChars: number
  openedAt: number                 // assistantCount when the begin batch closed
  reported: boolean                // an assistant/message arrived after the end batch closed
  failures: number                 // compaction failures seen while waiting as 'delegate'
  foldIndex: number | null         // index into folds once folded
}

type Batch = { msgSeq: number; waiting: string[]; last: number; begins: string[]; ends: string[] }

type FoldRow = {
  summarySeq: number               // the compaction/summary event (has shadowedSeqs)
  nodeSeq: number | null           // the replacement user/message
  taskId: string | null            // set when the replacement covers exactly a waiting task's span
  shadowedCount: number; shadowedTokens: number
}
```

`spanStart` is tracked explicitly so that a fold can be recognized structurally: a replacement whose `surfaceOp.startSeq === spanStart` and `surfaceOp.endSeq === endCut` is that task's fold, whoever committed it. This keeps the reducer away from summary text (AGENTS.md rule 2).

Size: `folds` grows by one row per compaction (tens per long session); `tasks` by one row per task. Terminal tasks MAY later be compacted to `{id, title, status, foldIndex}` to keep checkpoints small.

### 4.3 Reducer

`apply(state, event)` — pure, synchronous, returns the same reference when nothing changes. Implementation: `host/projection.js`.

| Event | Transition |
|---|---|
| any surface event with `surfaceOp.op === 'replace'` | Handled by the replace row below and nothing else (in particular, its `meta` is never read). |
| `assistant/message` | Force-close an in-flight batch (interrupted). Note a surface append (below). `assistantCount += 1`; mark every waiting task `reported`. If the message carries a call named `task_begin` or `task_end`, open `batch = { msgSeq: seq, waiting: [all call ids], last: seq, begins: [], ends: [] }`. |
| `tool/result` (append) | Note a surface append. If the result answers a call in `batch.waiting`: remove it, `last = seq`, and read `data.meta` if it has `tf: 1`: `begin` creates the task (`status: 'opening'`, pushed onto `open`, added to `begins`, `nextId = max(nextId, n + 1)`); `end` sets the target and its open `merged` descendants to `closing`, removes them from `open`, stores `endMsgSeq`, `endCallId`, verdict fields, adds them to `ends`. When `waiting` becomes empty, close the batch. Meta on a result outside the batch, malformed meta, a duplicate id, or an end for a task that is not open is ignored. |
| `user/message`, `system/message` (append) | Note a surface append. A `user/message` with `data.source.kind === 'task-folding:hint'` sets `hintKey = data.source.key`. (`user/message` data is the message itself.) |
| surface append (internal) | Every `open` task with `spanStart === null` gets `spanStart = seq`. |
| `step/end` | Close an in-flight batch. |
| batch close (internal) | `begins`: `beginCut = last`, `openedAt = assistantCount`, `opening → open`. `ends`: `endCut = last`, then the status: merged descendants (no verdict) → `merged`; meta verdict `below-floor`/`absorbed` → that; begin cut absorbed → `absorbed`; no span (`spanStart === null`, i.e. begun and ended in one batch) → `below-floor`; otherwise the meta verdict (`queued` or `delegate`). |
| `compaction/summary` | Push a `FoldRow` (`nodeSeq: null`, `taskId: null`); `pendingSummary = its index`. |
| replace (`surfaceOp.op === 'replace'`) | `S = set(sourceEventSeqs)`. If the event is a `user/message` and a fold row is pending, this is its node. For each non-terminal task: if the row is pending, the task is waiting, and `startSeq === spanStart && endSeq === endCut` → `folded` (row gets `taskId`, `nodeSeq`). Otherwise translate `beginCut`/`endCut` (2.4, "after") and `spanStart` ("first": survives only if the range starts exactly at it); a waiting task with any boundary absorbed → `absorbed`; an open task keeps running and closes `absorbed`. |
| `compaction/end` with `data.error` | Every `delegate` task: `failures += 1`; at `MAX_DELEGATE_FAILURES` (3) → `failed`. |
| `request/header` | `lastHeaderSeq = seq`. |
| anything else | unchanged (same reference) |

Notes:

- **Replacement `tool/result`s MUST NOT be read for `meta`.** The tool-result pruner's replacement keeps the original result's `meta` (observed in M0), so reading it would re-apply a `begin`/`end`.
- `tool/ptc-dispatch` events are ignored: task tools refuse nested calls (6.1), so no task `meta` can appear there.
- Results of one batch arrive in call order (the native executor is sequential, M0 Q9); the reducer does not depend on that order.
- An interrupted step is closed by the host's session repair with synthetic error results for unanswered calls, then `step/end` (`openTurnClosers`, `packages/core/session/src/repair.ts`); the batch therefore completes normally. Force-closing on the next `assistant/message` only guards odd logs.
- A fold that commits while a batch is in flight cannot happen: commits run only at step boundaries (`pre-step`, `turn-stopping`), never between a call and its result.
- Counting every `compaction/end{error}` against every `delegate` task over-counts when unrelated compactions fail. That bias is deliberate: it can only stop retries earlier, never re-bill forever ([ADR 0005](adr/0005-durable-state-only.md)).

### 4.4 Wire view

```ts
type View = {
  open: { id: string; title: string; depth: number }[]   // stack order
  folding: { id: string; title: string }[]               // queued/delegate, due or not
  recent: { id: string; title: string; status: 'folded' | 'below-floor' | 'merged' | 'absorbed' | 'failed' }[] // last 5
}
```

`view` MUST return the same object reference when these lists did not change (memoize on the relevant state sub-references).

## 5. Fold planning and execution

### 5.1 When a task is due

A `queued` or `delegate` task is **due** when it is `reported` (the model has produced at least one message after the closing batch — usually the report, written with the span still in context), or when the turn is stopping. Seq comparisons are not used: cut translation can move a cut to a later seq. Due tasks are processed inner-first: by `depth` descending, then by `endCut` ascending (close order).

### 5.2 Region resolution (`planner.js`)

The region is `spanStart..endCut`. The planner checks it against the current surface and refuses anything inconsistent:

```js
function resolveRegion(task, nodes) {
  if (any boundary === ABSORBED) return { kind: 'absorbed' }
  if (beginCut === null || endCut === null) return { kind: 'inconsistent', reason: 'cuts not set' }
  if (spanStart === null) return { kind: 'empty' }
  const b = nodes.indexOf(beginCut), i = nodes.indexOf(spanStart), j = nodes.indexOf(endCut)
  if (b === -1 || i === -1 || j === -1) return { kind: 'inconsistent', … }
  if (i !== b + 1) return { kind: 'inconsistent', reason: 'span does not start after its begin cut' }
  if (i > j) return { kind: 'empty' }
  return { kind: 'fold', start: spanStart, end: endCut, startIndex: i, endIndex: j }
}
```

`inconsistent` is a bug signal (never produced by the property tests); the runner logs it once and skips the task for the process.

Before committing, the runner MUST check `toolPairingBalancedBefore(session, start)` and `toolPairingBalancedAfter(session, end)` when the helpers are resolvable; a failure is a bug (cuts are balanced by construction), reported once and the task marked unfoldable in memory for this process.

`indexOf` over the surface is O(surface), not O(log); the surface is bounded by folding itself. The runner caches `nodes` positions per `surface.replaceGeneration` + `nodes.length`.

### 5.3 Self-summary fold (default path)

Runs inline in `agent/pre-step` (before `next()`) and in `agent/turn-stopping`, because it costs milliseconds:

1. Read the summary: `session.eventAt(task.endMsgSeq)` → the `tool-call` block with `id === task.endCallId` → parse `arguments` → `summary`.
2. Build the node text (7.3).
3. Call the port: `engine.fold({ agent, region: { startSeq, endSeq }, blocks, route, usage, signal })` on the compaction port, whose shim `summarize()` returns the prepared blocks without an LLM call ([ADR 0004](adr/0004-engine-adapter.md)).
4. On success: nothing else to do — the projection observes the replacement and marks `folded`.
5. On a busy lock (`ManualCompactionError` code `busy`): stop this pass and retry at the next boundary (no cost, no log).
6. On the host's shrink refusal (a plain `Error` whose message starts with "summary is not smaller than the shadowed content" — this entry path does not wrap errors, `docs/02` §6): mark the task unfoldable for this process and skip it. The size pre-check in the runner should make this rare.
7. On any other error: log once per task, retry at the next boundary with in-memory backoff (1, 2, 4, 8 boundaries). Self folds are free, so there is no durable cap.

The runner re-reads the task from the projection after every committed fold: the fold of an inner task moves the outer task's cuts, and a stale `Task` object would resolve to a region whose boundary is no longer on the surface.

### 5.4 Delegate fold (fallback path)

For tasks with verdict `delegate` (no or unusable self-summary) and for self folds demoted in 5.3 step 6. Delegate folds are **two-phase**: the summary is generated in the background, then committed exactly like a self fold ([ADR 0006](adr/0006-background-delegate.md)).

**Phase 1 — generate (background, nothing waits for it).**

- Started by the runner when a delegate task becomes due, from `pre-step` or `turn-stopping`, as an un-awaited promise. At most one generation per session at a time; others wait their turn.
- The runner snapshots the region `(start, end)` and a key over exactly the seqs the region covers at start; the key is recomputed before commit, and a mismatch drops the generated text (a later boundary regenerates it). The key deliberately ignores everything outside the region: the model keeps appending messages while the summary is generated, and a node added after the span makes neither the text stale nor the provider prefix wrong.
- The request is taskfold's prefix-anchored envelope, corrected: the surface prefix (which begins with the in-history `system/message`) + the span + the instruction as the final user message; `tools` and `config` from the latest `request/header` (`state.lastHeaderSeq` → `eventAt`); `toolHistory: session.toolHistory()`; provider/model from (settings override → header config → agent options). Same prefix as the main requests, so the provider cache is reused.
- The instruction (7.2) includes a numbered span index and a size budget.
- Output validation: non-empty text that opens with a `## ` section after at most 3 short preamble lines, and is smaller than `maxSummaryRatio` × span. A failure counts as an attempt.
- The finished text is held in memory: `pending[taskId] = { blocks, regionKey, usage }`.

**Phase 2 — commit (fast, at the next step boundary).**

- At the next `pre-step` or `turn-stopping`, if `pending[taskId]` exists and the task's region still resolves to the same `start`, `end` and node list, commit through the adapter with the prepared blocks (5.3 steps 3–7). If the region changed, drop the text and regenerate later.

**Failure accounting.** A failed generation never reaches the compaction engine, so the host would not record it. To keep the cap durable (ADR 0005), the runner records each failed generation as a zero-cost failed attempt: `compactRegion` on the task's region with a `summarize()` that rejects immediately (`CompactionPort.reject` in `ports/compaction.js`, shim in `ports/compaction-shim.js`), which makes the host append `compaction/start` + `compaction/end{error}`. The reducer's existing `compaction/end{error}` row then counts it. After `maxDelegateFailures` (3) the task is `failed` and is never retried, across restarts. The record is written only when the region still resolves; an error from writing it is logged once and never retried in a loop.

**Restart.** A generated-but-uncommitted text is lost on restart and is regenerated (one extra billed call at most per restart per task). Generation never holds the compaction lock, never blocks a step and never holds the user's next message.

### 5.5 Interaction with host auto compaction

- Both go through the durable `compaction/start`…`compaction/end` lock. A `busy` answer is not an error: the runner re-reads the state and retries the same task once within the same boundary pass, because the other transaction usually finishes in milliseconds. If the retry is busy too, the pass stops, the task stays `queued` for the next boundary, and one line per task is logged for the process.
- Auto compaction cuts from the head of history. If it shadows part of a task, cut translation (2.4) yields `absorbed`, the task's own fold is skipped, and the auto checkpoint covers that content. A task can therefore close `queued` and later read `absorbed` without any fold of its own; that is the designed outcome of losing the race, not a bug.
- In practice the host's own engine is mounted before this plugin, so its hook runs first at a boundary; the contention case is real and was observed live in M3 (`m3/REPORT.md` §7.2).
- The plugin MUST NOT modify the host's compaction instruction or wrap `ctx.llm.stream` (the taskfold anti-pattern).

## 6. Tools (behavior)

Exact schemas and texts: [04-tools-and-prompt.md](04-tools-and-prompt.md).

### 6.1 `task_begin({ title })`

- Refuse nested PTC calls (`exec.callId !== exec.rootCallId`; for direct calls both equal the call's own id — M0 Q1): "call task_begin directly, not from run_code".
- Assign `id = 'T' + state.nextId`. The native executor runs one message's calls sequentially and commits each result before the next call starts (M0 Q9), so a second `task_begin` in the same batch already sees the first one's id. As a cheap guard against a future concurrent executor, also keep an in-memory per-session high-water mark and use `max(state.nextId, reserved)`.
- `parent` = innermost id of `stateOf(session).open` at execute time. Because each result is committed before the next call of the batch starts (M0 Q9), a second `task_begin` in the same message *does* see the first task open and becomes its child; closing the parent merges it. Verified live in M2.
- Returns `{ ok: true, id, title, parent, depth }`; meta `BeginMeta`.

### 6.2 `task_end({ summary, id?, outcome? })`

- Refuse under PTC.
- Target: `id` if given and open, else the innermost open task. Unknown id → error listing open ids. No open task → error.
- Open descendants of the target are closed with it as `merged` (no LIFO refusal).
- If any tracked boundary of the target was absorbed (2.4) — another compaction swallowed where the task began — the verdict is `absorbed` with `estTokens: -1`, and the result tells the model the task closed without a fold of its own.
- Estimate the span: `estimate.js` sums `ctx.tokenMeter.estimateMessage(session.deriveEventMessage(session.eventAt(n)))` over surface nodes after `beginCut` up to the current tail. If the target is still `opening` (begun in this same batch), the span is empty → `below-floor`.
- Verdict:
  - `estTokens < minSpanTokens` → `below-floor`;
  - `summary` shorter than `minSummaryChars` (default 200) or estimated summary tokens > `maxSummaryRatio` × `estTokens` (default 0.5) → `delegate` if `delegateEnabled`, else `queued` (and the host's "not smaller" check is the last guard);
  - a usable summary whose fold would save less than the floor — `estTokens − summaryTokens < minSpanTokens` — → `below-floor`. The span includes the `task_end` message, and its arguments carry the summary, so a verbose summary would otherwise inflate the estimate and push a small task over the floor (observed in M2: a three-read task measured 1,999 tokens, much of it its own and its subtasks' summaries). With `maxSummaryRatio` ≤ 0.5 this rule only bites for spans between the floor and about twice the floor;
  - else `queued`.
- Returns `{ ok: true, id, verdict, merged, remaining }`; meta `EndMeta`.

### 6.3 `fold_recall({ task?, fold?, from?, to?, grep?, page? })`

All reads are from the log; nothing is written.

| Arguments | Result |
|---|---|
| none | Fold tree: one line per `FoldRow` (`#N T7 · title · M msgs · ~K tokens`), nested folds indented under the fold that shadowed them |
| `task` or `fold` | The span index: one line per shadowed message (`L<N> <role> <brief>`), max 200 lines per `page`; shadowed fold nodes shown as `L<N> [fold #k T5 "title"]` |
| + `from`, `to` | The exact original messages `L<from>…L<to>` (max 20 messages, total output capped at ~40k characters with an explicit truncation note) |
| + `grep` | Matching lines `L<N>: …context…` (case-insensitive substring or `/regex/`), max 50 hits |

Resolution: `folds[i].summarySeq` → `eventAt(summarySeq).data.shadowedSeqs` → `deriveEventMessage(eventAt(seq))`. O(span), no log scan.

## 7. Texts

`fold_recall` is deliberately **not** deferred: the host's `deferLoading` saves its ≈ 208-token schema, but in 0.2.2-rc.5 a deferred tool registered before the first request never receives the `tool_addition` block that would load its definition, and a live run showed the model then not calling it at all (07 Q6). Recall is worth more than 208 tokens.

### 7.1 System-prompt section

A single `ctx.systemPrompt.section({ name: 'task-folding', order: 650, text })`. Draft and token budget in [04](04-tools-and-prompt.md#3-system-prompt-section).

### 7.2 Delegate instruction

Condensed from taskfold's v2 instruction, with three changes: a size budget ("aim for 5–10% of the span, at most ~1,500 tokens"), an explicit rule for nested fold nodes ("messages wrapped in `<compacted-summary>` are earlier folds of subtasks: keep their conclusions, do not re-narrate them"), and no demand for a `why:` on every bullet.

### 7.3 Fold node format

The host frames every summary with its checkpoint preamble and `<compacted-summary>` tags. Inside, the plugin writes:

```
# T7 · Fix login redirect loop
<summary text as written by the model, or by the delegate>

— fold of T7 · 42 messages · ~18.4k tokens · outcome: done · originals: fold_recall({ task: "T7" })
```

The heading is for the model only. The projection recognizes a fold structurally (4.2), never by its text.

## 8. Hints

One hint only: the innermost open task has been open for `staleTaskSteps` (default 25) or more assistant messages.

- Text: `Task T7 "<title>" has been open for 25+ steps. If it is finished, call task_end with a summary; if it has distinct parts, wrap the remaining parts in nested tasks.` Buckets at `staleTaskSteps`, twice and four times it — at the default threshold 25 that is 25, 50 and 100 steps; the text is byte-stable within a bucket, and scaling the buckets keeps the number truthful when the threshold is configured to something else.
- Delivered by rewriting the pre-step decision: `{ ...decision, messages: [...decision.messages, hintMessage] }` with `source: { kind: 'task-folding:hint', key: '<id>:<bucket>' }`.
- Latch: the projection records the last hint key; a hint is published only when its key differs. The latch is durable, so restarts do not re-publish.
- No "no open task" hint (see 01, issue 11). An optional implicit per-turn task (open question, off by default) is the answer to forgotten discipline, not nagging.

Age is `assistantCount - task.openedAt`, both maintained by the projection in O(1).

## 9. Client

- **Dock** (`conversation.input.dock` — renders on the home screen and in conversations, unlike `conversation.composer.dock`; M0 Q7), hidden by default (`showTaskBar`): the open stack outermost-first with the innermost highlighted, plus "N folding" and the last fold title. Reads only the wire view.
- **Settings card** (`plugins.bundle.config`): the `Config` fields below.
- Locales: `en` required; others optional.

## 10. Settings

| Field | Default | Range | Effect |
|---|---|---|---|
| `minSpanTokens` | 2000 | 0–1,000,000 | Fold floor, judged at `task_end` |
| `delegateEnabled` | true | bool | Allow the LLM fallback for missing/unusable self-summaries |
| `minSummaryChars` | 200 | 0–10,000 | Below this, a self-summary is unusable |
| `maxSummaryRatio` | 0.5 | 0.05–0.9 | Above this share of the span, a self-summary is unusable |
| `staleTaskSteps` | 25 | 5–1,000 | Stale-task hint threshold |
| `showTaskBar` | false | bool | Show the dock |
| `summarizationProvider` / `summarizationModel` | "" | strings, set together | Delegate route override |

All fields `.volatile()`; readers clamp invalid values to defaults instead of throwing.

All fields are live: `minSpanTokens`, `delegateEnabled`, `minSummaryChars` and `maxSummaryRatio` decide the verdict in `task_end`, `minSpanTokens` also gates the fold saving; `staleTaskSteps` drives the hint buckets (8); `summarizationProvider`/`summarizationModel` override the delegate route (5.4); `showTaskBar` shows the dock (9). A realm `compaction-basic` configured with `thresholdRatio <= retainRatio` fails to mount at all — see `docs/02` §6.

## 11. Failure modes

| Situation | Behavior |
|---|---|
| Engine adapter cannot resolve `dsh-compaction-basic` | Tools still work; tasks close with their verdicts; folds are skipped; one startup diagnostic and a hint-free status line in the dock. Recall of existing folds still works. |
| `meta` missing on a result (host without `presentationMeta`) | The plugin refuses to activate: `peerDependencies` pin a host that has it. |
| Model never calls `task_end` | Stale-task hint; host auto compaction remains the safety net. |
| Model calls task tools from `run_code` (PTC is disabled by default) | Refused with a clear error (`exec.callId !== exec.rootCallId`). |
| Host restart mid-turn | Projection reloads from checkpoint/log; due tasks fold at the next boundary; nothing in memory is required. |
| Fork | Inherited prefix replays through `apply`; open tasks continue in the fork. |
| taskfold installed too | Tool-name collision fails registration; the plugin logs "uninstall dsh-taskfold" and stays inactive. |
| Summary not smaller than the span | Self path demotes to delegate (in memory); delegate path counts toward the durable cap. |
| A tool marked `deferLoading` never receives a `tool_addition` in 0.2.2-rc.5 | Its definition stays out of context for the session, so the model may never call it; `fold_recall` is therefore not deferred (07 Q6, measured live). |
| No session-projection service | The plugin does not activate: one warn line names the service and everything registered before it is disposed, exactly like a missing tool sink. Fold state has nowhere to live. |
| No `llm` service | Delegate summaries are off; a `delegate` verdict leaves the task waiting; the one-shot line says so, and nothing retries. |
| A journal carries `meta` written under another `stateVersion` | The payload is ignored (not reinterpreted); the projection keeps its own version and the log still replays. |
| A journal event has a seq the host cannot have produced (negative, non-integer) | The event is ignored rather than used as a cut: a negative seq is the `ABSORBED` sentinel, and a task born collapsed would be silent corruption. |
| The logger throws | Every runner log goes through a non-throwing helper: the original error keeps its message, nothing escapes `agent/pre-step`/`agent/turn-stopping`, and a failed delegate generation produces no unhandled rejection. Diagnostics never decide behaviour. |
| The turn is aborted while a delegate generation is in flight | The generation is **cancelled**, not failed: one line, nothing committed, `failures` unchanged, the task waits for the next boundary. Counting an interruption toward the durable cap would `failed` a task for work that never ran. |
| `compaction/summary` without `shadowedSeqs` | The fold still applies when its `surfaceOp` edges match a waiting span (only cut translation needs the shadowed set), so a host that omits it costs precision, not correctness (`test/degradation.test.js`). |

## 12. Invariants (tested)

1. Every region the planner returns is tool-pairing balanced at both edges.
2. Regions of two different tasks never partially overlap: they are disjoint or one contains the other.
3. For any event sequence, `apply` over the full log equals `apply` resumed from any checkpoint (projection replay equivalence).
4. A task reaches exactly one terminal verdict, and never leaves it.
5. No code path on `pre-step` or `turn-stopping` calls `snapshotEvents()` or iterates the log.
6. No code path awaits an LLM call inside `pre-step` or `turn-stopping` (delegate generation may be *started* there as an un-awaited promise).
7. Recall of a folded task returns exactly `deriveEventMessage` of its `shadowedSeqs`, in order.
8. Replaying a log in which a task-mark result was later pruned (replaced) yields the same state as replaying it without the prune, apart from cut translation.
9. A delegate request replays the main request's prefix byte-for-byte (the whole surface prefix before the task's span, then the span, then the instruction; `tools` and `toolHistory` unchanged), so its provider cache-hit ratio stays within 10 percentage points of the session's main requests and above 80 %. Measured by `scripts/verify-cache.js` over the session journal (`compaction/summary.data.usage` against `assistant/message.data.usage`); at hand-off the fixtures showed 97.8–99.1 % on main requests and 98.2 % on an LLM-backed checkpoint.
