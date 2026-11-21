// The three tools: task_begin, task_end, fold_recall (docs/03 §6, docs/04 §1). Each lives in its
// own module; this one composes them and owns the plumbing they share — the direct-call guard that
// stops a nested `run_code` call (whose result never reaches the log's meta channel) and the value
// describe used by an unknown-task error.
//
// The tools hold no state of their own: everything is read from the session projection, and the
// only durable write is `output.presentationMeta` → `tool/result.data.meta`, built by `./meta.js`.

import * as texts from '../domain/texts.js'
import { createBeginTool } from './task-begin.js'
import { createEndTool } from './task-end.js'
import { createRecallTool } from './recall.js'

/** @typedef {import('../domain/types.js').State} State */
/** @typedef {import('../domain/settings.js').Settings} Settings */
/** @typedef {import('../domain/estimate.js').SpanEstimator} SpanEstimator */

/**
 * What every tool reads (the public dependency set `plugin/mount.js` passes).
 *
 * @typedef {object} ToolDeps
 * @property {(session: any) => Promise<State>} stateOf read the projection for a session
 * @property {SpanEstimator} estimator
 * @property {() => Settings} settings read the live settings
 */

/**
 * What a tool module receives: the deps above plus the plumbing this module owns. Passing the two
 * functions in rather than importing them keeps a tool module on its own concern (and `recall.js`
 * importing nothing but the texts).
 *
 * @typedef {ToolDeps & {
 *   assertDirect: (exec: any, tool: string) => void,
 *   describe: (value: unknown) => string,
 * }} ToolInternals
 */

/**
 * @param {ToolDeps} deps
 * @returns {any[]} tool definitions, in registration order
 */
export function createTools(deps) {
  /** @type {ToolInternals} */
  const shared = { ...deps, assertDirect, describe }
  return [createBeginTool(shared), createEndTool(shared), createRecallTool(shared)]
}

/**
 * Task tools must be called directly: a PTC nested call is `<root>:ptc:<n>`, and no
 * `tool/result` is appended there, so its meta would never reach the projection.
 *
 * @param {any} exec
 * @param {string} tool
 */
function assertDirect(exec, tool) {
  if (!exec || typeof exec.callId !== 'string' || typeof exec.rootCallId !== 'string')
    throw new Error(texts.failure(tool, texts.ERR_NO_EXEC))
  if (exec.callId !== exec.rootCallId) throw new Error(texts.failure(tool, texts.ERR_NESTED(tool)))
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function describe(value) {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '?')
}
