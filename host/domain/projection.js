// The taskFolding session projection (docs/03-architecture.md §4). Pure: no ctx, no I/O.
// apply() returns the same reference for events that change nothing.

import { ABSORBED, isAbsorbed, translateFirst, translateTask } from './cuts.js'
import { HINT_SOURCE_KIND, classify, replaceOp } from './journal.js'
import { nextEpoch } from './surface.js'

/** @typedef {import('./types.js').SessionEvent} SessionEvent */
/** @typedef {import('./types.js').State} State */
/** @typedef {import('./types.js').Task} Task */
/** @typedef {import('./types.js').TaskStatus} TaskStatus */
/** @typedef {import('./types.js').BeginMeta} BeginMeta */
/** @typedef {import('./types.js').EndMeta} EndMeta */
/** @typedef {import('./types.js').Batch} Batch */
/** @typedef {import('./types.js').ReplaceOp} ReplaceOp */
/** @typedef {import('./types.js').View} View */

export const PROJECTION_KEY = 'taskFolding'
// 2 added the turn boundary (turnSeq/turnStartSeq) and turnFolded, which the implicit turn fold
// (docs/03 §5.6) needs; the host discards an older checkpoint and replays the log.
export const STATE_VERSION = 2
export const META_TAG = 1
export const TASK_TOOLS = Object.freeze(['task_begin', 'task_end'])
export { HINT_SOURCE_KIND }
export const MAX_DELEGATE_FAILURES = 3
export const RECENT_LIMIT = 5

/** @type {ReadonlySet<TaskStatus>} */
export const TERMINAL = new Set(['below-floor', 'merged', 'folded', 'absorbed', 'failed'])
/** @type {ReadonlySet<TaskStatus>} */
export const WAITING = new Set(['queued', 'delegate'])
const VERDICTS = new Set(['queued', 'delegate', 'below-floor', 'absorbed'])
const OUTCOMES = new Set(['done', 'failed', 'abandoned'])
const TASK_ID = /^T([1-9][0-9]*)$/

/** @returns {State} */
export function initialState() {
  return {
    nextId: 1,
    open: [],
    tasks: {},
    order: [],
    batch: null,
    assistantCount: 0,
    folds: [],
    pendingSummary: null,
    hintKey: null,
    lastHeaderSeq: null,
    surfaceEpoch: 0,
    turnSeq: null,
    turnStartSeq: null,
    turnFolded: false,
  }
}

/**
 * @param {unknown} _header
 * @param {unknown} _inheritedEventCount a fork replays its inherited prefix, so no special case
 * @returns {State}
 */
export function init(_header, _inheritedEventCount) {
  return initialState()
}

/**
 * @param {State} state
 * @param {SessionEvent} event
 * @returns {State}
 */
export function apply(state, event) {
  // A turn boundary is not a surface event, but it is where the turn's span starts. The reducer
  // records it for the implicit turn fold (docs/03 §5.6); journal.js still classifies it as
  // `ignore`, so the boundary is handled here, before the dispatch.
  if (event.type === 'turn/start') return onTurnStart(state, event.seq)
  switch (classify(event)) {
    case 'surface':
      return onSurface(state, event)
    case 'hint':
      return onUser(state, event)
    case 'task-result':
      return onToolResult(state, event)
    case 'batch':
      return state.batch ? closeBatch(state) : state
    case 'compaction':
      return onCompaction(state, event)
    case 'header':
      return { ...state, lastHeaderSeq: event.seq }
    default:
      return state
  }
}

/**
 * A new turn begins: the previous turn's boundary and fold facts stop applying. `turnSeq` identifies
 * the new turn — a `turn/start` seq is unique within a session, so the runtime never confuses two
 * turns that start at the same surface seq.
 *
 * @param {State} state
 * @param {number} seq the `turn/start` event seq
 * @returns {State}
 */
function onTurnStart(state, seq) {
  // A log can carry an impossible seq; a boundary that cannot be numbered is not remembered, so
  // the turn keeps the previous identity instead of becoming one the runtime cannot compare.
  const turnSeq = Number.isInteger(seq) && seq >= 0 ? seq : state.turnSeq
  if (state.turnSeq === turnSeq && state.turnStartSeq === null && !state.turnFolded) return state
  return { ...state, turnSeq, turnStartSeq: null, turnFolded: false }
}

/**
 * A surface event: a replacement commits a new version of the node list, an append notes the node
 * and may carry the model's calls.
 *
 * @param {State} state
 * @param {SessionEvent} event
 * @returns {State}
 */
function onSurface(state, event) {
  const replace = replaceOp(event)
  if (replace) return applyReplace(state, event, replace)
  if (event.type === 'assistant/message') return onAssistant(state, event)
  if (event.type === 'user/message') return onUser(state, event)
  return noteSurfaceAppend(state, event.seq)
}

/**
 * A compaction row: a summary opens a fold, an errored end counts against every waiting delegate.
 *
 * @param {State} state
 * @param {SessionEvent} event
 * @returns {State}
 */
function onCompaction(state, event) {
  if (event.type === 'compaction/summary') return onCompactionSummary(state, event)
  if (event.data && event.data.error !== undefined && event.data.error !== null)
    return onCompactionFailure(state)
  return state
}

// ---------------------------------------------------------------------------
// Events

/**
 * @param {State} state
 * @param {SessionEvent} event
 * @returns {State}
 */
function onAssistant(state, event) {
  let s = state.batch ? closeBatch(state) : state
  s = noteSurfaceAppend(s, event.seq)
  s = { ...s, assistantCount: s.assistantCount + 1 }
  s = markReported(s)
  const calls = toolCalls(event)
  if (calls.some((c) => TASK_TOOLS.includes(c.name))) {
    s = {
      ...s,
      batch: { msgSeq: event.seq, waiting: calls.map((c) => c.id), last: event.seq, begins: [], ends: [] },
    }
  }
  return s
}

/**
 * @param {State} state
 * @param {SessionEvent} event
 * @returns {State}
 */
function onToolResult(state, event) {
  // A journal is the only input, so it can be damaged: an event whose seq cannot exist (the host
  // numbers events from zero upward) must not become a cut, because a negative one is exactly the
  // ABSORBED sentinel and would open a task that is born collapsed.
  if (!Number.isInteger(event.seq) || event.seq < 0) return state
  const carried = /** @type {Record<string, unknown> | null} */ (
    event.data && typeof event.data.meta === 'object' && event.data.meta !== null ? event.data.meta : null
  )
  // Meta is written by this plugin, but a log can be replayed by a newer or an older version of it:
  // a payload that names a different state schema is not ours to interpret.
  if (carried !== null && carried.stateVersion !== undefined && carried.stateVersion !== STATE_VERSION) {
    return state
  }
  let s = noteSurfaceAppend(state, event.seq)
  const callId = event.data && event.data.message && event.data.message.toolCallId
  const inBatch = s.batch !== null && typeof callId === 'string' && s.batch.waiting.includes(callId)
  if (s.batch && inBatch) {
    s = {
      ...s,
      batch: { ...s.batch, waiting: s.batch.waiting.filter((id) => id !== callId), last: event.seq },
    }
  }
  const meta = event.data && event.data.meta
  if (inBatch && isBeginMeta(meta)) s = onBegin(s, meta)
  else if (inBatch && isEndMeta(meta)) s = onEnd(s, meta)
  if (s.batch && s.batch.waiting.length === 0) s = closeBatch(s)
  return s
}

/**
 * @param {State} state
 * @param {SessionEvent} event
 * @returns {State}
 */
function onUser(state, event) {
  const s = noteSurfaceAppend(state, event.seq)
  const source = event.data && event.data.source
  if (
    source &&
    source.kind === HINT_SOURCE_KIND &&
    typeof source.key === 'string' &&
    source.key !== s.hintKey
  ) {
    return { ...s, hintKey: source.key }
  }
  return s
}

/**
 * @param {State} state
 * @param {SessionEvent} event
 * @returns {State}
 */
function onCompactionSummary(state, event) {
  const data = event.data || {}
  const shadowed = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : []
  const row = {
    summarySeq: event.seq,
    nodeSeq: null,
    taskId: null,
    shadowedCount: shadowed.length,
    shadowedTokens: typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : 0,
  }
  return { ...state, folds: [...state.folds, row], pendingSummary: state.folds.length }
}

/**
 * Every failed compaction counts against every task waiting for a delegate summary. The
 * failure cannot be attributed to a task from the log; over-counting only stops retries
 * earlier (docs/adr/0005-durable-state-only.md).
 *
 * @param {State} state
 * @returns {State}
 */
function onCompactionFailure(state) {
  let tasks = state.tasks
  for (const id of state.order) {
    const task = tasks[id]
    if (!task || task.status !== 'delegate') continue
    const failures = task.failures + 1
    const status = failures >= MAX_DELEGATE_FAILURES ? 'failed' : task.status
    tasks = { ...tasks, [id]: { ...task, failures, status } }
  }
  return tasks === state.tasks ? state : { ...state, tasks }
}

/**
 * @param {State} state
 * @param {SessionEvent} event
 * @param {ReplaceOp} op
 * @returns {State}
 */
function applyReplace(state, event, op) {
  const shadowed = new Set(Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : [])
  let folds = state.folds
  let pendingSummary = state.pendingSummary
  let foldIndex = null
  if (event.type === 'user/message' && pendingSummary !== null) {
    foldIndex = pendingSummary
    pendingSummary = null
  }

  let tasks = state.tasks
  // A replacement that touches a live task moved its work: the turn must not fold around it. This
  // is the durable half of "a turn that ends after another fold does not fold the same nodes"
  // (docs/03 §5.6): a task that is folded or absorbed in this turn blocks the implicit fold.
  let touched = state.turnFolded
  for (const id of state.order) {
    const task = tasks[id]
    if (!task || TERMINAL.has(task.status)) continue
    /** @type {Task} */
    let next
    if (foldIndex !== null && WAITING.has(task.status) && coversSpan(task, op)) {
      next = { ...task, status: 'folded', foldIndex }
      const row = folds[foldIndex]
      if (row) folds = replaceAt(folds, foldIndex, { ...row, nodeSeq: event.seq, taskId: id })
    } else {
      next = translateTask(task, shadowed, op, event.seq)
      if (next !== task && WAITING.has(next.status) && isAbsorbed(next))
        next = { ...next, status: 'absorbed' }
    }
    if (next !== task) {
      tasks = { ...tasks, [id]: next }
      touched = true
    }
  }

  if (foldIndex !== null) {
    const row = folds[foldIndex]
    if (row && row.nodeSeq === null) folds = replaceAt(folds, foldIndex, { ...row, nodeSeq: event.seq })
  }
  // The epoch moves even when no task was touched: a replacement that only removed a neighbouring
  // node still changed the surface another consumer may have observed (docs/10 §4.1). A missing
  // field is a checkpoint written before the epoch existed, so it starts from zero.
  return {
    ...state,
    tasks,
    folds,
    pendingSummary,
    surfaceEpoch: nextEpoch(state),
    turnStartSeq: translateFirst(state.turnStartSeq, shadowed, op, event.seq),
    turnFolded: touched,
  }
}

// ---------------------------------------------------------------------------
// Task transitions

/**
 * @param {State} state
 * @param {BeginMeta} meta
 * @returns {State}
 */
function onBegin(state, meta) {
  const match = TASK_ID.exec(meta.id)
  if (!match || state.tasks[meta.id] || !state.batch) return state
  const parentTask = meta.parent === null ? undefined : state.tasks[meta.parent]
  /** @type {Task} */
  const task = {
    id: meta.id,
    title: meta.title,
    parent: parentTask ? parentTask.id : null,
    depth: parentTask ? parentTask.depth + 1 : 0,
    status: 'opening',
    beginCut: null,
    spanStart: null,
    endCut: null,
    endMsgSeq: null,
    endCallId: null,
    verdict: null,
    outcome: null,
    estTokens: -1,
    summaryChars: 0,
    openedAt: state.assistantCount,
    reported: false,
    failures: 0,
    foldIndex: null,
  }
  return {
    ...state,
    nextId: Math.max(state.nextId, Number(match[1]) + 1),
    open: [...state.open, meta.id],
    tasks: { ...state.tasks, [meta.id]: task },
    order: [...state.order, meta.id],
    batch: { ...state.batch, begins: [...state.batch.begins, meta.id] },
  }
}

/**
 * @param {State} state
 * @param {EndMeta} meta
 * @returns {State}
 */
function onEnd(state, meta) {
  const task = state.tasks[meta.id]
  if (!task || !state.batch || (task.status !== 'open' && task.status !== 'opening')) return state
  const merged = meta.merged.filter((id) => id !== meta.id && state.open.includes(id))
  const closing = new Set([meta.id, ...merged])
  let tasks = {
    ...state.tasks,
    [meta.id]: {
      ...task,
      status: /** @type {TaskStatus} */ ('closing'),
      endMsgSeq: state.batch.msgSeq,
      endCallId: meta.callId,
      verdict: meta.verdict,
      outcome: meta.outcome,
      estTokens: meta.estTokens,
      summaryChars: meta.summaryChars,
    },
  }
  for (const id of merged) {
    const child = tasks[id]
    if (child) tasks = { ...tasks, [id]: { ...child, status: 'closing', verdict: null } }
  }
  return {
    ...state,
    open: state.open.filter((id) => !closing.has(id)),
    tasks,
    batch: { ...state.batch, ends: [...state.batch.ends, meta.id, ...merged] },
  }
}

/**
 * Fix the cuts of everything begun or ended in the batch. Call only with a batch in flight.
 *
 * @param {State} state
 * @returns {State}
 */
function closeBatch(state) {
  const batch = /** @type {Batch} */ (state.batch)
  let tasks = state.tasks
  // Every id in begins/ends was created or set to 'closing' by this batch's own results.
  for (const id of batch.begins) {
    const task = /** @type {Task} */ (tasks[id])
    /** @type {TaskStatus} */
    const status = task.status === 'opening' ? 'open' : task.status
    tasks = { ...tasks, [id]: { ...task, status, beginCut: batch.last, openedAt: state.assistantCount } }
  }
  for (const id of batch.ends) {
    const task = /** @type {Task} */ (tasks[id])
    tasks = { ...tasks, [id]: { ...task, endCut: batch.last, status: closedStatus(task) } }
  }
  return { ...state, tasks, batch: null }
}

/**
 * @param {Task} task
 * @returns {TaskStatus}
 */
function closedStatus(task) {
  if (task.verdict === null) return 'merged'
  if (task.verdict === 'below-floor' || task.verdict === 'absorbed') return task.verdict
  if (task.beginCut === null || isAbsorbed(task)) return 'absorbed'
  if (task.spanStart === null) return 'below-floor'
  return task.verdict
}

/**
 * The first surface node after a begin batch starts that task's span; the first surface node after
 * a turn boundary starts the turn's span the implicit fold uses (docs/03 §5.6).
 *
 * @param {State} state
 * @param {number} seq
 * @returns {State}
 */
function noteSurfaceAppend(state, seq) {
  let tasks = state.tasks
  for (const id of state.open) {
    const task = tasks[id]
    if (task && task.status === 'open' && task.spanStart === null) {
      tasks = { ...tasks, [id]: { ...task, spanStart: seq } }
    }
  }
  const turnStartSeq = state.turnStartSeq === null ? seq : state.turnStartSeq
  if (tasks === state.tasks && turnStartSeq === state.turnStartSeq) return state
  return { ...state, tasks, turnStartSeq }
}

/**
 * @param {State} state
 * @returns {State}
 */
function markReported(state) {
  let tasks = state.tasks
  for (const id of state.order) {
    const task = tasks[id]
    if (task && WAITING.has(task.status) && !task.reported)
      tasks = { ...tasks, [id]: { ...task, reported: true } }
  }
  return tasks === state.tasks ? state : { ...state, tasks }
}

// ---------------------------------------------------------------------------
// Helpers

/**
 * @param {Task} task
 * @param {ReplaceOp} op
 */
function coversSpan(task, op) {
  return (
    task.spanStart !== null &&
    task.spanStart !== ABSORBED &&
    task.spanStart === op.startSeq &&
    task.endCut !== null &&
    task.endCut !== ABSORBED &&
    task.endCut === op.endSeq
  )
}

/**
 * @param {SessionEvent} event
 * @returns {{ id: string, name: string }[]}
 */
export function toolCalls(event) {
  const content = event.data && event.data.message && event.data.message.content
  if (!Array.isArray(content)) return []
  /** @type {{ id: string, name: string }[]} */
  const calls = []
  for (const block of content) {
    if (
      block &&
      block.type === 'tool-call' &&
      typeof block.id === 'string' &&
      typeof block.name === 'string'
    ) {
      calls.push({ id: block.id, name: block.name })
    }
  }
  return calls
}

/**
 * @template T
 * @param {T[]} list
 * @param {number} index
 * @param {T} value
 * @returns {T[]}
 */
function replaceAt(list, index, value) {
  const copy = list.slice()
  copy[index] = value
  return copy
}

/**
 * @param {unknown} value
 * @returns {value is BeginMeta}
 */
export function isBeginMeta(value) {
  if (!isRecord(value) || value.tf !== META_TAG || value.op !== 'begin') return false
  return (
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    (value.parent === null || typeof value.parent === 'string')
  )
}

/**
 * @param {unknown} value
 * @returns {value is EndMeta}
 */
export function isEndMeta(value) {
  if (!isRecord(value) || value.tf !== META_TAG || value.op !== 'end') return false
  return (
    typeof value.id === 'string' &&
    Array.isArray(value.merged) &&
    value.merged.every((id) => typeof id === 'string') &&
    VERDICTS.has(/** @type {string} */ (value.verdict)) &&
    OUTCOMES.has(/** @type {string} */ (value.outcome)) &&
    typeof value.estTokens === 'number' &&
    typeof value.summaryChars === 'number' &&
    typeof value.callId === 'string'
  )
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// Schema and wire view

/**
 * Validates a checkpointed state. Throws on anything that is not a state this version wrote,
 * so the host discards the checkpoint and replays the log.
 *
 * @param {unknown} value
 * @returns {State}
 */
export function parseState(value) {
  const fail = (/** @type {string} */ what) => {
    throw new TypeError(`taskFolding state: invalid ${what}`)
  }
  if (!isRecord(value)) return fail('root')
  if (!Number.isInteger(value.nextId) || /** @type {number} */ (value.nextId) < 1) fail('nextId')
  if (!isStringArray(value.open)) fail('open')
  if (!isStringArray(value.order)) fail('order')
  if (!isRecord(value.tasks)) return fail('tasks')
  for (const id of /** @type {string[]} */ (value.order)) {
    const task = value.tasks[id]
    if (!isRecord(task) || task.id !== id || typeof task.status !== 'string') fail(`task ${id}`)
  }
  if (value.batch !== null && !isRecord(value.batch)) fail('batch')
  if (!Number.isInteger(value.assistantCount)) fail('assistantCount')
  if (!Array.isArray(value.folds)) fail('folds')
  if (value.pendingSummary !== null && !Number.isInteger(value.pendingSummary)) fail('pendingSummary')
  if (value.hintKey !== null && typeof value.hintKey !== 'string') fail('hintKey')
  if (value.lastHeaderSeq !== null && !Number.isInteger(value.lastHeaderSeq)) fail('lastHeaderSeq')
  // The turn fields are what the implicit turn fold reads (docs/03 §5.6). A state from before the
  // schema bump is discarded by the host, so a missing field is a bug, not an old checkpoint.
  if (
    value.turnSeq !== null &&
    (!Number.isInteger(value.turnSeq) || /** @type {number} */ (value.turnSeq) < 0)
  )
    fail('turnSeq')
  if (
    value.turnStartSeq !== null &&
    (!Number.isInteger(value.turnStartSeq) || /** @type {number} */ (value.turnStartSeq) < ABSORBED)
  )
    fail('turnStartSeq')
  if (typeof value.turnFolded !== 'boolean') fail('turnFolded')
  // A checkpoint written before the epoch existed has no field; the reducer starts it from zero and
  // every replacement after that is counted, so an old log still replays.
  if (value.surfaceEpoch !== undefined) {
    const epoch = value.surfaceEpoch
    if (epoch === null || typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 0)
      fail('surfaceEpoch')
  }
  // No copy: callers compare states by reference (`parseState(state) === state`), and a missing
  // epoch is defaulted by the reducer, not here.
  return /** @type {State} */ (/** @type {unknown} */ (value))
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isStringArray(value) {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

export const stateSchema = Object.freeze({ parse: parseState })

/**
 * Validates the wire view the host publishes to clients. Like parseState it throws on
 * anything this version did not produce, so a broken view fails loudly instead of reaching
 * the Client half-read.
 *
 * @param {unknown} value
 * @returns {View}
 */
export function parseView(value) {
  const fail = (/** @type {string} */ what) => {
    throw new TypeError(`taskFolding view: invalid ${what}`)
  }
  if (!isRecord(value)) return fail('root')
  if (!isViewArray(value.open, isViewOpen)) fail('open')
  if (!isViewArray(value.folding, isViewFolding)) fail('folding')
  if (!isViewArray(value.recent, isViewRecent)) fail('recent')
  return /** @type {View} */ (/** @type {unknown} */ (value))
}

/**
 * @param {unknown} value
 * @param {(entry: Record<string, unknown>) => boolean} check
 * @returns {boolean}
 */
function isViewArray(value, check) {
  return Array.isArray(value) && value.every((entry) => isRecord(entry) && check(entry))
}

/** @param {Record<string, unknown>} entry */
function isViewOpen(entry) {
  return typeof entry.id === 'string' && typeof entry.title === 'string' && typeof entry.depth === 'number'
}

/** @param {Record<string, unknown>} entry */
function isViewFolding(entry) {
  return typeof entry.id === 'string' && typeof entry.title === 'string'
}

/** @param {Record<string, unknown>} entry */
function isViewRecent(entry) {
  return isViewFolding(entry) && typeof entry.status === 'string'
}

export const viewSchema = Object.freeze({ parse: parseView })

/** @type {WeakMap<Record<string, Task>, { open: string[], view: View }>} */
const viewCache = new WeakMap()

/**
 * The Client-facing view. Returns the same object while the tasks and the stack are unchanged.
 *
 * @param {State} state
 * @returns {View}
 */
export function view(state) {
  const cached = viewCache.get(state.tasks)
  if (cached && cached.open === state.open) return cached.view
  /** @type {View} */
  const next = { open: [], folding: [], recent: [] }
  for (const id of state.open) {
    const task = state.tasks[id]
    if (task) next.open.push({ id, title: task.title, depth: task.depth })
  }
  for (const id of state.order) {
    const task = state.tasks[id]
    if (!task) continue
    if (WAITING.has(task.status)) next.folding.push({ id, title: task.title })
    else if (TERMINAL.has(task.status)) next.recent.push({ id, title: task.title, status: task.status })
  }
  next.recent = next.recent.slice(-RECENT_LIMIT)
  viewCache.set(state.tasks, { open: state.open, view: next })
  return next
}
