# 03 — Architecture

This document is the design the implementation follows. Host APIs are referenced by the section numbers of [02-host-api.md](02-host-api.md). Decisions with real alternatives have ADRs in [adr/](adr/).

## 1. Goals and non-goals

**Goals**

1. The model marks finished units of work; each unit leaves the surface as one short titled summary.
2. Folding never blocks the agent noticeably (self-summary path: p95 < 100 ms per step).
3. All plugin state is derived from the session log; fork, resume and replay need no plugin-side storage.
4. Originals are recoverable exactly, from the log only.
5. The protocol the model must follow is small: three tools, no rules about which calls may share a message, and at most ~850 tokens (3,400 characters) for the prompt section and all tool schemas together.
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
  engine-adapter.js   the ONLY module touching dsh-compaction-basic internals
  summarizer.js       delegate path: prefix-anchored request, instruction, validation
  recall.js           index, range, grep over a fold's shadowed messages
  hints.js            stale-task hint, durable latch
  estimate.js         span token estimate via ctx.tokenMeter.estimateMessage
  settings.js         Config schema and safe readers
client/
  index.js            dock + settings card
```

Dependency direction: `projection`, `cuts` are leaves; `planner`, `recall`, `hints`, `estimate` read the projection and the session; `tools` and `fold-runner` orchestrate; only `engine-adapter` and `summarizer` know about compaction internals or the LLM.

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

Key `taskFolding`, `stateVersion: 1`, host-only fields plus a wire view.

```ts
type State = {
  nextId: number                         // highest numeric id seen + 1
  open: string[]                         // stack, outermost first
  tasks: Record<string, Task>
  batch: Batch | null                    // the in-flight batch IF it carries one of our calls
  lastAssistantSeq: number               // gate for "fold is due"
  assistantCount: number                 // running count of assistant/message events (task age)
  folds: FoldRow[]                       // every compaction/summary in log order (recall index)
  pendingSummary: PendingSummary | null  // compaction/summary seen, replacement not yet
  hint: { key: string } | null           // durable latch for the stale-task hint
  failuresSince: Record<string, number>  // delegate tasks → compaction/end{error} count since queued
}

type Task = {
  id: string; title: string; parent: string | null; depth: number
  status: 'opening' | 'open' | 'closing' | Verdict
  beginCut: number | null                // the seq s of after(s); null while opening; -1 = absorbed
  endCut: number | null                  // same encoding
  endMsgSeq: number | null; endCallId: string | null
  openedAt: number                       // assistantCount when the begin batch closed
  outcome?: 'done' | 'failed' | 'abandoned'
  estTokens?: number
  foldIndex?: number                     // index into folds when folded
}

type Batch = {
  msgSeq: number
  waiting: string[]                      // call ids without a result yet
  last: number                           // seq of the last node of the batch so far
  begins: string[]; ends: string[]       // task ids whose meta arrived in this batch
}

type FoldRow = {
  summarySeq: number                     // the compaction/summary event (has shadowedSeqs)
  nodeSeq: number | null                 // the replacement user/message
  taskId: string | null                  // ours, or null for auto/other compactions
  title: string | null
  shadowedCount: number; shadowedTokens: number
}

type PendingSummary = { summarySeq: number; taskId: string | null; shadowedCount: number; shadowedTokens: number; title: string | null }
```

Size: `folds` grows by one row per compaction (tens per long session); `tasks` by one row per task. Terminal tasks MAY be compacted to `{id, title, status, foldIndex}` once terminal to keep checkpoints small.

### 4.3 Reducer

`apply(state, event)` — pure, synchronous, returns the same reference when nothing changes.

| Event | Transition |
|---|---|
| `assistant/message` | `lastAssistantSeq = seq`, `assistantCount += 1`. If `batch` is set and still waiting, force-close it first (interrupted batch; its `last` stays as seen). If the message carries a call named `task_begin` or `task_end`, open `batch = { msgSeq: seq, waiting: [all call ids], last: seq, begins: [], ends: [] }`; otherwise `batch = null`. |
| `tool/result` (append) | If `batch` and the result's `toolCallId ∈ waiting`: remove it, `last = seq`. If `data.meta?.tf === 1`: on `begin` create the task (`status: 'opening'`), push onto `open`, add to `begins`, `nextId = max(nextId, n+1)`; on `end` set `status: 'closing'`, pop it and its `merged` descendants from `open`, store `endMsgSeq = batch.msgSeq`, `endCallId`, verdict fields, add to `ends`. When `waiting` becomes empty, **close the batch**. |
| batch close (internal) | For each id in `begins`: `beginCut = last`, `openedAt = assistantCount`, `status: 'open'`. For each id in `ends`: `endCut = last`, `status = verdict`; for `merged` ids: `status: 'merged'`. `batch = null`. |
| `compaction/summary` | Push a `FoldRow` (with `nodeSeq: null`); set `pendingSummary`. `taskId` is parsed from the first summary line if it matches the fold heading `# <id> · …` (see 7.3); otherwise null. |
| surface event with `surfaceOp.op === 'replace'` | Let `S = set(sourceEventSeqs)`, `end = surfaceOp.endSeq`, `R = seq`. If `pendingSummary` is set, fill `nodeSeq = R` in its row and clear it. If the row's `taskId` names a `queued`/`delegate` task whose `endCut === end` and whose `beginCut ∉ S` → `status: 'folded'`, `foldIndex`. Then translate every tracked cut of every non-terminal task and every open task (2.4); a `queued`/`delegate` task whose cut becomes absorbed → `status: 'absorbed'`; an open task whose `beginCut` is absorbed keeps running with `beginCut = -1` and is closed `absorbed` by its `task_end`. |
| `compaction/end` with `data.error` | For every task in `delegate` status: `failuresSince[id] += 1`; when it reaches `maxDelegateFailures` (constant, 3) → `status: 'failed'`. |
| `user/message` with `source.kind === 'task-folding:hint'` | `hint = { key }` (key embedded in `source`). |
| anything else | unchanged |

Notes:

- Force-closing an interrupted batch is safe: the host's session repair appends synthetic error results for unanswered calls, so in practice the batch completes normally; the force-close only guards odd logs.
- A fold that commits while a batch is in flight cannot happen: folds run only at step boundaries (pre-step, turn-stopping, idle maintenance), never between a call and its result.
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

A `queued` or `delegate` task is **due** when `lastAssistantSeq > endCut` (the model has produced at least one message after the closing batch — usually the report, written with the span still in context), or when the turn is stopping. Due tasks are processed inner-first: by `depth` descending, then by `endCut` ascending (close order).

### 5.2 Region resolution (`planner.js`)

```js
function resolveRegion(task, nodes) {
  if (task.beginCut === -1 || task.endCut === -1) return { kind: 'absorbed' }
  const i = nodes.indexOf(task.beginCut)   // the begin batch's last node
  const j = nodes.indexOf(task.endCut)     // the end batch's last node
  if (i === -1 || j === -1) return { kind: 'absorbed' }   // should be impossible after translation
  if (i + 1 > j) return { kind: 'empty' }                 // nothing between the cuts
  return { kind: 'fold', start: nodes[i + 1], end: nodes[j] }
}
```

Before committing, the runner MUST check `toolPairingBalancedBefore(session, start)` and `toolPairingBalancedAfter(session, end)` when the helpers are resolvable; a failure is a bug (cuts are balanced by construction), reported once and the task marked unfoldable in memory for this process.

`indexOf` over the surface is O(surface), not O(log); the surface is bounded by folding itself. The runner caches `nodes` positions per `surface.replaceGeneration` + `nodes.length`.

### 5.3 Self-summary fold (default path)

Runs inline in `agent/pre-step` (before `next()`) and in `agent/turn-stopping`, because it costs milliseconds:

1. Read the summary: `session.eventAt(task.endMsgSeq)` → the `tool-call` block with `id === task.endCallId` → parse `arguments` → `summary`.
2. Build the node text (7.3).
3. Call the adapter: `engine.compactRegion(start, end, agent, signal)` on the adapter engine whose `summarize()` returns the prepared blocks without an LLM call ([ADR 0004](adr/0004-engine-adapter.md)).
4. On success: nothing else to do — the projection observes the replacement and marks `folded`.
5. On `ManualCompactionError('busy')`: retry at the next boundary (no cost).
6. On `ManualCompactionError('summary')` (summary not smaller than the span — validation in `task_end` should prevent it): switch the task to the delegate path in memory for this process.
7. On any other error: log once per task, retry at the next boundary with in-memory backoff (1, 2, 4, 8 boundaries). Self folds are free, so there is no durable cap.

### 5.4 Delegate fold (fallback path)

For tasks with verdict `delegate` (no or unusable self-summary) and for self folds demoted in 5.3 step 6.

- Never runs inside `pre-step`. In `agent/turn-stopping`, the runner schedules (without awaiting — listeners must not await `whenIdle()`) `agent.whenIdle().then(() => agent.runMaintenance(signal => foldDelegated(task, signal)))`; if `runMaintenance` throws because a new turn already started, the task stays `delegate` and is retried at the next turn end ([07 Q3](07-open-questions.md#q3)).
- The summarization request is taskfold's prefix-anchored envelope, corrected: surface prefix + span + instruction as the final user message, `system`/`tools` from the summarization input, `toolHistory: session.toolHistory()`, provider/model from (config → latest request header → agent options), no `maxTokens` override beyond the host config.
- The instruction (7.2) includes a numbered span index and a size budget.
- Output validation: non-empty text; must open with a `## ` section after at most 3 short preamble lines; otherwise throw `ManualCompactionError('summary')`-equivalent so the host records `compaction/end{error}`. The durable cap (4.3) stops retries.

### 5.5 Interaction with host auto compaction

- Both go through the durable `compaction/start`…`compaction/end` lock; a `busy` error simply retries later.
- Auto compaction cuts from the head of history. If it shadows part of a task, cut translation (2.4) yields `absorbed`, the task's own fold is skipped, and the auto checkpoint covers that content.
- The plugin MUST NOT modify the host's compaction instruction or wrap `ctx.llm.stream` (the taskfold anti-pattern).

## 6. Tools (behavior)

Exact schemas and texts: [04-tools-and-prompt.md](04-tools-and-prompt.md).

### 6.1 `task_begin({ title })`

- Refuse under PTC (`exec.rootCallId !== undefined`): "call task_begin directly, not from run_code".
- Assign `id = 'T' + max(state.nextId, reserved[session])`, then bump the in-memory `reserved[session]`. The in-memory reservation only prevents duplicate ids among calls executing concurrently in one batch; the durable id is whatever lands in meta.
- `parent` = innermost id of `stateOf(session).open` at execute time (a begin later in the same batch than another begin does not see it as parent — acceptable: siblings).
- Returns `{ ok: true, id, title, parent, depth }`; meta `BeginMeta`.

### 6.2 `task_end({ summary, id?, outcome? })`

- Refuse under PTC.
- Target: `id` if given and open, else the innermost open task. Unknown id → error listing open ids. No open task → error.
- Open descendants of the target are closed with it as `merged` (no LIFO refusal).
- If the target's `beginCut === -1` (another compaction swallowed its start), the verdict is `absorbed` with `estTokens: -1`, and the result tells the model the task closed without a fold of its own.
- Estimate the span: `estimate.js` sums `ctx.tokenMeter.estimateMessage(session.deriveEventMessage(session.eventAt(n)))` over surface nodes after `beginCut` up to the current tail. If the target is still `opening` (begun in this same batch), the span is empty → `below-floor`.
- Verdict:
  - `estTokens < minSpanTokens` → `below-floor`;
  - `summary` shorter than `minSummaryChars` (default 200) or estimated summary tokens > `maxSummaryRatio` × `estTokens` (default 0.5) → `delegate` if `delegateEnabled`, else `queued` (and the host's "not smaller" check is the last guard);
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

The first line is the machine-readable heading the projection parses (`/^# (T\d+) · /`). Task titles are single-line by normalization, so the heading cannot be spoofed by summary content.

## 8. Hints

One hint only: the innermost open task has been open for `staleTaskSteps` (default 25) or more assistant messages.

- Text: `Task T7 "<title>" has been open for 25+ steps. If it is finished, call task_end with a summary; if it has distinct parts, wrap the remaining parts in nested tasks.` Buckets at 25, 50, 100 steps; the text is byte-stable within a bucket.
- Delivered by rewriting the pre-step decision: `{ ...decision, messages: [...decision.messages, hintMessage] }` with `source: { kind: 'task-folding:hint', key: '<id>:<bucket>' }`.
- Latch: the projection records the last hint key; a hint is published only when its key differs. The latch is durable, so restarts do not re-publish.
- No "no open task" hint (see 01, issue 11). An optional implicit per-turn task (open question, off by default) is the answer to forgotten discipline, not nagging.

Age is `assistantCount - task.openedAt`, both maintained by the projection in O(1).

## 9. Client

- **Dock** (`conversation.input.dock`), hidden by default (`showTaskBar`): the open stack outermost-first with the innermost highlighted, plus "N folding" and the last fold title. Reads only the wire view.
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

## 11. Failure modes

| Situation | Behavior |
|---|---|
| Engine adapter cannot resolve `dsh-compaction-basic` | Tools still work; tasks close with their verdicts; folds are skipped; one startup diagnostic and a hint-free status line in the dock. Recall of existing folds still works. |
| `meta` missing on a result (host without `presentationMeta`) | The plugin refuses to activate: `peerDependencies` pin a host that has it. |
| Model never calls `task_end` | Stale-task hint; host auto compaction remains the safety net. |
| Model calls task tools from `run_code` | Refused with a clear error. |
| Host restart mid-turn | Projection reloads from checkpoint/log; due tasks fold at the next boundary; nothing in memory is required. |
| Fork | Inherited prefix replays through `apply`; open tasks continue in the fork. |
| taskfold installed too | Tool-name collision fails registration; the plugin logs "uninstall dsh-taskfold" and stays inactive. |
| Summary not smaller than the span | Self path demotes to delegate (in memory); delegate path counts toward the durable cap. |

## 12. Invariants (tested)

1. Every region the planner returns is tool-pairing balanced at both edges.
2. Regions of two different tasks never partially overlap: they are disjoint or one contains the other.
3. For any event sequence, `apply` over the full log equals `apply` resumed from any checkpoint (projection replay equivalence).
4. A task reaches exactly one terminal verdict, and never leaves it.
5. No code path on `pre-step` or `turn-stopping` calls `snapshotEvents()` or iterates the log.
6. No code path issues an LLM call inside `pre-step`.
7. Recall of a folded task returns exactly `deriveEventMessage` of its `shadowedSeqs`, in order.
