// The engine adapter (docs/adr/0004): it builds a plugin-owned engine on a shim context, hands
// the prepared blocks to the host's transaction, and never registers anything on the realm.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFoldEngine, resetFoldEngine } from '../host/engine-adapter.js'

/**
 * Stands in for BasicCompactionEngine: the same constructor contract (a Cordis Service that
 * provides its own name), the same single `summarize()` hook, the same `compactRegion` entry.
 */
class StubEngine {
  static constructed = 0
  /** @param {any} ctx @param {any} config */
  constructor(ctx, config = {}) {
    StubEngine.constructed += 1
    this.ctx = ctx
    this.config = config
    // What the real base class does through Cordis' Service constructor.
    ctx.reflect.provide('compaction', this)
    if (config.auto !== false) this.registerPressureHooks()
  }

  registerPressureHooks() {
    throw new Error('the fold engine must be built with auto: false')
  }

  /** @param {number} start @param {number} end @param {any} agent @param {AbortSignal} [signal] */
  async compactRegion(start, end, agent, signal) {
    this.transaction = { start, end, agent, signal }
    const summarized = /** @type {Record<string, unknown>} */ (
      await this.summarize({ messages: [] }, agent, signal)
    )
    return { start, end, ...summarized }
  }

  /** @param {...any} _args @returns {Promise<any>} */
  async summarize(..._args) {
    throw new Error('the adapter must override summarize')
  }
}

class BusyError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(`busy: ${code}`)
    this.code = code
  }
}

/**
 * A stub engine that keeps the error summarize() threw, so a test can prove rejectRegion fails
 * the transaction inside the summarize stage rather than before it.
 */
class RecordingEngine extends StubEngine {
  /** @type {RecordingEngine[]} */
  static instances = []
  /** @type {Error | null} */
  summarizeError = null

  /** @param {any} ctx @param {any} config */
  constructor(ctx, config) {
    super(ctx, config)
    RecordingEngine.instances.push(this)
  }

  /**
   * @override
   * @param {number} start
   * @param {number} end
   * @param {any} agent
   * @param {AbortSignal} [signal]
   */
  async compactRegion(start, end, agent, signal) {
    try {
      return await super.compactRegion(start, end, agent, signal)
    } catch (error) {
      this.summarizeError = /** @type {Error} */ (error)
      throw error
    }
  }
}

const recordingLoader = async (/** @type {string} */ spec) => {
  if (spec === '@deepseek-ai/dsh-compaction-basic')
    return { BasicCompactionEngine: RecordingEngine, default: RecordingEngine }
  if (spec === '@deepseek-ai/dsh-compaction') return PUBLIC_API
  return null
}

const PUBLIC_API = {
  ManualCompactionError: BusyError,
  /** @param {any} session @param {any} seq */
  toolPairingBalancedBefore: (session, seq) => session.id !== 'unbalanced' && seq !== 'bad',
  /** @param {any} session @param {any} seq */
  toolPairingBalancedAfter: (session, seq) => session.id !== 'unbalanced' && seq !== 'bad',
}

/** @param {{ fail?: Error, calls?: any[] }} [options] */
function loader(options = {}) {
  return async (/** @type {string} */ spec) => {
    if (options.fail) throw options.fail
    if (spec === '@deepseek-ai/dsh-compaction-basic')
      return { BasicCompactionEngine: StubEngine, default: StubEngine }
    if (spec === '@deepseek-ai/dsh-compaction') return PUBLIC_API
    return null
  }
}

/** @param {Record<string, unknown>} [overrides] */
function context(overrides = {}) {
  /** @type {string[]} */
  const provided = []
  return {
    provided,
    tokenMeter: { measure: () => ({ nodes: [] }), estimateMessage: () => 1 },
    logger: { warn() {}, info() {}, error() {} },
    get: (/** @type {string} */ name) => (name === 'sessions' ? { flush: async () => {} } : undefined),
    /** @param {...any} _args */
    waterfall(..._args) {
      return false
    },
    ...overrides,
  }
}

test('the engine is constructed on a shim: nothing is provided on the realm context', async () => {
  resetFoldEngine()
  const ctx = context()
  const engine = await createFoldEngine(ctx, { loader: loader() })
  assert.ok(engine, 'the engine was built')
  assert.equal(StubEngine.constructed, 1)
  assert.deepEqual(ctx.provided, [], 'the realm context was never asked to provide compaction')
})

test('summarize returns exactly the prepared blocks and the recorded route', async () => {
  resetFoldEngine()
  const ctx = context()
  const engine = await createFoldEngine(ctx, { loader: loader() })
  assert.ok(engine)
  const agent = { session: { id: 's' }, options: { provider: 'agent-provider', model: 'agent-model' } }
  const blocks = [{ type: 'text', text: '# T1 · t\nbody\n\n— fold of T1' }]
  const result = await engine.foldRegion(agent, 3, 9, blocks, { provider: 'p', model: 'm' })
  assert.deepEqual(result, {
    start: 3,
    end: 9,
    summary: blocks,
    provider: 'p',
    model: 'm',
  })
})

test('a fold never touches the LLM seam', async () => {
  resetFoldEngine()
  const ctx = context({
    llm: {
      stream() {
        throw new Error('a self fold must not call ctx.llm.stream')
      },
    },
  })
  const engine = await createFoldEngine(ctx, { loader: loader() })
  assert.ok(engine)
  const agent = { session: { id: 's' }, options: {} }
  const result = await engine.foldRegion(agent, 1, 2, [{ type: 'text', text: 'x' }], {
    provider: 'p',
    model: 'm',
  })
  assert.deepEqual(result.summary, [{ type: 'text', text: 'x' }])
})

test('rejectRegion fails the transaction inside summarize, with a fixed error', async () => {
  resetFoldEngine()
  RecordingEngine.instances = []
  const engine = await createFoldEngine(context(), { loader: recordingLoader })
  assert.ok(engine)
  const agent = { session: { id: 's' }, options: {} }
  await assert.rejects(engine.rejectRegion(agent, 3, 9), {
    message: 'task-folding: the delegate summary could not be generated',
  })
  const recorded = RecordingEngine.instances.at(-1)
  assert.ok(recorded, 'the transaction ran on the plugin engine')
  assert.deepEqual(recorded.transaction, { start: 3, end: 9, agent, signal: undefined })
  assert.equal(
    recorded.summarizeError?.message,
    'task-folding: the delegate summary could not be generated',
    'summarize threw inside the transaction, so the host records compaction/end{error}',
  )
  assert.equal(/** @type {any} */ (recorded).reject, false, 'reject mode is cleared after the transaction')
})

test('a fold after a rejected region still returns the prepared blocks', async () => {
  resetFoldEngine()
  const engine = await createFoldEngine(context(), { loader: loader() })
  assert.ok(engine)
  const agent = { session: { id: 's' }, options: {} }
  await assert.rejects(engine.rejectRegion(agent, 3, 9))
  const blocks = [{ type: 'text', text: '# T1 · t\nbody\n\n— fold of T1' }]
  const result = await engine.foldRegion(agent, 1, 2, blocks, { provider: 'p', model: 'm' })
  assert.deepEqual(result, { start: 1, end: 2, summary: blocks, provider: 'p', model: 'm' })
})

test('classify separates busy, a refused summary and everything else', async () => {
  resetFoldEngine()
  const engine = await createFoldEngine(context(), { loader: loader() })
  assert.ok(engine)
  assert.equal(engine.classify(new BusyError('busy')), 'busy')
  assert.equal(
    engine.classify(
      new Error('summary is not smaller than the shadowed content (12 estimated framed tokens >= 9)'),
    ),
    'summary',
  )
  assert.equal(engine.classify(new Error('boom')), 'other')
  assert.equal(engine.classify('not an error'), 'other')
  assert.equal(engine.classify(null), 'other')
})

test('the pairing helpers are the host exports', async () => {
  resetFoldEngine()
  const engine = await createFoldEngine(context(), { loader: loader() })
  assert.ok(engine)
  assert.equal(engine.balancedBefore({ id: 's' }, 1), true)
  assert.equal(engine.balancedBefore({ id: 'unbalanced' }, 1), false)
  assert.equal(engine.balancedAfter({ id: 's' }, 1), true)
})

test('an unresolvable host package yields null once and is cached', async () => {
  resetFoldEngine()
  let calls = 0
  const failing = async () => {
    calls += 1
    throw new Error('not installed')
  }
  const first = await createFoldEngine(context(), { loader: failing })
  const second = await createFoldEngine(context(), { loader: failing })
  assert.equal(first, null)
  assert.equal(second, null)
  assert.equal(calls, 1, 'the failure is cached for the process')
})

test('a host package without the expected exports yields null', async () => {
  resetFoldEngine()
  const engine = await createFoldEngine(context(), {
    loader: async (/** @type {string} */ spec) =>
      spec === '@deepseek-ai/dsh-compaction' ? PUBLIC_API : { nothing: true },
  })
  assert.equal(engine, null)
})
