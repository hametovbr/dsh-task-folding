// The pre-step boundary (docs/10 §5): one flow with one owner. Fold what is due, choose at most one
// hint, then hand the host's own decision back with that hint appended. Keeping the three steps in
// one function is the point of docs/10 §16 step 7 — while the fold and the hint were registered as
// two handlers on the same event, only convention stopped them from disagreeing about the decision.

/** @typedef {import('../prompt/hints.js').Hint} Hint */
/** @typedef {import('../domain/settings.js').Settings} Settings */
/** @typedef {import('../domain/types.js').State} State */

/**
 * @typedef {object} PreStepDeps
 * @property {{ preStep(payload: any, next: () => Promise<any>): Promise<any> }} runner the fold pass
 * @property {{ handle?: Promise<{ stateOf(session: any): Promise<State> }> }} projection the
 *   registration promise `apply` keeps; the handlers must not see it
 * @property {() => Settings} settings a thunk, because the bundle config is read per step
 * @property {(state: State, settings: Settings) => Hint | null} hints the pure hint rule
 */

/**
 * The `agent/pre-step` waterfall handler. `runner.preStep` folds and calls `next()`, so the hint is
 * decided after the fold and on the host's own decision — never instead of it.
 *
 * @param {PreStepDeps} deps
 * @returns {(payload: any, next: () => Promise<any>) => Promise<any>}
 */
export function createPreStep({ runner, projection, settings, hints }) {
  /**
   * The projection handle is a promise while the host registers it; resolving it here keeps the
   * handler body the sequence it is called for instead of awaiting a Promise in its middle.
   *
   * @param {any} session
   * @returns {Promise<State | null>} null when the plugin never registered a projection
   */
  async function stateOf(session) {
    if (projection.handle === undefined) return null
    return (await projection.handle).stateOf(session)
  }

  return async function onPreStep(payload, next) {
    const decision = await runner.preStep(payload, next)
    // Only an enter decision carries messages; anything else is the host's own answer, untouched.
    if (!decision || decision.kind !== 'enter') return decision
    const session = payload?.agent?.session
    if (!session) return decision
    const state = await stateOf(session)
    if (state === null) return decision
    const hint = hints(state, settings())
    if (hint === null) return decision
    // The id is the durable message's identity: the host rejects a logged message without one.
    return {
      ...decision,
      messages: [...decision.messages, { ...hint.message, id: `task-folding-hint:${hint.key}` }],
    }
  }
}
