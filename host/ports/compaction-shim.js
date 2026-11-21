// The compaction port against today's host internals (docs/10 §7): a plugin-owned
// BasicCompactionEngine subclass whose summarize() either returns the blocks the fold runner
// prepared, so a fold costs no LLM call, or rejects, so a failed delegate generation becomes a
// durable failed-compaction row (docs/07 Q11). Either way the host keeps its lock, validation,
// pricing and commit path.
//
// This is the only module that imports, resolves or references
// `@deepseek-ai/dsh-compaction-basic` and `@deepseek-ai/dsh-compaction` internals — the boundary
// docs/10 §7 and the engine-adapter ADR (docs/adr/0004-engine-adapter.md) put behind one port.
//
// The realm's own engine must survive this (docs/adr/0004 "Construction"): a Cordis Service
// registers itself through `ctx.reflect.provide(name, …)` in its constructor, so the subclass is
// constructed on a shim context whose `provide` is a no-op. The shim exposes only what the
// transaction reads; anything else the base class might touch throws instead of silently
// registering against the realm.

import { loadHostModule } from './host-services.js'

/** @typedef {import('./compaction.js').CompactionPort} CompactionPort */

/** Codes that mean "not now, the durable compaction lock is held". */
const BUSY = 'busy'
/** The host's shrink check refuses a summary that is not smaller than the span (region.ts). */
const SUMMARY_TOO_LARGE = /^summary is not smaller than the shadowed content/
/**
 * What a reject-mode summarize() throws. It never reaches the model: the host stores it in the
 * `compaction/end { error }` row that the projection counts toward the delegate failure cap.
 */
export const DELEGATE_SUMMARY_FAILED = 'task-folding: the delegate summary could not be generated'

/**
 * Build the port once per process. A failed resolution is a cacheable "no folds" answer, not a
 * crash (docs/03 §11).
 *
 * @param {any} ctx the plugin's context
 * @param {{ loader?: typeof loadHostModule }} [options] test seam: the host-package loader
 * @returns {Promise<CompactionPort | null>}
 */
export async function createShimCompactionPort(ctx, options = {}) {
  const loader = options.loader ?? loadHostModule
  try {
    return await assemble(ctx, loader)
  } catch {
    return null
  }
}

/**
 * @param {any} ctx
 * @param {typeof loadHostModule} loader
 * @returns {Promise<CompactionPort | null>}
 */
async function assemble(ctx, loader) {
  const basic = await loader('@deepseek-ai/dsh-compaction-basic')
  const publicApi = await loader('@deepseek-ai/dsh-compaction')
  const Base = (basic && basic.BasicCompactionEngine) || (basic && basic.default)
  if (typeof Base !== 'function' || !publicApi) return null
  const { ManualCompactionError, toolPairingBalancedBefore, toolPairingBalancedAfter } = publicApi
  if (typeof toolPairingBalancedBefore !== 'function' || typeof toolPairingBalancedAfter !== 'function')
    return null

  class FoldEngine extends Base {
    /** @param {any} shim */
    constructor(shim) {
      super(shim, { auto: false })
      /** @type {{ summary: any[], provider: string, model: string, usage?: any } | null} */
      this.prepared = null
      /** When set, summarize() rejects instead of returning prepared blocks (reject mode). */
      this.reject = false
    }

    /**
     * The single subclass hook: hand back the blocks prepared for this fold, unmarked, so the
     * host records it as a template-style summary that never called the LLM seam. In reject mode
     * the same hook fails instead, which is what turns a failed delegate generation into the
     * host's own `compaction/end { error }` record (docs/03 §5.4).
     *
     * @param {any} _input
     * @param {any} _agent
     * @param {AbortSignal} [signal]
     */
    async summarize(_input, _agent, signal) {
      signal?.throwIfAborted?.()
      if (this.reject) throw new Error(DELEGATE_SUMMARY_FAILED)
      if (this.prepared === null)
        throw new Error('task-folding: the fold engine was asked to summarize without prepared blocks')
      return this.prepared
    }
  }

  const shim = shimContext(ctx)
  const engine = new FoldEngine(shim)

  return {
    /**
     * @param {import('./compaction.js').FoldRequest} request
     * @returns {Promise<any>}
     */
    async fold(request) {
      const { agent, region, blocks, route, usage, signal } = request
      engine.prepared = {
        summary: blocks,
        provider: route.provider,
        model: route.model,
        ...(usage === undefined ? {} : { usage }),
      }
      try {
        return await /** @type {any} */ (engine).compactRegion(region.startSeq, region.endSeq, agent, signal)
      } finally {
        engine.prepared = null
      }
    },
    /**
     * Same transaction as `fold`, but summarize() rejects immediately: the host appends
     * `compaction/start` and then `compaction/end { error }` at zero LLM cost, which is the durable
     * delegate-failure record the projection counts (docs/07 Q11). The transaction rethrows, so the
     * caller sees the expected rejection; no prepared blocks are involved.
     *
     * @param {import('./compaction.js').RejectRequest} request
     * @returns {Promise<any>}
     */
    async reject(request) {
      const { agent, region, signal } = request
      engine.reject = true
      try {
        return await /** @type {any} */ (engine).compactRegion(region.startSeq, region.endSeq, agent, signal)
      } finally {
        engine.reject = false
      }
    },
    balancedBefore: (session, seq) => toolPairingBalancedBefore(session, seq),
    balancedAfter: (session, seq) => toolPairingBalancedAfter(session, seq),
    classify(error) {
      if (error instanceof ManualCompactionError && /** @type {any} */ (error).code === BUSY) return 'busy'
      const message = errorMessage(error)
      return SUMMARY_TOO_LARGE.test(message) ? 'summary' : 'other'
    },
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  if (typeof error !== 'object' || error === null) return ''
  const message = /** @type {{ message?: unknown }} */ (error).message
  return typeof message === 'string' ? message : ''
}

/**
 * What the base class and the compaction transaction read from their context. `provide` is the
 * no-op that keeps the realm's `compaction` service untouched; the rest are read-only forwards.
 *
 * @param {any} ctx
 */
function shimContext(ctx) {
  return {
    reflect: { provide: () => () => {} },
    tokenMeter: ctx.tokenMeter,
    logger: ctx.logger,
    /** @param {string} name */
    get: (name) => ctx.get(name),
    /** @param {...any} args */
    waterfall: (...args) => ctx.waterfall(...args),
  }
}
