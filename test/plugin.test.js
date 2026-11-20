// The plugin object (host/index.js): what apply() registers, and what it does when another
// plugin already owns a task tool name (03 §11, the taskfold-coexistence row).

import assert from 'node:assert/strict'
import { test } from 'node:test'

import plugin, { PLUGIN_NAME, PROMPT_ORDER } from '../host/index.js'
import { PROJECTION_KEY, STATE_VERSION, initialState } from '../host/projection.js'
import { readSettings } from '../host/settings.js'
import { PROMPT_SECTION } from '../host/texts.js'

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
  const state = initialState()

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
  return { ctx, tools, sections, projections, logs, state, listeners }
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
