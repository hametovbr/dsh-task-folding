// The only module that knows @deepseek-ai/dsh-compaction-basic (docs/adr/0004-engine-adapter.md).
// It builds a plugin-owned BasicCompactionEngine subclass whose summarize() returns the blocks the
// fold runner prepared, so a fold costs no LLM call and keeps the host's lock, validation, pricing
// and commit path.
//
// The realm's own engine must survive this (docs/adr/0004 "Construction"): a Cordis Service
// registers itself through `ctx.reflect.provide(name, …)` in its constructor, so the subclass is
// constructed on a shim context whose `provide` is a no-op. The shim exposes only what the
// transaction reads; anything else the base class might touch throws instead of silently
// registering against the realm.

import { loadHostModule } from './resolve.js'

/** Codes that mean "not now, the durable compaction lock is held". */
const BUSY = 'busy'
/** The host's shrink check refuses a summary that is not smaller than the span (region.ts). */
const SUMMARY_TOO_LARGE = /^summary is not smaller than the shadowed content/

/**
 * @typedef {object} FoldRoute
 * @property {string} provider
 * @property {string} model
 */

/**
 * @typedef {object} FoldEngine
 * @property {(agent: any, start: number, end: number, blocks: any[], route: FoldRoute, signal?: AbortSignal) => Promise<any>} foldRegion
 * @property {(session: any, seq: number) => boolean} balancedBefore
 * @property {(session: any, seq: number) => boolean} balancedAfter
 * @property {(error: unknown) => 'busy' | 'summary' | 'other'} classify
 */

/** @type {Promise<FoldEngine | null> | undefined} */
let cached

/**
 * Build the fold engine once per process. A failure is cached too: the plugin keeps working
 * without folds and says so once (docs/03 §11).
 *
 * @param {any} ctx the plugin's context
 * @param {{ loader?: typeof loadHostModule }} [options] test seam
 * @returns {Promise<FoldEngine | null>}
 */
export function createFoldEngine(ctx, options = {}) {
  cached ??= build(ctx, options.loader ?? loadHostModule)
  return cached
}

/** Forget the cached engine (tests only). */
export function resetFoldEngine() {
  cached = undefined
}

/**
 * @param {any} ctx
 * @param {typeof loadHostModule} loader
 * @returns {Promise<FoldEngine | null>}
 */
async function build(ctx, loader) {
  try {
    return await assemble(ctx, loader)
  } catch {
    // A failed resolution is a cacheable "no folds" answer, not a crash (docs/03 §11).
    return null
  }
}

/**
 * @param {any} ctx
 * @param {typeof loadHostModule} loader
 * @returns {Promise<FoldEngine | null>}
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
      /** @type {{ summary: any[], provider: string, model: string } | null} */
      this.prepared = null
    }

    /**
     * The single subclass hook: hand back the blocks prepared for this fold, unmarked, so the
     * host records it as a template-style summary that never called the LLM seam.
     *
     * @param {any} _input
     * @param {any} _agent
     * @param {AbortSignal} [signal]
     */
    async summarize(_input, _agent, signal) {
      signal?.throwIfAborted?.()
      if (this.prepared === null)
        throw new Error('task-folding: the fold engine was asked to summarize without prepared blocks')
      return this.prepared
    }
  }

  const shim = shimContext(ctx)
  const engine = new FoldEngine(shim)

  return {
    async foldRegion(agent, start, end, blocks, route, signal) {
      engine.prepared = { summary: blocks, provider: route.provider, model: route.model }
      try {
        return await /** @type {any} */ (engine).compactRegion(start, end, agent, signal)
      } finally {
        engine.prepared = null
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
