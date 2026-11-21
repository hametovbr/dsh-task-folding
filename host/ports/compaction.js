// The compaction port (docs/10 §7): the one seam between the fold runner and the host's compaction
// transaction. `fold` either commits the whole prepared summary or throws without writing; `reject`
// writes a durable failed attempt at zero LLM cost, so a failed delegate generation still counts
// toward the cap the projection enforces (docs/03 §5.4, docs/07 Q11).
//
// The request is an object, not an argument list (docs/10 §4.3): a field can be added to it without
// breaking a caller, and `usage` — the delegate call's provider accounting — belongs to it from day
// one because the host records it on `compaction/summary` and that row is the only place the
// plugin's cache-hit can be audited (docs/03 §12 invariant 9).
//
// `compaction-shim.js` implements this contract against today's `BasicCompactionEngine`; it is the
// only module that resolves `@deepseek-ai/dsh-compaction-basic` (docs/10 §7). `compaction-native.js`
// is a stub for a public host API (docs/10 §15) and is deliberately not selected here.

import { createShimCompactionPort } from './compaction-shim.js'

/** @typedef {import('../types.js').TokenUsage} TokenUsage */

/**
 * The provider/model a fold is recorded under: the session's routed target at commit time.
 *
 * @typedef {object} FoldRoute
 * @property {string} provider
 * @property {string} model
 */

/**
 * Everything one fold commit needs, as one object (docs/10 §4.3). `region` carries the host's
 * replacement edges — the seqs the host replaces with the summary — because that is the only part
 * of a resolved region the transaction reads (docs/03 §5.3).
 *
 * @typedef {object} FoldRequest
 * @property {any} agent
 * @property {{startSeq:number, endSeq:number}} region   the host's replacement edges
 * @property {any[]} blocks
 * @property {FoldRoute} route
 * @property {import('../types.js').TokenUsage | undefined} usage
 * @property {AbortSignal | undefined} signal
 */

/**
 * A durable failed-attempt record: the same transaction shape with no prepared blocks, so the
 * host's summarize stage fails immediately (docs/03 §5.4).
 *
 * @typedef {object} RejectRequest
 * @property {any} agent
 * @property {{startSeq:number, endSeq:number}} region
 * @property {AbortSignal | undefined} signal
 */

/**
 * The plugin's own record of the summary it is committing.
 *
 * `source` is ours alone: the host records prepared blocks unmarked, so it cannot tell a
 * template-style summary (a self fold) from an LLM one (a delegate fold), and the cache audit has
 * to classify by `usage` presence — the one observable fact (docs/10 §8). Keeping the authorship
 * record here means the day the host gains a summary marker, the source is already named.
 *
 * @typedef {object} SummaryResult
 * @property {any[]} blocks
 * @property {FoldRoute} route
 * @property {TokenUsage | undefined} [usage] the call's provider accounting, on the delegate path
 * @property {'self' | 'delegate'} source our own record of authorship (docs/10 §8)
 */

/**
 * The port the fold runner depends on. A caller may assume that `fold` either writes the whole host
 * transaction or throws without writing, and that `reject` writes one failed-compaction record and
 * rethrows (docs/10 §7).
 *
 * @typedef {object} CompactionPort
 * @property {(request: FoldRequest) => Promise<any>} fold
 * @property {(request: RejectRequest) => Promise<any>} reject
 * @property {(session: any, seq: number) => boolean} balancedBefore
 * @property {(session: any, seq: number) => boolean} balancedAfter
 * @property {(error: unknown) => 'busy' | 'summary' | 'other'} classify
 */

/** @type {Promise<CompactionPort | null> | undefined} */
let cached

/**
 * Resolve the compaction port once per process. A failure is cached too: the plugin keeps working
 * without folds and says so once (docs/03 §11).
 *
 * @param {any} ctx the plugin's context
 * @param {{ loader?: (spec: string) => Promise<any> }} [options] test seam: the host-package loader
 * @returns {Promise<CompactionPort | null>}
 */
export function createCompactionPort(ctx, options = {}) {
  cached ??= createShimCompactionPort(ctx, options)
  return cached
}

/** Forget the cached port (tests only). */
export function resetCompactionPort() {
  cached = undefined
}
