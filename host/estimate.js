// Span token estimates with the host's own estimator (ctx.tokenMeter.estimateMessage).
// A seq's message never changes (a replacement gets a new seq), so per-seq estimates are cached
// per session, in insertion order, and bounded so a long-running host does not grow without limit.

/** @typedef {import('./types.js').Task} Task */

/**
 * @typedef {object} SessionLike
 * @property {string} id
 * @property {{ nodes: readonly number[] }} surface
 * @property {(seq: number) => any} eventAt
 * @property {(event: any) => any} deriveEventMessage
 */

/** @typedef {{ estimateMessage(message: any): number }} TokenMeter */

/** Cached seqs per session; a session is one conversation, so this is a few hours of work. */
export const CACHE_LIMIT = 20_000

export class SpanEstimator {
  /**
   * @param {TokenMeter} meter
   * @param {number} [limit]
   */
  constructor(meter, limit = CACHE_LIMIT) {
    this.meter = meter
    this.limit = limit
    /** @type {WeakMap<object, Map<number, number>>} */
    this.cache = new WeakMap()
  }

  /**
   * Tokens of the surface from the task's first span node to the current tail. Returns -1 when
   * the span cannot be located on the surface.
   *
   * @param {SessionLike} session
   * @param {Pick<Task, 'beginCut' | 'spanStart'>} task
   */
  span(session, task) {
    const nodes = session.surface.nodes
    let from = task.spanStart === null || task.spanStart < 0 ? -1 : nodes.indexOf(task.spanStart)
    if (from === -1 && task.beginCut !== null && task.beginCut >= 0) {
      const begin = nodes.indexOf(task.beginCut)
      if (begin !== -1) from = begin + 1
    }
    if (from === -1) return -1
    let total = 0
    for (let i = from; i < nodes.length; i++) total += this.node(session, /** @type {number} */ (nodes[i]))
    return total
  }

  /**
   * @param {SessionLike} session
   * @param {number} seq
   */
  node(session, seq) {
    // A seq is unique within one session, not across sessions, so the session is the outer key.
    let cache = this.cache.get(session)
    const hit = cache === undefined ? undefined : cache.get(seq)
    if (hit !== undefined) return hit
    const event = session.eventAt(seq)
    const message = event ? session.deriveEventMessage(event) : null
    const tokens = message ? safe(this.meter.estimateMessage(message)) : 0
    if (cache === undefined) {
      cache = new Map()
      this.cache.set(session, cache)
    } else if (cache.size >= this.limit) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(seq, tokens)
    return tokens
  }

  /** @param {string} text */
  text(text) {
    return safe(this.meter.estimateMessage({ role: 'user', content: [{ type: 'text', text }] }))
  }
}

/** @param {unknown} n */
function safe(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0
}
