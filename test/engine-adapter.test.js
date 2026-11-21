// The compaction port (docs/10 §7, docs/adr/0004-engine-adapter.md): the shim builds a plugin-owned
// engine on a shim context, hands the prepared blocks to the host's transaction through the object
// contract, and registers nothing on the realm.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { NativeCompactionPort } from '../host/ports/compaction-native.js'
import { createCompactionPort, resetCompactionPort } from '../host/ports/compaction.js'

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
 * A stub engine that keeps the error summarize() threw, so a test can prove `reject` fails the
 * transaction inside the summarize stage rather than before it.
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

/** @param {any} agent @param {number} startSeq @param {number} endSeq @param {any} blocks @param {any} route */
function foldRequest(agent, startSeq, endSeq, blocks, route) {
  return { agent, region: { startSeq, endSeq }, blocks, route, usage: undefined, signal: undefined }
}

test('the engine is constructed on a shim: nothing is provided on the realm context', async () => {
  resetCompactionPort()
  const ctx = context()
  const port = await createCompactionPort(ctx, { loader: loader() })
  assert.ok(port, 'the port was built')
  assert.equal(StubEngine.constructed, 1)
  assert.deepEqual(ctx.provided, [], 'the realm context was never asked to provide compaction')
})

test('summarize returns exactly the prepared blocks and the recorded route', async () => {
  resetCompactionPort()
  const ctx = context()
  const port = await createCompactionPort(ctx, { loader: loader() })
  assert.ok(port)
  const agent = { session: { id: 's' }, options: { provider: 'agent-provider', model: 'agent-model' } }
  const blocks = [{ type: 'text', text: '# T1 · t\nbody\n\n— fold of T1' }]
  const result = await port.fold(foldRequest(agent, 3, 9, blocks, { provider: 'p', model: 'm' }))
  assert.deepEqual(result, {
    start: 3,
    end: 9,
    summary: blocks,
    provider: 'p',
    model: 'm',
  })
})

test('a fold never touches the LLM seam', async () => {
  resetCompactionPort()
  const ctx = context({
    llm: {
      stream() {
        throw new Error('a self fold must not call ctx.llm.stream')
      },
    },
  })
  const port = await createCompactionPort(ctx, { loader: loader() })
  assert.ok(port)
  const agent = { session: { id: 's' }, options: {} }
  const result = await port.fold(
    foldRequest(agent, 1, 2, [{ type: 'text', text: 'x' }], { provider: 'p', model: 'm' }),
  )
  assert.deepEqual(result.summary, [{ type: 'text', text: 'x' }])
})

test('a fold forwards the delegate usage into the prepared summary', async () => {
  resetCompactionPort()
  const port = await createCompactionPort(context(), { loader: loader() })
  assert.ok(port)
  const agent = { session: { id: 's' }, options: {} }
  const request = foldRequest(agent, 1, 2, [{ type: 'text', text: 'x' }], {
    provider: 'p',
    model: 'm',
  })
  const usage = { inputTokens: 3, outputTokens: 5, cacheReadTokens: 900 }
  const result = await port.fold({ ...request, usage })
  assert.deepEqual(result.usage, usage, 'usage is what the host records on compaction/summary')
})

test('reject fails the transaction inside summarize, with a fixed error', async () => {
  resetCompactionPort()
  RecordingEngine.instances = []
  const port = await createCompactionPort(context(), { loader: recordingLoader })
  assert.ok(port)
  const agent = { session: { id: 's' }, options: {} }
  await assert.rejects(port.reject({ agent, region: { startSeq: 3, endSeq: 9 }, signal: undefined }), {
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
  resetCompactionPort()
  const port = await createCompactionPort(context(), { loader: loader() })
  assert.ok(port)
  const agent = { session: { id: 's' }, options: {} }
  await assert.rejects(port.reject({ agent, region: { startSeq: 3, endSeq: 9 }, signal: undefined }))
  const blocks = [{ type: 'text', text: '# T1 · t\nbody\n\n— fold of T1' }]
  const result = await port.fold(foldRequest(agent, 1, 2, blocks, { provider: 'p', model: 'm' }))
  assert.deepEqual(result, { start: 1, end: 2, summary: blocks, provider: 'p', model: 'm' })
})

test('classify separates busy, a refused summary and everything else', async () => {
  resetCompactionPort()
  const port = await createCompactionPort(context(), { loader: loader() })
  assert.ok(port)
  assert.equal(port.classify(new BusyError('busy')), 'busy')
  assert.equal(
    port.classify(
      new Error('summary is not smaller than the shadowed content (12 estimated framed tokens >= 9)'),
    ),
    'summary',
  )
  assert.equal(port.classify(new Error('boom')), 'other')
  assert.equal(port.classify('not an error'), 'other')
  assert.equal(port.classify(null), 'other')
})

test('the pairing helpers are the host exports', async () => {
  resetCompactionPort()
  const port = await createCompactionPort(context(), { loader: loader() })
  assert.ok(port)
  assert.equal(port.balancedBefore({ id: 's' }, 1), true)
  assert.equal(port.balancedBefore({ id: 'unbalanced' }, 1), false)
  assert.equal(port.balancedAfter({ id: 's' }, 1), true)
})

test('an unresolvable host package yields null once and is cached', async () => {
  resetCompactionPort()
  let calls = 0
  const failing = async () => {
    calls += 1
    throw new Error('not installed')
  }
  const first = await createCompactionPort(context(), { loader: failing })
  const second = await createCompactionPort(context(), { loader: failing })
  assert.equal(first, null)
  assert.equal(second, null)
  assert.equal(calls, 1, 'the failure is cached for the process')
})

test('a host package without the expected exports yields null', async () => {
  resetCompactionPort()
  const port = await createCompactionPort(context(), {
    loader: async (/** @type {string} */ spec) =>
      spec === '@deepseek-ai/dsh-compaction' ? PUBLIC_API : { nothing: true },
  })
  assert.equal(port, null)
})

test('the native stub has the same contract but refuses to be built', () => {
  // docs/10 §15: the public host API does not exist yet, so selecting this implementation would
  // silently disable folds. It has to fail loudly, and ports/compaction.js never selects it.
  assert.throws(() => new NativeCompactionPort(), {
    message: 'compaction-native: no public host API yet',
  })
})
