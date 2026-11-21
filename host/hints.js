// The hint rules (docs/03 §8, docs/10 §10): the stale-task hint and the empty-span hint, each one
// per task and reason, published only when the projection's durable latch has not seen that key
// yet. Pure: no ctx, no I/O, no clock, no randomness. The caller appends one message to the
// `agent/pre-step` decision; once the host logs it, the projection records `source.key` as
// `hintKey`, so a restart does not publish it again.

import { ABSORBED } from './cuts.js'
import { HINT_SOURCE_KIND } from './projection.js'
import * as texts from './texts.js'

/** @typedef {import('./settings.js').Settings} Settings */
/** @typedef {import('./types.js').State} State */
/** @typedef {import('./types.js').Task} Task */

/**
 * The message the hint is delivered as. The host logs it as a `user/message`, whose `data` is the
 * message itself (docs/02 §2), and the projection reads `source` back from that data.
 *
 * @typedef {object} HintMessage
 * @property {'user'} role
 * @property {{ type: 'text', text: string }[]} content
 * @property {{ kind: typeof HINT_SOURCE_KIND, key: string }} source
 */

/**
 * One hint candidate: the message and the durable key the projection latches on.
 *
 * @typedef {object} Hint
 * @property {string} key
 * @property {HintMessage} message
 */

/**
 * The hint to publish now, or null when there is none. The age rule comes first: a stale open task
 * is what the model is working on, and the empty-span rule is advice about a task it has closed.
 *
 * @param {State} state
 * @param {Settings} settings
 * @returns {Hint | null}
 */
export function maybeHint(state, settings) {
  return ageHint(state, settings) ?? emptySpanHint(state)
}

/**
 * The age rule: the innermost open task has been open for `settings.staleTaskSteps` assistant
 * messages or more. `state.open` is the task stack, so its last element is that task.
 *
 * @param {State} state
 * @param {Settings} settings
 * @returns {Hint | null}
 */
function ageHint(state, settings) {
  const id = state.open.at(-1)
  if (id === undefined) return null
  const task = state.tasks[id]
  // The stack and the task table are only written together; an id without a task is nothing to
  // hint about, not a reason to throw on the pre-step path.
  if (task === undefined) return null
  const bucket = bucketFor(state.assistantCount - task.openedAt, settings.staleTaskSteps)
  if (bucket === null) return null
  const key = hintKeyFor(task.id, bucket)
  if (key === state.hintKey) return null
  return {
    key,
    message: {
      role: 'user',
      content: [{ type: 'text', text: texts.renderStaleTaskHint(task.id, task.title, bucket) }],
      source: { kind: HINT_SOURCE_KIND, key },
    },
  }
}

/**
 * The empty-span rule (docs/07 Q15, docs/10 §10): the most recently closed task that the tools
 * closed `below-floor` because its whole span was the closing message — the model packed
 * `task_begin` into the same assistant message as its first work calls, so everything the task did
 * was already behind `beginCut` when the span started. The hint is advice at closing time: open
 * the next task in its own message, before the work it covers.
 *
 * Only the latest such close is named: one hint per close, and a task that stays closed is not
 * worth a second message. `state.order` is creation order, and tasks close in `endMsgSeq` order, so
 * the largest `endMsgSeq` among the candidates is the most recently closed one.
 *
 * @param {State} state
 * @returns {Hint | null}
 */
function emptySpanHint(state) {
  /** @type {Task | null} */
  let latest = null
  /** @type {number} */
  let latestSeq = -1
  for (const id of state.order) {
    const task = state.tasks[id]
    if (task === undefined || !isEmptySpan(task)) continue
    const seq = task.endMsgSeq ?? -1
    if (seq > latestSeq) {
      latestSeq = seq
      latest = task
    }
  }
  if (latest === null) return null
  const key = emptySpanKeyFor(latest.id)
  if (key === state.hintKey) return null
  return {
    key,
    message: {
      role: 'user',
      content: [{ type: 'text', text: texts.renderEmptySpanHint(latest.id, latest.title) }],
      source: { kind: HINT_SOURCE_KIND, key },
    },
  }
}

/**
 * Whether a closed task is the Q15 shape. The projection stamps every field the rule reads, so the
 * condition is durable state and never text:
 *
 * - `closeBatch` copies the `task_end` verdict into `verdict` and derives `status`; the rule wants
 *   a task the tools judged `below-floor` and that stayed there. `delegate` waits for a generated
 *   summary and `folded` already has one, so neither may be told the begin batch swallowed the
 *   work.
 * - A `below-floor` task is terminal, so its cuts never move afterwards (the reducer skips
 *   terminal tasks when it translates cuts); `ABSORBED` here would mean a damaged log, not a span.
 * - `noteSurfaceAppend` stamps `spanStart` with the first surface node after the begin batch, and
 *   `closeBatch` stamps `endMsgSeq` with the assistant message that carried `task_end`. When those
 *   two are the same node, nothing between the begin cut and `endCut` belongs to the task: the span
 *   is the closing message alone. A task whose `begin` and `end` were in one batch never gets a
 *   span start at all (`spanStart === null`), which is the same "no work inside the span" shape.
 *
 * @param {Task} task
 * @returns {boolean}
 */
export function isEmptySpan(task) {
  if (task.verdict !== 'below-floor' || task.status !== 'below-floor') return false
  if (task.beginCut === null || task.beginCut === ABSORBED) return false
  if (task.endCut === null || task.endMsgSeq === null) return false
  if (task.spanStart === ABSORBED) return false
  return task.spanStart === null || task.spanStart === task.endMsgSeq
}

/**
 * The empty-span latch key `${taskId}:empty-span` (docs/10 §5). Like `hintKeyFor` it is durable
 * state once logged, so the shape must not change silently: an old key would stop matching and a
 * restart would publish a hint it has already seen.
 *
 * @param {string} taskId
 * @returns {string}
 */
export function emptySpanKeyFor(taskId) {
  return `${taskId}:empty-span`
}

/**
 * The step count the stale hint names: the configured `staleTaskSteps`, then twice and four times
 * it. Null while the task is younger than the first bucket.
 *
 * The design fixes the buckets at 25, 50 and 100, which is exactly this rule at the default
 * threshold. The threshold is a setting (5-1000), and keeping the literal numbers for every setting
 * would tell a task that is only considered stale at 40 that it has been open for "25+ steps".
 * Scaling the buckets keeps the text truthful; the documented default still reads 25, 50, 100.
 *
 * @param {number} age assistant messages since the task opened
 * @param {number} staleTaskSteps the clamped setting from host/settings.js
 * @returns {number | null}
 */
export function bucketFor(age, staleTaskSteps) {
  if (age >= staleTaskSteps * 4) return staleTaskSteps * 4
  if (age >= staleTaskSteps * 2) return staleTaskSteps * 2
  return age >= staleTaskSteps ? staleTaskSteps : null
}

/**
 * The age latch key `${taskId}:${bucket}` (docs/03 §8). The projection stores it verbatim as
 * durable state, so this format must not change silently: an old key would stop matching and a
 * restart would publish a hint it has already seen.
 *
 * @param {string} taskId
 * @param {number} bucket
 * @returns {string}
 */
export function hintKeyFor(taskId, bucket) {
  return `${taskId}:${bucket}`
}
