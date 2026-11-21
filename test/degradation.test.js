// Degradation suite (docs/09-testing-plan.md T1). The plugin mounts into any profile, so every
// "the host is smaller than assumed" case is a supported mode with a defined behaviour, not a
// stack trace (docs/03 §11): no compaction engine, no `llm`, no registration sink, malformed
// `meta`, an unknown meta `stateVersion`, and a corrupt compaction record.
//
// The fakes are built here on purpose: T1 must keep asserting after the other test helpers move.
// The smallest useful shapes of `test/plugin.test.js` (`fakeContext`) and `test/fixtures/sim.js`
// (surface bookkeeping) are copied below; neither file is modified.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createCompactionPort, resetCompactionPort } from '../host/ports/compaction.js'
import plugin, { ENGINE_UNAVAILABLE, PLUGIN_NAME } from '../host/index.js'
import { apply, initialState, parseState, PROJECTION_KEY, STATE_VERSION } from '../host/projection.js'

/** @typedef {import('../host/types.js').SessionEvent} SessionEvent */
/** @typedef {import('../host/types.js').State} State */

/** The surface-carrying event types (docs/02 §2; host/projection.js:24). */
const SURFACE_TYPES = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result'])

// ---------------------------------------------------------------------------
// Fakes

/**
 * A Context stand-in that records registrations the way the host services do.
 *
 * @param {{ omit?: string[], estimate?: number }} [options] `omit` removes a service so the
 *   degradation path can be exercised; `estimate` is the token cost of one message.
 */
function fakeContext(options = {}) {
  /** @type {string[]} */
  const omit = options.omit ?? []
  /** @type {{ level: string, message: string }[]} */
  const logs = []
  /** @type {any[]} */
  const tools = []
  /** @type {any[]} */
  const projections = []
  /** @type {any[]} */
  const sections = []
  /** @type {{ event: string, handler: any }[]} */
  const listeners = []
  /** @type {string[]} */
  const gets = []
  let state = initialState()

  /** @type {any} */
  const ctx = {
    tokenMeter: { estimateMessage: () => options.estimate ?? 100 },
    /**
     * @param {string} event
     * @param {any} handler
     */
    on(event, handler) {
      listeners.push({ event, handler })
      return () => {}
    },
    /** @param {...any} _args */
    waterfall(..._args) {
      return false
    },
    /**
     * The plugin only asks for optional services (`llm`); every other service is injected by the
     * loader and absent here, which is exactly "no compaction engine in ctx".
     *
     * @param {string} name
     */
    get(name) {
      gets.push(name)
      return undefined
    },
    logger: {
      /** @param {string} message */
      warn(message) {
        logs.push({ level: 'warn', message })
      },
      /** @param {string} message */
      error(message) {
        logs.push({ level: 'error', message })
      },
      /** @param {string} message */
      info(message) {
        logs.push({ level: 'info', message })
      },
    },
    tools: {
      /** @param {any} definition */
      register(definition) {
        tools.push(definition)
        return () => {
          tools.splice(tools.indexOf(definition), 1)
        }
      },
    },
    sessionProjections: {
      /** @param {any} definition */
      register(definition) {
        projections.push(definition)
        return Promise.resolve({ stateOf: () => state })
      },
    },
    systemPrompt: {
      /** @param {any} section */
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
  }
  for (const name of omit) delete ctx[name]

  return {
    ctx,
    tools,
    projections,
    sections,
    logs,
    listeners,
    gets,
    get state() {
      return state
    },
    /** @param {State} next */
    setState(next) {
      state = next
    },
  }
}

/**
 * The subset of a host session the runner and the tools read (docs/02 §2). `eventAt` returns
 * undefined for a seq the script does not have, and `deriveEventMessage` returns `null` for a
 * non-surface event.
 *
 * @param {{ nodes: readonly number[], bySeq: Map<number, SessionEvent> }} source
 * @param {string} [id]
 */
function sessionOf(source, id = 'degradation-session') {
  return {
    id,
    surface: { nodes: source.nodes },
    /** @param {number} seq */
    eventAt: (seq) => source.bySeq.get(seq),
    /** @param {SessionEvent} event */
    deriveEventMessage(event) {
      if (event.type === 'user/message' || event.type === 'system/message') return event.data
      if (event.type === 'assistant/message' || event.type === 'tool/result')
        return event.data && event.data.message ? event.data.message : null
      return null
    },
  }
}

// ---------------------------------------------------------------------------
// Host-shaped events

/**
 * @param {number} seq
 * @param {string} type
 * @param {any} [data]
 * @param {Partial<SessionEvent>} [fields]
 * @returns {SessionEvent}
 */
function event(seq, type, data = {}, fields = {}) {
  return { type, seq, data, ...fields }
}

/**
 * @param {number} seq
 * @param {string} type
 * @param {any} [data]
 * @returns {SessionEvent}
 */
function append(seq, type, data = {}) {
  return event(seq, type, data, { surfaceOp: 'append' })
}

/** @param {number} seq */
function system(seq) {
  return append(seq, 'system/message', { role: 'system', content: [{ type: 'text', text: 'system' }] })
}

/**
 * @param {number} seq
 * @param {string} [text]
 */
function user(seq, text = 'work') {
  return append(seq, 'user/message', {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/**
 * @param {number} seq
 * @param {{ id: string, name: string }[]} calls
 */
function assistant(seq, calls) {
  const content = calls.map((call) => ({
    type: 'tool-call',
    id: call.id,
    name: call.name,
    arguments: '{}',
  }))
  return append(seq, 'assistant/message', {
    message: { role: 'assistant', content, source: { kind: 'model' } },
  })
}

/**
 * @param {number} seq
 * @param {string} callId
 * @param {unknown} meta `tool/result.data.meta`, as the host persists it
 */
function result(seq, callId, meta) {
  /** @type {Record<string, any>} */
  const data = {
    turn: 1,
    step: 1,
    message: {
      role: 'tool',
      source: { kind: 'tool', callId },
      toolCallId: callId,
      content: [{ type: 'text', text: 'result' }],
      isError: false,
    },
  }
  if (meta !== undefined) data.meta = meta
  return append(seq, 'tool/result', data)
}

/** @param {number} seq */
function stepEnd(seq) {
  return event(seq, 'step/end', {})
}

/**
 * @param {Record<string, unknown>} [overrides]
 */
function beginMeta(overrides = {}) {
  return { tf: 1, op: 'begin', id: 'T1', title: 'Fix login', parent: null, ...overrides }
}

/**
 * @param {string} callId
 * @param {string} [verdict]
 */
function endMeta(callId, verdict = 'queued') {
  return {
    tf: 1,
    op: 'end',
    id: 'T1',
    merged: [],
    verdict,
    outcome: 'done',
    estTokens: 100,
    summaryChars: 400,
    callId,
  }
}

/**
 * Replay host-shaped events through the real projection, keeping the surface the way the host
 * does (the smallest useful piece of test/fixtures/sim.js, copied, not modified).
 *
 * @param {SessionEvent[]} events
 */
function replay(events) {
  /** @type {number[]} */
  const nodes = []
  /** @type {Map<number, SessionEvent>} */
  const bySeq = new Map()
  let state = initialState()
  for (const next of events) {
    bySeq.set(next.seq, next)
    if (SURFACE_TYPES.has(next.type)) {
      const op = next.surfaceOp
      if (op === 'append' || op === undefined) nodes.push(next.seq)
      else if (typeof op === 'object') {
        const i = nodes.indexOf(op.startSeq)
        const j = nodes.indexOf(op.endSeq)
        if (i === -1 || j === -1 || i > j)
          throw new Error(`replay: bad replace range ${op.startSeq}..${op.endSeq}`)
        nodes.splice(i, j - i + 1, next.seq)
      }
    }
    state = apply(state, next)
  }
  return { state, nodes, bySeq, session: sessionOf({ nodes, bySeq }) }
}

/**
 * @param {State} state
 * @param {SessionEvent[]} events
 * @returns {State}
 */
function feed(state, events) {
  return events.reduce((current, next) => apply(current, next), state)
}

/**
 * The events of one task: a begin batch, its first span node, an end batch and a report message
 * that makes the closed task due (host/planner.js `dueTasks`).
 *
 * @param {string} [verdict]
 * @returns {SessionEvent[]}
 */
function taskScript(verdict = 'queued') {
  return [
    system(0),
    assistant(1, [{ id: 'c1', name: 'task_begin' }]),
    result(2, 'c1', beginMeta()),
    stepEnd(3),
    user(4),
    assistant(5, [{ id: 'c2', name: 'task_end' }]),
    result(6, 'c2', endMeta('c2', verdict)),
    stepEnd(7),
    assistant(8, []),
  ]
}

/** The same script up to an open task whose span has started. */
function openTaskScript() {
  return [
    system(0),
    assistant(1, [{ id: 'c1', name: 'task_begin' }]),
    result(2, 'c1', beginMeta()),
    stepEnd(3),
    user(4),
  ]
}

/**
 * The subset of a tool execution context the tools read (host/tools.js `assertDirect`).
 *
 * @param {any} session
 * @param {string} callId
 */
function execOf(session, callId) {
  return { callId, rootCallId: callId, agent: { session } }
}

/** Let every already-resolved promise's continuation run; no timer is involved. */
async function flushMicrotasks() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

// ---------------------------------------------------------------------------
// Engine seams

/** The host pairing helpers the adapter insists on (host/ports/compaction-shim.js, assemble()). */
const COMPACTION_API = Object.freeze({
  ManualCompactionError: class ManualCompactionError extends Error {},
  /** @param {any} _session @param {number} _seq */
  toolPairingBalancedBefore: (_session, _seq) => true,
  /** @param {any} _session @param {number} _seq */
  toolPairingBalancedAfter: (_session, _seq) => true,
})

/**
 * A loader for a host that does resolve the compaction packages: a bare-minimum engine that
 * records every transaction, so "no fold ran" is an assertion instead of an assumption.
 *
 * @returns {{ loader: (spec: string) => Promise<any>, folds: string[] }}
 */
function hostWithEngine() {
  /** @type {string[]} */
  const folds = []
  class StubEngine {
    /**
     * @param {any} _ctx
     * @param {any} [config]
     */
    constructor(_ctx, config = {}) {
      if (config.auto !== false) throw new Error('the fold engine must be built with auto: false')
    }
    /** @param {...any} _args */
    async compactRegion(..._args) {
      folds.push('compactRegion')
      return {}
    }
  }
  /** @param {string} spec */
  const loader = async (spec) => {
    if (spec === '@deepseek-ai/dsh-compaction-basic') return { BasicCompactionEngine: StubEngine }
    if (spec === '@deepseek-ai/dsh-compaction') return COMPACTION_API
    return null
  }
  return { loader, folds }
}

// ---------------------------------------------------------------------------
// 1. No compaction engine

test('no engine: the tools still work, one warn line, no fold is attempted', async () => {
  resetCompactionPort()
  const fake = fakeContext()
  // Freeze the process-wide engine cache to "no engine" before apply(). The adapter answers null
  // when neither host package resolves (host/ports/compaction-shim.js, createShimCompactionPort()), and it never asks
  // ctx.get('compaction'): it builds a plugin-owned engine. So "no compaction service in ctx" and
  // "the adapter finds no BasicCompactionEngine" are the same supported mode.
  assert.equal(await createCompactionPort(fake.ctx, { loader: async () => null }), null)
  plugin.apply(fake.ctx, {})
  await flushMicrotasks()

  assert.deepEqual(
    fake.tools.map((tool) => tool.name),
    ['task_begin', 'task_end', 'fold_recall'],
  )
  assert.equal(fake.projections.length, 1, 'the projection is still registered')
  assert.equal(fake.sections.length, 1)
  assert.deepEqual(
    fake.listeners.map((listener) => listener.event),
    ['agent/pre-step', 'agent/turn-stopping'],
  )
  // Exactly one warn line explains that folding is off (host/index.js:102-108).
  assert.equal(fake.logs.length, 1)
  assert.equal(fake.logs[0]?.level, 'warn')
  assert.ok((fake.logs[0]?.message ?? '').includes(ENGINE_UNAVAILABLE))
  assert.ok((fake.logs[0]?.message ?? '').startsWith(PLUGIN_NAME))
  assert.equal(await createCompactionPort(fake.ctx), null, 'the cached answer stays "no engine"')

  // task_begin opens a task. The host appends the assistant message first, so the tool reads a
  // state with the begin batch in flight; its persisted meta is what opens the task.
  const begin = fake.tools.find((tool) => tool.name === 'task_begin')
  const end = fake.tools.find((tool) => tool.name === 'task_end')
  assert.ok(begin && end)
  const start = replay([system(0), assistant(1, [{ id: 'c1', name: 'task_begin' }])])
  fake.setState(start.state)
  const beginValue = await begin.execute({ title: 'Fix login' }, execOf(start.session, 'c1'))
  assert.deepEqual(beginValue, { ok: true, id: 'T1', title: 'Fix login', parent: null, depth: 0 })
  const opened = replay([
    system(0),
    assistant(1, [{ id: 'c1', name: 'task_begin' }]),
    result(2, 'c1', begin.output.presentationMeta({ title: 'Fix login' }, beginValue)),
    stepEnd(3),
    user(4),
  ])
  assert.equal(opened.state.tasks.T1?.status, 'open')
  assert.equal(opened.state.tasks.T1?.title, 'Fix login')

  // task_end records the summary and returns the verdict as data. The span is one 100-token
  // message, far below the 2,000-token floor, so the verdict is below-floor; nothing folds.
  fake.setState(opened.state)
  const summary = '## Done\nWired the redirect.'
  const endValue = await end.execute({ summary }, execOf(opened.session, 'c2'))
  assert.equal(endValue.ok, true)
  assert.equal(endValue.id, 'T1')
  assert.equal(endValue.verdict, 'below-floor')
  assert.equal(endValue.summaryChars, summary.length)
  const persisted = end.output.presentationMeta({ summary }, endValue)
  assert.equal(persisted.op, 'end')
  assert.equal(persisted.summaryChars, summary.length)
  assert.equal(persisted.callId, 'c2')
  assert.match(end.output.render({ summary }, endValue)[0].text, /Task T1 closed/)

  // A due task at a real boundary pass does nothing: a pass returns as soon as the engine
  // resolves null (host/fold-runner.js:96-97), before it reads the state or plans a region.
  const waiting = replay(taskScript('queued'))
  fake.setState(waiting.state)
  const preStep = fake.listeners.find((listener) => listener.event === 'agent/pre-step')?.handler
  assert.ok(preStep)
  const decision = { kind: 'enter', messages: [] }
  const returned = await preStep(
    { agent: { session: waiting.session }, turn: 1, step: 1 },
    async () => decision,
  )
  assert.equal(returned, decision, 'the host decision passes through unchanged')
  assert.equal(waiting.state.tasks.T1?.status, 'queued', 'nothing folded and nothing threw')
  assert.equal(fake.logs.length, 1, 'no fold-attempt log line was added')
})

// ---------------------------------------------------------------------------
// 2. No `llm` service

test('no llm: a delegate task waits and the "summaries are off" line is written once', async () => {
  resetCompactionPort()
  const host = hostWithEngine()
  const fake = fakeContext()
  // A resolved engine is required to reach the delegate path at all; the missing `ctx.get('llm')`
  // is what makes delegation unavailable (host/index.js:120-130).
  await createCompactionPort(fake.ctx, { loader: host.loader })
  plugin.apply(fake.ctx, {})
  await flushMicrotasks()
  assert.equal(fake.logs.length, 0, 'a resolved engine must not produce the engine-unavailable line')

  const waiting = replay(taskScript('delegate'))
  assert.equal(waiting.state.tasks.T1?.status, 'delegate', 'the fixture starts as a delegate task')
  fake.setState(waiting.state)
  const preStep = fake.listeners.find((listener) => listener.event === 'agent/pre-step')?.handler
  assert.ok(preStep)
  const decision = { kind: 'enter', messages: [] }
  const payload = { agent: { session: waiting.session }, turn: 1, step: 1 }
  await preStep(payload, async () => decision)
  await preStep(payload, async () => decision)

  // delegate.supports() is false, so a delegate task simply waits: no generation, no fold, no error.
  assert.equal(waiting.state.tasks.T1?.status, 'delegate')
  assert.equal(waiting.state.folds.length, 0, 'no compaction row was recorded')
  assert.deepEqual(host.folds, [], 'no fold transaction ran')
  assert.deepEqual(
    fake.logs.filter((entry) => entry.level === 'error'),
    [],
    'nothing failed',
  )
  const off = fake.logs.filter((entry) => entry.message.includes('summaries are off'))
  assert.equal(off.length, 1, 'two passes produce exactly one line: the latch holds')
  assert.equal(off[0]?.level, 'warn')
  assert.match(off[0]?.message ?? '', /LLM service is not available/)
  assert.equal(fake.gets.filter((name) => name === 'llm').length, 1, 'supports() probed once per process')
})

// ---------------------------------------------------------------------------
// 3. No registration sink

test('no tool sink: apply stays inactive with one warning and never throws a TypeError', () => {
  resetCompactionPort()
  const fake = fakeContext({ omit: ['tools'] })
  // host/index.js:73-81 wraps every tool registration: the missing registry throws inside the
  // try, the already-registered disposers run and the plugin logs one line and returns. Staying
  // inactive is the right degradation — tools are the only state entry point, so a plugin
  // without them can do nothing — and the caught TypeError is reported inside the message, never
  // thrown at the host loader.
  assert.doesNotThrow(() => plugin.apply(fake.ctx, {}))
  assert.deepEqual(fake.tools, [])
  assert.deepEqual(fake.projections, [], 'no projection without tools')
  assert.deepEqual(fake.sections, [], 'no prompt section without tools')
  assert.deepEqual(fake.listeners, [], 'no hooks without tools')
  assert.equal(fake.logs.length, 1)
  assert.equal(fake.logs[0]?.level, 'warn')
  assert.match(fake.logs[0]?.message ?? '', /dsh-task-folding: not activated/)
})

test('no session-projection sink: fails with a clear message instead of a TypeError', {}, () => {
  const fake = fakeContext({ omit: ['sessionProjections'] })
  // Expected: the plugin either degrades (logs one line naming the missing service) or fails
  // with a message that names it — never a bare TypeError from inside apply().
  assert.doesNotThrow(() => plugin.apply(fake.ctx, {}))
  assert.equal(fake.logs.length, 1)
  assert.match(fake.logs[0]?.message ?? '', /sessionProjections|projection/)
  assert.equal(fake.projections.length, 0)
})

// ---------------------------------------------------------------------------
// 4. Malformed `tool/result.meta`

/**
 * Feed one value as `tool/result.data.meta` in a live task_begin batch and close the batch.
 *
 * @param {unknown} meta
 * @returns {State}
 */
function stateAfterBeginMeta(meta) {
  const start = replay([system(0), assistant(1, [{ id: 'c1', name: 'task_begin' }])])
  return feed(start.state, [result(2, 'c1', meta), stepEnd(3)])
}

/** @param {State} state */
function assertNoTask(state) {
  assert.deepEqual(state.order, [], 'no task was created')
  assert.deepEqual(state.open, [])
  assert.deepEqual(state.tasks, {})
  assert.equal(state.nextId, 1)
  assert.equal(parseState(state), state, 'the state is still one this version writes')
}

test('a tf meta carrying an unknown stateVersion is ignored', {}, () => {
  assertNoTask(stateAfterBeginMeta({ ...beginMeta(), stateVersion: 987 }))
})

test('a tf meta tagged with another version is ignored', () => {
  assertNoTask(stateAfterBeginMeta({ ...beginMeta(), tf: 2 }))
})

test('a non-object meta is ignored', () => {
  for (const meta of ['not a meta', 42, true, [], null]) assertNoTask(stateAfterBeginMeta(meta))
})

test('a tf meta with an unknown op is ignored', () => {
  assertNoTask(stateAfterBeginMeta({ ...beginMeta(), op: 'pause' }))
  assertNoTask(stateAfterBeginMeta({ ...beginMeta(), op: 'end' }))
})

test('a tf meta missing required fields is ignored', () => {
  assertNoTask(stateAfterBeginMeta({ tf: 1, op: 'begin', id: 'T1', title: 'no parent' }))
  assertNoTask(stateAfterBeginMeta({ tf: 1, op: 'begin', id: 'T1', parent: null }))
  assertNoTask(stateAfterBeginMeta({ tf: 1, op: 'begin', title: 'no id', parent: null }))

  // An end meta with a missing field must not close an open task either: isEndMeta requires the
  // whole payload (host/projection.js:462-474), and the batch then closes with no transition.
  const opened = replay(openTaskScript())
  const state = feed(opened.state, [
    assistant(5, [{ id: 'c2', name: 'task_end' }]),
    result(6, 'c2', {
      tf: 1,
      op: 'end',
      id: 'T1',
      merged: [],
      verdict: 'queued',
      outcome: 'done',
      estTokens: 1,
      summaryChars: 1,
    }),
    stepEnd(7),
  ])
  assert.equal(state.tasks.T1?.status, 'open', 'the malformed end meta closed nothing')
  assert.deepEqual(state.open, ['T1'])
  assert.equal(parseState(state), state)
})

test('a tool/result with a negative seq is ignored', {}, () => {
  const start = replay([system(0), assistant(1, [{ id: 'c1', name: 'task_begin' }])])
  // A negative seq is not a host seq; the plan expects the meta to be ignored. Today the seq is
  // stored as the begin cut, so the task opens with beginCut -1 (ABSORBED).
  assertNoTask(feed(start.state, [result(-1, 'c1', beginMeta()), stepEnd(2)]))
})

test('a begin meta whose title is not a string is ignored', () => {
  for (const title of [42, null, {}, ['a title']])
    assertNoTask(stateAfterBeginMeta({ ...beginMeta(), title }))
})

test('the registered projection keeps malformed meta out of state and still reports version 1', async () => {
  resetCompactionPort()
  const fake = fakeContext()
  await createCompactionPort(fake.ctx, { loader: async () => null })
  plugin.apply(fake.ctx, {})
  await flushMicrotasks()
  const definition = fake.projections[0]
  assert.ok(definition)
  assert.equal(definition.key, PROJECTION_KEY)
  assert.equal(definition.stateVersion, STATE_VERSION)
  assert.equal(STATE_VERSION, 1, 'the version the plugin reports has not moved')
  assert.equal(definition.apply, apply, 'the registered reducer is the pure projection reducer')

  // One replay through the plugin's own registration, over every value this suite expects the
  // reducer to ignore.
  const malformed = [
    'not a meta',
    42,
    true,
    [],
    null,
    { ...beginMeta(), tf: 2 },
    { ...beginMeta(), op: 'pause' },
    { tf: 1, op: 'begin', id: 'T1', title: 'no parent' },
    { ...beginMeta(), title: 42 },
  ]
  for (const meta of malformed) {
    let state = definition.init({}, 0)
    state = definition.apply(state, system(0))
    state = definition.apply(state, assistant(1, [{ id: 'c1', name: 'task_begin' }]))
    state = definition.apply(state, result(2, 'c1', meta))
    state = definition.apply(state, stepEnd(3))
    assertNoTask(state)
  }
})

// ---------------------------------------------------------------------------
// 5. A log written by another realm

test('a foreign-realm log keeps the projection on its own state version and does not throw', async () => {
  resetCompactionPort()
  const fake = fakeContext()
  await createCompactionPort(fake.ctx, { loader: async () => null })
  plugin.apply(fake.ctx, {})
  await flushMicrotasks()
  const definition = fake.projections[0]
  assert.ok(definition)

  // The projection reports its own version and never guesses one from the log: host/index.js:83-92
  // passes `stateVersion: STATE_VERSION` to the registration, and the reducer's meta validators
  // (host/projection.js:449-456, 462-474) check only tf/op/fields — no meta `stateVersion` is read.
  assert.equal(definition.stateVersion, STATE_VERSION)
  assert.equal(definition.stateVersion, 1)

  // A replay of a session whose meta carries an unknown stateVersion: the payload is not ours to
  // interpret, so it is ignored — the task is never created, the reported version does not move and
  // nothing throws. (A journal can be replayed by a newer or an older build of this plugin.)
  let state = definition.init({}, 0)
  for (const next of [
    system(0),
    assistant(1, [{ id: 'c1', name: 'task_begin' }]),
    result(2, 'c1', { ...beginMeta(), stateVersion: 987 }),
  ]) {
    state = definition.apply(state, next)
  }
  assert.equal(definition.stateVersion, STATE_VERSION, 'replaying a foreign log does not move the version')
  assert.equal(definition.stateVersion === 987, false, 'the projection did not adopt the foreign version')
  assert.equal(parseState(state), state)
  assert.deepEqual(state.order, [], 'meta written under another schema is ignored, not applied')
})

// ---------------------------------------------------------------------------
// 6. A corrupt `compaction/summary`

test('a corrupt compaction/summary is not applied and later events still replay', () => {
  const script = replay(taskScript('queued'))
  assert.equal(script.state.tasks.T1?.status, 'queued', 'the task waits before the corrupt summary')

  // The summary has no `shadowedSeqs` (so the shadowed set is empty) and its replacement points
  // at seqs the surface does not have. The reducer must not fold a task from it and must not throw.
  let state = apply(
    script.state,
    event(9, 'compaction/summary', {
      compactionId: 'c9',
      summary: [{ type: 'text', text: 'summary' }],
    }),
  )
  assert.equal(state.folds.length, 1, 'the summary row is indexed, with no seqs to translate')
  assert.equal(state.folds[0]?.shadowedCount, 0)
  assert.equal(state.folds[0]?.taskId, null)
  assert.equal(state.pendingSummary, 0)

  state = apply(
    state,
    event(
      10,
      'user/message',
      {
        role: 'user',
        content: [{ type: 'text', text: 'checkpoint' }],
        source: { kind: 'compact-checkpoint' },
      },
      { surfaceOp: { op: 'replace', startSeq: 999, endSeq: 1000 }, sourceEventSeqs: [999, 1000] },
    ),
  )
  // coversSpan is false and no cut is in the shadowed set, so the fold is not applied
  // (host/projection.js:215-223, 387-408).
  assert.equal(state.tasks.T1?.status, 'queued', 'the corrupt fold did not fold the task')
  assert.equal(state.folds[0]?.taskId, null, 'the corrupt fold is attributed to no task')
  assert.deepEqual(
    [state.tasks.T1?.beginCut, state.tasks.T1?.spanStart, state.tasks.T1?.endCut],
    [2, 4, 6],
    'no cut moved',
  )
  assert.equal(state.pendingSummary, null, 'the pending row was consumed without folding anything')

  // Later events still replay and the state stays one this version writes.
  state = apply(state, assistant(11, []))
  state = apply(state, stepEnd(12))
  state = apply(state, user(13))
  assert.equal(state.tasks.T1?.status, 'queued')
  assert.equal(state.assistantCount, 4, 'the later assistant message was counted as before')
  assert.equal(parseState(state), state)
})
