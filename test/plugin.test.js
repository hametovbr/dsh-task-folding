// The plugin object (host/index.js): what apply() registers, and what it does when another
// plugin already owns a task tool name (03 §11, the taskfold-coexistence row).

import assert from 'node:assert/strict'
import { test } from 'node:test'

import plugin, { PLUGIN_NAME, PROMPT_ORDER } from '../host/index.js'
import { createPreStep } from '../host/plugin/pre-step.js'
import { PROJECTION_KEY, STATE_VERSION, initialState } from '../host/domain/projection.js'
import { defaults, readSettings } from '../host/domain/settings.js'
import { PROMPT_SECTION } from '../host/domain/texts.js'

/**
 * A Context stand-in that records registrations the way the host services do.
 *
 * @param {{ taken?: string[] }} [options]
 */
function fakeContext(options = {}) {
  const taken = new Set(options.taken ?? [])
  /** @type {any[]} */
  const tools = []
  /** @type {any[]} */
  const sections = []
  /** @type {any[]} */
  const projections = []
  /** @type {{ level: string, message: string }[]} */
  const logs = []
  let state = initialState()

  /** @type {{ event: string, handler: any }[]} */
  const listeners = []
  const ctx = {
    tokenMeter: { estimateMessage: () => 100 },
    /** @param {string} event @param {any} handler */
    on(event, handler) {
      listeners.push({ event, handler })
      return () => {}
    },
    /** @param {...any} _args */
    waterfall(..._args) {
      return false
    },
    /** @param {string} _name */
    get(_name) {
      return undefined
    },
    tools: {
      /** @param {any} definition */
      register(definition) {
        if (taken.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`)
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
    logger: {
      /** @param {string} message */
      warn(message) {
        logs.push({ level: 'warn', message })
      },
      /** @param {string} message */
      error(message) {
        logs.push({ level: 'error', message })
      },
    },
  }
  // `state` is swapped by tests that need a session with work in it.
  return {
    ctx,
    tools,
    sections,
    projections,
    logs,
    listeners,
    get state() {
      return state
    },
    /** @param {any} next @returns {void} */
    setState(next) {
      state = next
    },
  }
}

test('the plugin declares its name, services and prompt order', () => {
  assert.equal(plugin.name, PLUGIN_NAME)
  assert.equal(PLUGIN_NAME, 'dsh-task-folding')
  assert.equal(PROMPT_ORDER, 650)
  assert.deepEqual(plugin.inject, ['tools', 'sessionProjections', 'systemPrompt', 'tokenMeter'])
})

test('apply registers the three tools, the projection and the prompt section', async () => {
  const fake = fakeContext()
  plugin.apply(fake.ctx, {})

  assert.deepEqual(
    fake.tools.map((tool) => tool.name),
    ['task_begin', 'task_end', 'fold_recall'],
  )
  for (const tool of fake.tools) {
    assert.equal(typeof tool.description, 'string')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
  }

  assert.equal(fake.projections.length, 1)
  const projection = fake.projections[0]
  assert.equal(projection.key, PROJECTION_KEY)
  assert.equal(projection.stateVersion, STATE_VERSION)
  assert.equal(typeof projection.wire.view, 'function')
  assert.doesNotThrow(() => projection.stateSchema.parse(fake.state))
  assert.doesNotThrow(() => projection.wire.viewSchema.parse(projection.wire.view(fake.state)))

  assert.deepEqual(fake.sections, [{ name: 'task-folding', order: PROMPT_ORDER, text: PROMPT_SECTION }])
  assert.deepEqual(
    fake.listeners.map((listener) => listener.event),
    ['agent/pre-step', 'agent/turn-stopping'],
  )
})

test('the registered tools read state through the projection handle', async () => {
  const fake = fakeContext()
  plugin.apply(fake.ctx, {})
  const begin = fake.tools.find((tool) => tool.name === 'task_begin')
  const value = await begin.execute(
    { title: 'from the fake host' },
    { callId: 'call_1', rootCallId: 'call_1', agent: { session: { id: 's' } } },
  )
  assert.deepEqual(value, {
    ok: true,
    id: 'T1',
    title: 'from the fake host',
    parent: null,
    depth: 0,
  })
})

test('a tool-name collision leaves the plugin inactive and says why', () => {
  const fake = fakeContext({ taken: ['task_begin'] })
  plugin.apply(fake.ctx, {})
  assert.deepEqual(fake.tools, [])
  assert.deepEqual(fake.projections, [])
  assert.deepEqual(fake.sections, [])
  assert.equal(fake.logs.length, 1)
  assert.equal(fake.logs[0]?.level, 'warn')
  assert.match(/** @type {string} */ (fake.logs[0]?.message), /already registered/)
  assert.match(/** @type {string} */ (fake.logs[0]?.message), /dsh-taskfold/)
})

test('a late registration failure unregisters the tools it already took', () => {
  const fake = fakeContext({ taken: ['fold_recall'] })
  plugin.apply(fake.ctx, {})
  assert.deepEqual(fake.tools, [], 'no half-registered tool set')
  assert.deepEqual(fake.projections, [])
  assert.deepEqual(fake.sections, [])
  assert.equal(fake.logs.length, 1)
})

test('Config is present when schemastery resolves, and reads as defaults either way', () => {
  const settings = readSettings(plugin.Config ? plugin.Config({}) : undefined)
  assert.equal(settings.minSpanTokens, 2000)
  assert.equal(settings.delegateEnabled, true)
  assert.equal(settings.maxSummaryRatio, 0.5)
  assert.equal(settings.staleTaskSteps, 25)
  assert.equal(settings.showTaskBar, false)
  if (plugin.Config) assert.equal(typeof plugin.Config, 'function', 'a schemastery schema is callable')
})

test('the pre-step handler appends one stale-task hint to the host decision', async () => {
  const fake = fakeContext()
  plugin.apply(fake.ctx, {})
  const preStep = fake.listeners.find((listener) => listener.event === 'agent/pre-step')?.handler
  assert.ok(preStep, 'the plugin registered a pre-step handler')

  const task = {
    id: 'T1',
    title: 'long task',
    parent: null,
    depth: 0,
    status: 'open',
    beginCut: 3,
    spanStart: 4,
    endCut: null,
    endMsgSeq: null,
    endCallId: null,
    verdict: null,
    outcome: null,
    estTokens: 0,
    summaryChars: 0,
    openedAt: 0,
    reported: false,
    failures: 0,
    foldIndex: null,
  }
  fake.setState({ ...fake.state, open: ['T1'], tasks: { T1: task }, order: ['T1'], assistantCount: 30 })
  const decision = { kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }] }
  const returned = await preStep({ agent: { session: { id: 's' } }, turn: 1, step: 1 }, async () => decision)
  assert.equal(returned.kind, 'enter')
  assert.equal(returned.messages.length, 2, 'the host message plus one hint')
  const hint = returned.messages[1]
  assert.equal(hint.role, 'user')
  assert.equal(hint.id, 'task-folding-hint:T1:25', 'the delimiter between the latch key and the id')
  assert.deepEqual(hint.source, { kind: 'task-folding:hint', key: 'T1:25' })
  assert.match(hint.content[0].text, /has been open for 25\+ steps/)
})

test('the pre-step handler publishes a hint only once per key', async () => {
  const fake = fakeContext()
  plugin.apply(fake.ctx, {})
  const preStep = fake.listeners.find((listener) => listener.event === 'agent/pre-step')?.handler
  const task = {
    id: 'T1',
    title: 'long task',
    parent: null,
    depth: 0,
    status: 'open',
    beginCut: 3,
    spanStart: 4,
    endCut: null,
    endMsgSeq: null,
    endCallId: null,
    verdict: null,
    outcome: null,
    estTokens: 0,
    summaryChars: 0,
    openedAt: 0,
    reported: false,
    failures: 0,
    foldIndex: null,
  }
  const state = { ...fake.state, open: ['T1'], tasks: { T1: task }, order: ['T1'], assistantCount: 30 }
  fake.setState({ ...state, hintKey: 'T1:25' })
  const decision = { kind: 'enter', messages: [] }
  const returned = await preStep({ agent: { session: { id: 's' } }, turn: 1, step: 1 }, async () => decision)
  assert.equal(returned.messages.length, 0, 'the latch suppresses the second publication')
})

/**
 * A task record the way the projection writes one (`onBegin` + `closeBatch`).
 *
 * @param {Record<string, any>} [patch]
 * @returns {any}
 */
function taskRecord(patch = {}) {
  return {
    id: 'T1',
    title: 'task',
    parent: null,
    depth: 0,
    status: 'open',
    beginCut: 3,
    spanStart: 4,
    endCut: null,
    endMsgSeq: null,
    endCallId: null,
    verdict: null,
    outcome: null,
    estTokens: 0,
    summaryChars: 0,
    openedAt: 0,
    reported: false,
    failures: 0,
    foldIndex: null,
    ...patch,
  }
}

test('a non-enter decision or a payload without a session passes through untouched', async () => {
  const fake = fakeContext()
  plugin.apply(fake.ctx, {})
  const preStep = fake.listeners.find((listener) => listener.event === 'agent/pre-step')?.handler
  fake.setState({
    ...fake.state,
    open: ['T1'],
    tasks: { T1: taskRecord() },
    order: ['T1'],
    assistantCount: 30,
  })
  const skip = { kind: 'skip', messages: [] }
  assert.equal(await preStep({ agent: { session: { id: 's' } } }, async () => skip), skip)
  const enter = { kind: 'enter', messages: [] }
  assert.equal(await preStep({}, async () => enter), enter, 'no session, no state to hint from')
})

test('the pre-step appends the empty-span hint after a begin-packed close', async () => {
  const fake = fakeContext()
  plugin.apply(fake.ctx, {})
  const preStep = fake.listeners.find((listener) => listener.event === 'agent/pre-step')?.handler
  const task = taskRecord({
    status: 'below-floor',
    verdict: 'below-floor',
    beginCut: 5,
    spanStart: 7,
    endMsgSeq: 7,
    endCut: 9,
    endCallId: 'c2',
    estTokens: 1000,
    summaryChars: 40,
    reported: true,
  })
  fake.setState({ ...fake.state, open: [], tasks: { T1: task }, order: ['T1'] })
  const decision = { kind: 'enter', messages: [] }
  const returned = await preStep({ agent: { session: { id: 's' } } }, async () => decision)
  assert.equal(returned.messages.length, 1)
  assert.equal(returned.messages[0].id, 'task-folding-hint:T1:empty-span')
  assert.match(returned.messages[0].content[0].text, /closed below the fold floor/)
})

test('createPreStep owns the fold → hint → decision sequence, including the handle await', async () => {
  const decision = { kind: 'enter', messages: [] }
  const payload = { agent: { session: { id: 's' } } }
  /** @type {any[]} */
  const folded = []
  let asked = 0
  const neverRegistered = createPreStep({
    runner: {
      /** @param {any} payload @param {() => Promise<any>} next */
      async preStep(payload, next) {
        folded.push(payload)
        return next()
      },
    },
    projection: {},
    settings: () => defaults(),
    hints: () => {
      asked += 1
      return null
    },
  })
  assert.equal(await neverRegistered(payload, async () => decision), decision)
  assert.deepEqual(folded, [payload], 'the runner folds before the hint is considered')
  assert.equal(asked, 0, 'no projection, no state, no hint rule')

  const handled = createPreStep({
    runner: {
      /** @param {any} _payload @param {() => Promise<any>} next */
      async preStep(_payload, next) {
        return next()
      },
    },
    projection: { handle: Promise.resolve({ stateOf: async () => initialState() }) },
    settings: () => defaults(),
    hints: () => ({
      key: 'T1:empty-span',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'hint' }],
        source: { kind: 'task-folding:hint', key: 'T1:empty-span' },
      },
    }),
  })
  const withHint = await handled(payload, async () => decision)
  assert.equal(withHint.messages.length, 1)
  assert.equal(withHint.messages[0].id, 'task-folding-hint:T1:empty-span')
  assert.equal(decision.messages.length, 0, 'the host decision object itself is not mutated')
})
