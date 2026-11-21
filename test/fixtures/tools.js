// Test harness that runs the real tool definitions against a Sim session, the way the native
// executor does: the assistant message is appended first, then each call is executed in order
// and its result (with the tool's meta) is committed before the next call starts.

import { SpanEstimator } from '../../host/domain/estimate.js'
import { defaults, readSettings } from '../../host/domain/settings.js'
import { createTools } from '../../host/tools/index.js'

/** @typedef {import('../../host/domain/types.js').SessionEvent} SessionEvent */
/** @typedef {import('./sim.js').Sim} Sim */

/**
 * The subset of a host session the tools read.
 *
 * @param {Sim} sim
 * @param {string} [id]
 */
export function sessionOf(sim, id = 'sim-session') {
  return {
    id,
    surface: { nodes: sim.nodes },
    /** @param {number} seq */
    eventAt: (seq) => sim.bySeq.get(seq),
    /** @param {SessionEvent} event */
    deriveEventMessage: (event) => {
      switch (event.type) {
        case 'user/message':
        case 'system/message':
          return event.data
        case 'assistant/message':
        case 'tool/result':
          return event.data.message
        default:
          return null
      }
    },
  }
}

/**
 * Predictable token estimator: a fixed cost per message plus a share of its text.
 *
 * @param {{ perMessage?: number, perChar?: number }} [options]
 */
export function fakeMeter(options = {}) {
  const perMessage = options.perMessage ?? 1000
  const perChar = options.perChar ?? 0
  return {
    /** @param {any} message */
    estimateMessage(message) {
      return perMessage + Math.ceil(textChars(message) * perChar)
    },
  }
}

/** @param {any} message */
function textChars(message) {
  const content = message && Array.isArray(message.content) ? message.content : []
  let chars = 0
  for (const block of content) if (block && block.type === 'text') chars += String(block.text).length
  return chars
}

/**
 * @param {Sim} sim
 * @param {{ settings?: object, meter?: { estimateMessage(message: any): number } }} [options]
 */
export function harnessOf(sim, options = {}) {
  const estimator = new SpanEstimator(options.meter ?? fakeMeter())
  const settings = options.settings
    ? readSettings(withVolatiles({ ...defaults(), ...options.settings }))
    : defaults()
  const tools = createTools({ stateOf: async () => sim.state, estimator, settings: () => settings })
  /** @type {Record<string, any>} */
  const byName = {}
  for (const tool of tools) byName[tool.name] = tool
  const session = sessionOf(sim)
  let callNo = 0

  return {
    tools,
    byName,
    session,
    estimator,
    settings,
    /**
     * Execute one call and, by default, commit its result with the meta the host would persist.
     *
     * @param {string} name
     * @param {any} args
     * @param {{ callId?: string, rootCallId?: string, deliver?: boolean }} [options]
     */
    async call(name, args, options = {}) {
      const callId = options.callId ?? `call_${callNo++}`
      const exec = {
        callId,
        rootCallId: options.rootCallId ?? callId,
        agent: { session },
        arguments: args,
      }
      const definition = byName[name]
      const value = await definition.execute(args, exec)
      const meta = definition.output.presentationMeta?.(args, value)
      if (options.deliver !== false) sim.result(callId, meta === undefined ? {} : { meta })
      const content = definition.output.render(args, value)
      return { value, meta, text: content.map((/** @type {any} */ block) => block.text).join('\n') }
    },

    /**
     * One full batch of calls, delivered in order.
     *
     * @param {{ name: string, args: any }[]} calls
     */
    async batch(calls) {
      const { ids } = sim.assistant(calls.map((c) => ({ name: c.name, args: c.args })))
      /** @type {{ value: any, meta: any, text: string }[]} */
      const out = []
      for (let i = 0; i < calls.length; i++) {
        const call = /** @type {{ name: string, args: any }} */ (calls[i])
        out.push(await this.call(call.name, call.args, { callId: /** @type {string} */ (ids[i]) }))
      }
      sim.stepEnd()
      return out
    },

    /**
     * One batch with exactly one call; accepts the call alone or a one-element list.
     *
     * @param {{ name: string, args: any } | { name: string, args: any }[]} call
     */
    async one(call) {
      const out = await this.batch(Array.isArray(call) ? call : [call])
      return at(out, 0)
    },
  }
}

/**
 * Wrap plain values in volatile readers, the shape a schemastery `.volatile()` field has.
 *
 * @param {Record<string, unknown>} values
 */
export function withVolatiles(values) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [key, value] of Object.entries(values)) out[key] = { get: () => value }
  return out
}

/**
 * @template T
 * @param {readonly T[]} list
 * @param {number} index
 * @returns {T}
 */
export function at(list, index) {
  const value = list[index]
  if (value === undefined) throw new Error(`no element ${index}`)
  return value
}
