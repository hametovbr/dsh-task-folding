// The per-session fold runtime (docs/10 §4.2, §6, §12). The fold runner used to keep seven
// per-session WeakMaps — `skipped`, `waiting`, `backoff`, `pending`, `generating`,
// `generationFailed` and `rejectLogged` — plus an `inFlight` WeakSet. Every map had its own
// mutator, so an illegal transition (a second generation while one was in flight, a commit for a
// task that had already folded, a skip honoured after the surface moved) was a convention each
// call site had to remember. Here the same facts are fields of one object and only `reduce`
// changes them: a transition the failure table of docs/10 §12 does not allow returns the runtime it
// was given, so the runner cannot perform it by accident and a test can observe that it did not.
//
// The reducer is total and pure: no session, no clock, no I/O, and no mutation of its input. It is
// the one place that knows the epoch of a skip, the count behind the backoff and the durable cap.

import { MAX_DELEGATE_FAILURES } from '../domain/projection.js'

/** Retry 1, 2, 4, 8 boundaries after an unexpected fold failure (docs/03 §5.3). */
export const MAX_BACKOFF_BOUNDARIES = 8
/** The durable delegate-failure cap (docs/10 §12): at this count the task is terminally failed. */
export const MAX_TASK_ATTEMPTS = MAX_DELEGATE_FAILURES

/**
 * @typedef {'idle'|'generating'|'committing'|'waiting'|'folded'|'cancelled'|'failed'|'skipped'} TaskPhase
 */

/**
 * One task's private fold state.
 *
 * `phase` is the runtime's own view — the projection remains the source of truth for durability —
 * and `epoch` is the surface version that view was decided at. `attempts` counts the durable failed
 * generations whose record was written, so the cap lives here; `retries` is the purely in-memory
 * backoff counter. The three `*Logged` flags replace the "say it once" sets the runner used to keep
 * beside the state they belonged to.
 *
 * @typedef {object} TaskRuntime
 * @property {TaskPhase} phase
 * @property {number} epoch
 * @property {number} attempts
 * @property {number} retries
 * @property {number|null} retryAfter
 * @property {{ epoch: number, reason: string }|null} skip
 * @property {{ blocks: any[], regionKey: string, usage?: any }|null} pending
 * @property {boolean} failedGeneration
 * @property {boolean} skipLogged
 * @property {boolean} waitLogged
 * @property {boolean} rejectLogged
 */

/**
 * A generated turn summary waiting for the next boundary to commit it (docs/03 §5.6). It has no
 * task id: the implicit fold is keyed by its span and leaves no `task_end` meta behind.
 *
 * @typedef {object} ImplicitJob
 * @property {number} id the pass boundary that started it, unique within the session
 * @property {number} turn the `turn/start` seq of the turn it summarizes
 * @property {number} epoch the surface epoch its region was resolved at
 * @property {number} start
 * @property {number} end
 * @property {number} startIndex
 * @property {number} endIndex
 * @property {string} regionKey
 * @property {'generating'|'ready'} phase
 * @property {any[]|null} blocks the generated blocks, once the generation succeeded
 * @property {any} usage the provider accounting, once the generation succeeded
 */

/**
 * @typedef {object} SessionRuntime
 * @property {Map<string, TaskRuntime>} tasks
 * @property {{ taskId: string, epoch: number, regionKey: string }|null} generation
 * @property {ImplicitJob|null} implicit the turn fold's generation, at most one per session
 * @property {number|null} implicitTurn the turn the implicit fold already ran for
 * @property {number} boundary
 * @property {boolean} busy
 */

/**
 * @typedef {object} EnterPass
 * @property {'enter-pass'} type
 */

/**
 * @typedef {object} LeavePass
 * @property {'leave-pass'} type
 */

/**
 * @typedef {object} BoundaryTick
 * @property {'boundary++'} type
 */

/**
 * @typedef {object} StartGeneration
 * @property {'start-generation'} type
 * @property {string} taskId
 * @property {number} epoch
 * @property {string} regionKey
 */

/**
 * @typedef {object} GenerationFinished
 * @property {'generation-finished'} type
 * @property {string} taskId
 * @property {'ok'|'failed'|'cancelled'} outcome
 * @property {any[]} [blocks] the prepared blocks, on the `ok` outcome
 * @property {any} [usage] the provider accounting, on the `ok` outcome
 */

/**
 * @typedef {object} CommitAction
 * @property {'commit-folded'|'commit-busy'|'commit-deferred'} type
 * @property {string} taskId
 * @property {number} [epoch]
 */

/**
 * @typedef {object} DropPending
 * @property {'drop-pending'} type
 * @property {string} taskId
 */

/**
 * @typedef {object} Skip
 * @property {'skip'} type
 * @property {string} taskId
 * @property {number} epoch
 * @property {string} reason
 */

/**
 * @typedef {object} UnsplitSkip
 * @property {'unsplit-skip'} type
 * @property {string} taskId
 * @property {number} epoch
 */

/**
 * @typedef {object} Retry
 * @property {'retry'} type
 * @property {string} taskId
 * @property {number} [epoch]
 */

/**
 * @typedef {object} ClearRetry
 * @property {'clear-retry'} type
 * @property {string} taskId
 */

/**
 * @typedef {object} RecordFailure
 * @property {'record-failure'} type
 * @property {string} taskId
 * @property {boolean} recorded whether the host was asked to write the durable failed attempt
 */

/**
 * @typedef {object} ClaimRejectLog
 * @property {'claim-reject-log'} type
 * @property {string} taskId
 */

/**
 * @typedef {object} PruneTerminal
 * @property {'prune-terminal'} type
 * @property {ReadonlySet<string>} waiting tasks the projection still calls waiting
 * @property {ReadonlySet<string>} terminal tasks the projection calls terminal (or that vanished)
 */

/**
 * @typedef {object} StartImplicit
 * @property {'start-implicit'} type
 * @property {number} id
 * @property {number} turn
 * @property {number} epoch
 * @property {number} start
 * @property {number} end
 * @property {number} startIndex
 * @property {number} endIndex
 * @property {string} regionKey
 */

/**
 * @typedef {object} ImplicitFinished
 * @property {'implicit-finished'} type
 * @property {number} id
 * @property {'ok'|'failed'|'cancelled'} outcome
 * @property {any[]} [blocks] the prepared blocks, on the `ok` outcome
 * @property {any} [usage] the provider accounting, on the `ok` outcome
 */

/**
 * @typedef {object} ImplicitCleared
 * @property {'implicit-committed'|'implicit-dropped'} type
 * @property {number} id
 */

/**
 * @typedef {EnterPass | LeavePass | BoundaryTick | StartGeneration | GenerationFinished
 *   | CommitAction | DropPending | Skip | UnsplitSkip | Retry | ClearRetry | RecordFailure
 *   | ClaimRejectLog | PruneTerminal | StartImplicit | ImplicitFinished | ImplicitCleared} Action
 */

/** @returns {SessionRuntime} */
export function createSessionRuntime() {
  return { tasks: new Map(), generation: null, implicit: null, implicitTurn: null, boundary: 0, busy: false }
}

/**
 * A task's runtime, or undefined when the runtime has no private fact about it. Callers treat a
 * missing entry as a task that is still `waiting`: the reducer only materialises an entry when it
 * decides something about the task.
 *
 * @param {SessionRuntime} runtime
 * @param {string} taskId
 * @returns {TaskRuntime|undefined}
 */
export function taskRuntime(runtime, taskId) {
  return runtime.tasks.get(taskId)
}

/**
 * The reason a skip is in force at `epoch`, or undefined when no skip applies. A skip belongs to the
 * surface version it was decided at (docs/10 §12): a replacement moves the epoch and the task is
 * examined again, which is the F9 fix.
 *
 * @param {TaskRuntime|undefined} task
 * @param {number} epoch
 * @returns {string|undefined}
 */
export function skipReason(task, epoch) {
  if (task === undefined || task.skip === null) return undefined
  return task.skip.epoch === epoch ? task.skip.reason : undefined
}

/**
 * @param {TaskRuntime|undefined} task
 * @param {number} boundary
 * @returns {boolean}
 */
export function isBackingOff(task, boundary) {
  return task !== undefined && task.retryAfter !== null && task.retryAfter > boundary
}

/** @returns {TaskRuntime} */
function newTaskRuntime() {
  return {
    phase: 'waiting',
    epoch: 0,
    attempts: 0,
    retries: 0,
    retryAfter: null,
    skip: null,
    pending: null,
    failedGeneration: false,
    skipLogged: false,
    waitLogged: false,
    rejectLogged: false,
  }
}

/**
 * The task's entry, or a fresh waiting one — the reducer materialises it only on a real transition.
 *
 * @param {SessionRuntime} runtime
 * @param {string} taskId
 * @returns {TaskRuntime}
 */
function entryOf(runtime, taskId) {
  return runtime.tasks.get(taskId) ?? newTaskRuntime()
}

/**
 * @param {SessionRuntime} runtime
 * @param {string} taskId
 * @param {TaskRuntime} task
 * @returns {SessionRuntime}
 */
function withTask(runtime, taskId, task) {
  const tasks = new Map(runtime.tasks)
  tasks.set(taskId, task)
  return { ...runtime, tasks }
}

/**
 * @param {SessionRuntime} runtime
 * @param {string} taskId
 * @param {Partial<TaskRuntime>} patch
 * @returns {SessionRuntime}
 */
function patchTask(runtime, taskId, patch) {
  return withTask(runtime, taskId, { ...entryOf(runtime, taskId), ...patch })
}

/**
 * @param {CommitAction} action
 * @param {TaskRuntime} task
 * @returns {number}
 */
function epochOf(action, task) {
  return action.epoch === undefined ? task.epoch : action.epoch
}

/**
 * Apply one action to one session's runtime (docs/10 §4.2). A no-op — a transition the §12 failure
 * table forbids, an action that would not change anything, a repeated boundary-independent fact —
 * returns the very same object, so a caller can compare by identity.
 *
 * @param {SessionRuntime} runtime
 * @param {Action} action
 * @returns {SessionRuntime}
 */
export function reduce(runtime, action) {
  switch (action.type) {
    case 'enter-pass':
      return runtime.busy ? runtime : { ...runtime, busy: true }
    case 'leave-pass':
      return runtime.busy ? { ...runtime, busy: false } : runtime
    case 'boundary++':
      return { ...runtime, boundary: runtime.boundary + 1 }
    case 'start-generation':
      return startGeneration(runtime, action)
    case 'generation-finished':
      return generationFinished(runtime, action)
    case 'commit-folded':
      return commitFolded(runtime, action)
    case 'commit-busy':
      return commitBusy(runtime, action)
    case 'commit-deferred':
      return commitDeferred(runtime, action)
    case 'drop-pending':
      return dropPending(runtime, action)
    case 'skip':
      return recordSkip(runtime, action)
    case 'unsplit-skip':
      return unsplitSkip(runtime, action)
    case 'retry':
      return retryLater(runtime, action)
    case 'clear-retry':
      return clearRetry(runtime, action)
    case 'record-failure':
      return recordFailure(runtime, action)
    case 'claim-reject-log':
      return claimRejectLog(runtime, action)
    case 'prune-terminal':
      return pruneTerminal(runtime, action)
    case 'start-implicit':
      return startImplicit(runtime, action)
    case 'implicit-finished':
      return implicitFinished(runtime, action)
    case 'implicit-committed':
    case 'implicit-dropped':
      return clearImplicit(runtime, action)
    default:
      return runtime
  }
}

/**
 * One generation per session (docs/10 §6). A second start while one is in flight is refused, and so
 * is an attempt for a task the durable cap already made terminal (docs/10 §12).
 *
 * @param {SessionRuntime} runtime
 * @param {StartGeneration} action
 * @returns {SessionRuntime}
 */
function startGeneration(runtime, action) {
  if (runtime.generation !== null) return runtime
  // A turn fold's generation is also an LLM call: one generation per session at a time (docs/10 §6).
  if (runtime.implicit !== null && runtime.implicit.phase === 'generating') return runtime
  const task = entryOf(runtime, action.taskId)
  if (task.attempts >= MAX_TASK_ATTEMPTS) return runtime
  const next = withTask(runtime, action.taskId, {
    ...task,
    phase: 'generating',
    epoch: action.epoch,
  })
  return {
    ...next,
    generation: { taskId: action.taskId, epoch: action.epoch, regionKey: action.regionKey },
  }
}

/**
 * The generation settled. The runner owns the region key, so the reducer takes it from the
 * generation record and never from the result (docs/10 §6). A settlement for a generation that is
 * not the one in flight is refused rather than allowed to write a stale summary.
 *
 * @param {SessionRuntime} runtime
 * @param {GenerationFinished} action
 * @returns {SessionRuntime}
 */
function generationFinished(runtime, action) {
  const generation = runtime.generation
  if (generation === null || generation.taskId !== action.taskId) return runtime
  const task = entryOf(runtime, action.taskId)
  /** @type {TaskRuntime} */
  let next
  if (action.outcome === 'ok') {
    next = {
      ...task,
      phase: 'waiting',
      epoch: generation.epoch,
      pending: {
        blocks: action.blocks ?? [],
        regionKey: generation.regionKey,
        ...(action.usage === undefined ? {} : { usage: action.usage }),
      },
    }
  } else if (action.outcome === 'failed') {
    // The durable record is owed; it is written at a later boundary, never inside the handler
    // (docs/03 §5.4), so the counter does not move yet.
    next = { ...task, phase: 'failed', epoch: generation.epoch, failedGeneration: true }
  } else {
    // A cancelled turn produced nothing: the durable cap must not move (docs/10 §12).
    next = { ...task, phase: 'cancelled', epoch: generation.epoch }
  }
  return { ...withTask(runtime, action.taskId, next), generation: null }
}

/**
 * @param {SessionRuntime} runtime
 * @param {CommitAction} action
 * @returns {SessionRuntime}
 */
function commitFolded(runtime, action) {
  const task = entryOf(runtime, action.taskId)
  if (task.phase !== 'waiting') return runtime
  return withTask(runtime, action.taskId, {
    ...task,
    phase: 'folded',
    epoch: epochOf(action, task),
    pending: null,
    failedGeneration: false,
    retries: 0,
    retryAfter: null,
  })
}

/**
 * A busy lock is not an error, but a task that waits silently for the whole process is
 * unobservable, so the first give-up is explained once per task. The flag is the whole transition:
 * a second give-up changes nothing and logs nothing (docs/03 §5.5).
 *
 * @param {SessionRuntime} runtime
 * @param {CommitAction} action
 * @returns {SessionRuntime}
 */
function commitBusy(runtime, action) {
  const task = entryOf(runtime, action.taskId)
  if (task.phase !== 'waiting' || task.waitLogged) return runtime
  return patchTask(runtime, action.taskId, { waitLogged: true, epoch: epochOf(action, task) })
}

/**
 * The commit did not happen yet but the task is still foldable; only the epoch it was deferred at
 * is worth recording.
 *
 * @param {SessionRuntime} runtime
 * @param {CommitAction} action
 * @returns {SessionRuntime}
 */
function commitDeferred(runtime, action) {
  const task = entryOf(runtime, action.taskId)
  if (task.phase !== 'waiting') return runtime
  const epoch = epochOf(action, task)
  return epoch === task.epoch ? runtime : patchTask(runtime, action.taskId, { epoch })
}

/**
 * @param {SessionRuntime} runtime
 * @param {DropPending} action
 * @returns {SessionRuntime}
 */
function dropPending(runtime, action) {
  const task = runtime.tasks.get(action.taskId)
  if (task === undefined || task.pending === null) return runtime
  return patchTask(runtime, action.taskId, { pending: null })
}

/**
 * A skip is recorded once per task and belongs to the epoch it was decided at. The record is
 * deliberately never overwritten: the runner explains a skip once per task for the process, and a
 * stale record stops applying when the epoch moves (see `unsplit-skip`) instead of being replaced.
 * A skip decided at an epoch older than the task's current phase is refused.
 *
 * @param {SessionRuntime} runtime
 * @param {Skip} action
 * @returns {SessionRuntime}
 */
function recordSkip(runtime, action) {
  const task = entryOf(runtime, action.taskId)
  if (task.skipLogged || action.epoch < task.epoch) return runtime
  return patchTask(runtime, action.taskId, {
    phase: 'skipped',
    epoch: action.epoch,
    skip: { epoch: action.epoch, reason: action.reason },
    skipLogged: true,
  })
}

/**
 * The surface moved, so the skip decided at the old version no longer applies: the task is waiting
 * again. The one-line explanation already happened, so `skipLogged` stays true and a later skip at
 * the new epoch is a no-op rather than a second log (docs/10 §12: a skip is for this epoch only).
 *
 * @param {SessionRuntime} runtime
 * @param {UnsplitSkip} action
 * @returns {SessionRuntime}
 */
function unsplitSkip(runtime, action) {
  const task = runtime.tasks.get(action.taskId)
  if (task === undefined || task.skip === null || task.skip.epoch === action.epoch) return runtime
  return patchTask(runtime, action.taskId, {
    skip: null,
    phase: task.phase === 'skipped' ? 'waiting' : task.phase,
    epoch: action.epoch,
  })
}

/**
 * An unexpected fold failure backs off 1, 2, 4, 8 boundaries (docs/03 §5.3). The delay is a
 * function of the in-memory retry count, not of the durable failure count: a fold that keeps
 * failing keeps retrying at the capped delay.
 *
 * @param {SessionRuntime} runtime
 * @param {Retry} action
 * @returns {SessionRuntime}
 */
function retryLater(runtime, action) {
  const task = entryOf(runtime, action.taskId)
  if (isBackingOff(task, runtime.boundary)) return runtime
  const retries = task.retries + 1
  const delay = Math.min(2 ** (retries - 1), MAX_BACKOFF_BOUNDARIES)
  return patchTask(runtime, action.taskId, {
    retries,
    retryAfter: runtime.boundary + delay,
    epoch: action.epoch === undefined ? task.epoch : action.epoch,
  })
}

/**
 * @param {SessionRuntime} runtime
 * @param {ClearRetry} action
 * @returns {SessionRuntime}
 */
function clearRetry(runtime, action) {
  const task = runtime.tasks.get(action.taskId)
  if (task === undefined || (task.retryAfter === null && task.retries === 0)) return runtime
  return patchTask(runtime, action.taskId, { retries: 0, retryAfter: null })
}

/**
 * A failed generation is now durable: one record per attempt, and the cap makes the task terminal
 * (docs/10 §12). The flag is cleared either way — a generation that could not be recorded is still
 * consumed, exactly once. Reaching the cap is the only way a task becomes terminally `failed` in
 * the runtime, and `start-generation` refuses to start another attempt from there.
 *
 * @param {SessionRuntime} runtime
 * @param {RecordFailure} action
 * @returns {SessionRuntime}
 */
function recordFailure(runtime, action) {
  const task = entryOf(runtime, action.taskId)
  if (!task.failedGeneration) return runtime
  const attempts = action.recorded ? task.attempts + 1 : task.attempts
  return patchTask(runtime, action.taskId, {
    failedGeneration: false,
    attempts,
    phase: action.recorded && attempts >= MAX_TASK_ATTEMPTS ? 'failed' : 'waiting',
  })
}

/**
 * Start at most one implicit turn generation per session and per turn (docs/03 §5.6). A second
 * start is refused while a generation is in flight, after one was already committed or dropped for
 * the same turn (`implicitTurn`), and for a state the caller could not bind to a turn.
 *
 * @param {SessionRuntime} runtime
 * @param {StartImplicit} action
 * @returns {SessionRuntime}
 */
function startImplicit(runtime, action) {
  if (runtime.implicit !== null || runtime.generation !== null) return runtime
  if (runtime.implicitTurn === action.turn) return runtime
  /** @type {ImplicitJob} */
  const job = {
    id: action.id,
    turn: action.turn,
    epoch: action.epoch,
    start: action.start,
    end: action.end,
    startIndex: action.startIndex,
    endIndex: action.endIndex,
    regionKey: action.regionKey,
    phase: 'generating',
    blocks: null,
    usage: undefined,
  }
  return { ...runtime, implicit: job, implicitTurn: action.turn }
}

/**
 * The turn's generation settled. A failure or a cancellation drops the job silently: the implicit
 * fold has no durable failure accounting (docs/03 §5.6), so the cap's counter is not touched.
 *
 * @param {SessionRuntime} runtime
 * @param {ImplicitFinished} action
 * @returns {SessionRuntime}
 */
function implicitFinished(runtime, action) {
  const job = runtime.implicit
  if (job === null || job.id !== action.id || job.phase !== 'generating') return runtime
  if (action.outcome !== 'ok') return { ...runtime, implicit: null }
  return {
    ...runtime,
    implicit: {
      ...job,
      phase: 'ready',
      blocks: action.blocks ?? [],
      usage: action.usage,
    },
  }
}

/**
 * The job's one terminal outcome: committed, or dropped because the surface moved under it.
 *
 * @param {SessionRuntime} runtime
 * @param {ImplicitCleared} action
 * @returns {SessionRuntime}
 */
function clearImplicit(runtime, action) {
  const job = runtime.implicit
  if (job === null || job.id !== action.id) return runtime
  return { ...runtime, implicit: null }
}

/**
 * @param {SessionRuntime} runtime
 * @param {ClaimRejectLog} action
 * @returns {SessionRuntime}
 */
function claimRejectLog(runtime, action) {
  const task = entryOf(runtime, action.taskId)
  if (task.rejectLogged) return runtime
  return patchTask(runtime, action.taskId, { rejectLogged: true })
}

/**
 * Forget private state for tasks that can no longer fold. A task that became terminal without being
 * due again (an external compaction covered its span) would otherwise hold its pending blocks and
 * its retry record for the whole session.
 *
 * @param {SessionRuntime} runtime
 * @param {PruneTerminal} action
 * @returns {SessionRuntime}
 */
function pruneTerminal(runtime, action) {
  /** @type {Map<string, TaskRuntime>|null} */
  let next = null
  for (const [taskId, task] of runtime.tasks) {
    const terminal = action.terminal.has(taskId)
    const clearPending = !action.waiting.has(taskId) && task.pending !== null
    if (!terminal && !clearPending) continue
    next ??= new Map(runtime.tasks)
    if (terminal) next.delete(taskId)
    else next.set(taskId, { ...task, pending: null })
  }
  return next === null ? runtime : { ...runtime, tasks: next }
}
