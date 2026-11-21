// The compaction port against a public host API (docs/10 §15, ask 1): upstream `compactRegion` or a
// `compaction/summarize` waterfall that accepts prepared blocks would replace the shim entirely.
//
// This is a documented stub, not an implementation: there is no public host API yet, so its
// constructor throws and `ports/compaction.js` never selects it. It exists so the day the API lands
// the swap is one factory line, not a rewrite — and so the contract stays named in one place.

/** @typedef {import('./compaction.js').CompactionPort} CompactionPort */

/**
 * A `CompactionPort` that would talk to the host's public API.
 *
 * Every operation throws: selecting it today would silently disable folds, so the failure has to be
 * loud at the point of use. `ports/compaction.js` builds the shim implementation instead, and only a
 * future factory line selects this one.
 *
 * @implements {CompactionPort}
 */
export class NativeCompactionPort {
  /** @param {import('./compaction.js').FoldRequest} _request @returns {Promise<any>} */
  async fold(_request) {
    throw new Error('compaction-native: no public host API yet')
  }

  /** @param {import('./compaction.js').RejectRequest} _request @returns {Promise<any>} */
  async reject(_request) {
    throw new Error('compaction-native: no public host API yet')
  }

  /** @param {any} _session @param {number} _seq @returns {boolean} */
  balancedBefore(_session, _seq) {
    throw new Error('compaction-native: no public host API yet')
  }

  /** @param {any} _session @param {number} _seq @returns {boolean} */
  balancedAfter(_session, _seq) {
    throw new Error('compaction-native: no public host API yet')
  }

  /** @param {unknown} _error @returns {'busy' | 'summary' | 'other'} */
  classify(_error) {
    throw new Error('compaction-native: no public host API yet')
  }
}
