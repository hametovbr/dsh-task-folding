// The stale-task hint (docs/03 §8, docs/04 §5): one hint per task and bucket, published only when
// the projection's durable latch has not seen that key yet. Pure: no ctx, no I/O, no clock, no
// randomness. The caller appends the message to the `agent/pre-step` decision; once the host logs
// it, the projection records `source.key` as `hintKey`, so a restart does not publish it again.

import { HINT_SOURCE_KIND } from './projection.js'
import * as texts from './texts.js'

/** @typedef {import('./settings.js').Settings} Settings */
/** @typedef {import('./types.js').State} State */

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
 * The hint to publish now, or null when there is none. `state.open` is the task stack, so its last
 * element is the task the model is working on.
 *
 * @param {State} state
 * @param {Settings} settings
 * @returns {{ key: string, message: HintMessage } | null}
 */
export function maybeHint(state, settings) {
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
 * The step count the hint names: the configured `staleTaskSteps`, then twice and four times it.
 * Null while the task is younger than the first bucket.
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
 * The latch key `${taskId}:${bucket}` (docs/03 §8). The projection stores it verbatim as durable
 * state, so this format must not change silently: an old key would stop matching and a restart
 * would publish a hint it has already seen.
 *
 * @param {string} taskId
 * @param {number} bucket
 * @returns {string}
 */
export function hintKeyFor(taskId, bucket) {
  return `${taskId}:${bucket}`
}
