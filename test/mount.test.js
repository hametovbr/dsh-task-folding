// The plugin object (host/index.js) driven the way the host drives it: apply() registers, then the
// two fold boundaries and the session projection are exercised through their registered entry
// points. The registration shape of the fake context is copied from test/plugin.test.js's
// `fakeContext`; this file adds a configurable `ctx.get('llm')`, a swappable projection state and a
// fake fold engine.
//
// Two host packages decide what the mount path can reach, and neither is installed in this
// repository:
//   - `@deepseek-ai/dsh-compaction-basic` / `@deepseek-ai/dsh-compaction`:
//     host/ports/compaction.js takes a loader as a documented test seam
//     (`createCompactionPort(ctx, { loader })`) and caches the engine per process, so a test
//     primes the cache with a fake and apply() then reuses it.
//   - `@deepseek-ai/dsh-llm`: host/index.js passes the *module-level* `loadHostModule` to
//     generateDelegateSummary, so there is no argument seam. The only way to stand a host package
//     in without editing host/ is to resolve it the way a real installation would: the loader hook
//     below maps the bare specifier to a fake module. It is registered before any import of that
//     specifier and lives for this test file's process only (the test runner isolates files).
// Nothing here fakes the plugin's own internals: the request, the validation and the commit all
// run for real.
//
// What this file cannot reach without editing host/:
//   - host/index.js:121, the engine promise's rejection handler: createCompactionPort() resolves null
//     on every failure and never rejects, so apply() cannot observe a rejection there.
//   - the Config branch of the plugin object (host/index.js:54): it needs @deepseek-ai/schemastery
//     resolved by the module-level top-level await, before a loader hook could be registered, and
//     no @deepseek-ai package is installed in this repository.
//   - the `regionKey` that start() echoes back: fold-runner.js deliberately stores its own key
//     (see its startGeneration comment), so the echoed value is unobservable from the mount path.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire, register } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createCompactionPort, resetCompactionPort } from '../host/ports/compaction.js'
import plugin, { DELEGATE_MAX_TOKENS, PLUGIN_NAME, PROMPT_ORDER } from '../host/index.js'
import { PROJECTION_KEY, STATE_VERSION, initialState } from '../host/domain/projection.js'
import { loadHostModule, loadSchemastery, runtimeModulesDir } from '../host/ports/host-services.js'
import { indexLinesFor, routeOfRequest } from '../host/ports/llm.js'
import * as texts from '../host/domain/texts.js'
import { PROMPT_SECTION } from '../host/domain/texts.js'
import { Sim } from './fixtures/sim.js'
import { at, fakeMeter } from './fixtures/tools.js'

// ---------------------------------------------------------------------------
// The fake host LLM package (the loader seam)

const HOST_LLM_SPEC = '@deepseek-ai/dsh-llm'
/** A synthetic URL: the fake package is not a file and cannot leak into another process. */
const FAKE_LLM_URL = 'dsh-task-folding-test:fake-llm'

/**
 * The fake `BlockAssembler` and the control block a test writes before a generation. The
 * summarizer only uses `push`, `finish`, `blocks` and `usage` (host/summarizer.js).
 */
const FAKE_LLM_SOURCE = `
export const control = { text: '', usage: undefined }
export class BlockAssembler {
  constructor() {
    this.finish = null
    this.usage = control.usage
    this.chunks = []
  }
  push(chunk) {
    this.chunks.push(chunk)
  }
  blocks() {
    return control.text === '' ? [] : [{ type: 'text', text: control.text }]
  }
}
`

const LOADER_HOOK = `
const FAKE = ${JSON.stringify(FAKE_LLM_URL)}
const SOURCE = ${JSON.stringify(FAKE_LLM_SOURCE)}
export async function resolve(specifier, context, nextResolve) {
  if (specifier === ${JSON.stringify(HOST_LLM_SPEC)}) return { url: FAKE, shortCircuit: true }
  return nextResolve(specifier, context)
}
export async function load(url, context, nextLoad) {
  if (url !== FAKE) return nextLoad(url, context)
  return { format: 'module', shortCircuit: true, source: SOURCE }
}
`

register(`data:text/javascript,${encodeURIComponent(LOADER_HOOK)}`, import.meta.url)
/** @type {{ control: { text: string, usage: any } }} */
const fakeHostLlm = await import(HOST_LLM_SPEC)

/** A valid delegate answer: opens with a `## ` section (docs/03 §5.4). */
const DEFAULT_SUMMARY = '## Done\nWired the delegate path and checked its envelope.'

/**
 * Choose what the fake host LLM assembly will answer and report.
 *
 * @param {{ text?: string, usage?: any }} [options]
 */
function configureFakeLlm(options = {}) {
  fakeHostLlm.control.text = options.text ?? DEFAULT_SUMMARY
  fakeHostLlm.control.usage = options.usage
}

// ---------------------------------------------------------------------------
// The fake context and the mounted plugin

/**
 * A Context stand-in that records registrations the way the host services do (the shape is copied
 * from `fakeContext` in test/plugin.test.js).
 *
 * @param {{
 *   meter?: any,
 *   llm?: any,
 *   llmThenGone?: boolean,
 *   taken?: string[],
 *   toolsFail?: unknown,
 *   projectionsReject?: unknown,
 * }} [options]
 */
function fakeContext(options = {}) {
  const registered = new Set(options.taken ?? [])
  /** @type {any[]} */
  const tools = []
  /** @type {any[]} */
  const sections = []
  /** @type {any[]} */
  const projections = []
  /** @type {{ level: string, message: string }[]} */
  const logs = []
  /** @type {{ event: string, handler: any }[]} */
  const listeners = []
  let state = initialState()
  let llmLookups = 0

  /** @type {any} */
  const ctx = {
    tokenMeter: options.meter ?? { estimateMessage: () => 10 },
    /** @param {string} event @param {any} handler */
    on(event, handler) {
      listeners.push({ event, handler })
      return () => {}
    },
    /** @param {...any} _args */
    waterfall(..._args) {
      return false
    },
    /** @param {string} name */
    get(name) {
      if (name !== 'llm') return undefined
      llmLookups += 1
      // A host service that is gone by the time start() looks it up again: the one way to reach
      // the defensive guard in start() through the runner, which probes supports() first.
      if (options.llmThenGone === true && llmLookups > 1) return undefined
      return options.llm
    },
    tools: {
      /** @param {any} definition */
      register(definition) {
        if (options.toolsFail !== undefined) throw options.toolsFail
        if (registered.has(definition.name))
          throw new Error(`tool "${definition.name}" is already registered`)
        registered.add(definition.name)
        tools.push(definition)
        return () => {
          registered.delete(definition.name)
          tools.splice(tools.indexOf(definition), 1)
        }
      },
    },
    sessionProjections: {
      /** @param {any} definition */
      register(definition) {
        projections.push(definition)
        if (options.projectionsReject !== undefined) return Promise.reject(options.projectionsReject)
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

  return {
    ctx,
    tools,
    sections,
    projections,
    logs,
    listeners,
    /** @param {any} next */
    setState(next) {
      state = next
    },
    get state() {
      return state
    },
    get llmLookups() {
      return llmLookups
    },
  }
}

/**
 * A fake compaction-port dependency set. `fold` records the prepared blocks, route and usage the
 * runner hands over; `reject` records the durable failed-attempt write and fails the way the host's
 * transaction does.
 *
 * @param {{ commits: any[], failures: any[] }} record
 * @returns {(spec: string) => Promise<any>}
 */
function compactionLoader(record) {
  class FakeCompactionEngine {
    /** @param {any} _shim @param {any} _options */
    constructor(_shim, _options) {}

    /** @param {number} start @param {number} end */
    async compactRegion(start, end) {
      const engine = /** @type {any} */ (this)
      if (engine.reject === true) {
        record.failures.push({ start, end })
        throw new Error(texts.DELEGATE_FAILED)
      }
      record.commits.push({ start, end, prepared: engine.prepared })
      return { start, end }
    }
  }

  return async (/** @type {string} */ spec) => {
    if (spec === '@deepseek-ai/dsh-compaction-basic') {
      return { BasicCompactionEngine: FakeCompactionEngine }
    }
    if (spec === '@deepseek-ai/dsh-compaction') {
      return {
        ManualCompactionError: class extends Error {},
        toolPairingBalancedBefore: () => true,
        toolPairingBalancedAfter: () => true,
      }
    }
    return null
  }
}

/**
 * Apply the plugin to a fresh fake context with a primed fake fold engine.
 *
 * @param {{
 *   config?: any,
 *   meter?: any,
 *   llm?: any,
 *   llmThenGone?: boolean,
 *   state?: any,
 *   taken?: string[],
 *   toolsFail?: unknown,
 *   projectionsReject?: unknown,
 * }} [options]
 */
function mount(options = {}) {
  /** @type {{ commits: any[], failures: any[] }} */
  const record = { commits: [], failures: [] }
  const fake = fakeContext(options)
  if (options.state !== undefined) fake.setState(options.state)
  resetCompactionPort()
  const engine = createCompactionPort(fake.ctx, { loader: compactionLoader(record) })
  plugin.apply(fake.ctx, options.config ?? {})
  return { fake, record, engine }
}

/**
 * The host session subset the delegate path reads (docs/02 §2): one event per surface seq, a tool
 * history and, when a test needs it, the latest `request/header`.
 *
 * @param {{ count?: number, id?: string, header?: any, toolHistory?: any }} [options]
 */
function fakeSession(options = {}) {
  const count = options.count ?? 8
  /** @type {Map<number, any>} */
  const events = new Map()
  for (let seq = 0; seq < count; seq += 1) {
    const role = seq === 0 ? 'system' : seq % 2 === 0 ? 'assistant' : 'user'
    events.set(seq, {
      type: `${role}/message`,
      seq,
      data: { message: { role, content: [{ type: 'text', text: `message ${seq}` }] } },
    })
  }
  /** @type {any} */
  const session = {
    id: options.id ?? 'delegate-session',
    surface: { nodes: Array.from({ length: count }, (_, index) => index) },
    /** @param {number} seq */
    eventAt: (seq) => events.get(seq),
    /** @param {any} event */
    deriveEventMessage: (event) => event.data.message,
    toolHistory: () => options.toolHistory ?? [],
  }
  if (options.header !== undefined) session.requestHeader = () => options.header
  return session
}

/**
 * One closed delegate task whose region is surface positions 2..6: beginCut 1, spanStart 2,
 * endCut 6 (planner.js §5.2).
 *
 * @returns {any}
 */
function delegateTask() {
  return {
    id: 'T1',
    title: 'delegated work',
    parent: null,
    depth: 0,
    status: 'delegate',
    beginCut: 1,
    spanStart: 2,
    endCut: 6,
    endMsgSeq: null,
    endCallId: null,
    verdict: 'delegate',
    outcome: 'done',
    estTokens: 0,
    summaryChars: 0,
    openedAt: 0,
    reported: true,
    failures: 0,
    foldIndex: null,
  }
}

/**
 * The projection state the runner reads: one due delegate task, nothing else.
 *
 * @param {any} [task]
 */
function stateWith(task = delegateTask()) {
  return { ...initialState(), open: [], tasks: { T1: task }, order: ['T1'], assistantCount: 1 }
}

/**
 * A fake `ctx.llm`. `stream` records the request and resolves the test's waiter at the moment the
 * call starts, so the un-awaited background generation is observed without a timer.
 */
function fakeLlm() {
  /** @type {any[]} */
  const calls = []
  /** @type {((options: any) => void)[]} */
  const waiters = []
  return {
    calls,
    /** @returns {Promise<any>} */
    nextStreamCall() {
      return new Promise((resolve) => {
        waiters.push(resolve)
      })
    },
    /** @param {any} options */
    stream(options) {
      calls.push(options)
      for (const resolve of waiters.splice(0)) resolve(options)
      return []
    },
  }
}

/** Let the plugin's deferred microtasks run; no timer is involved. */
async function flushMicrotasks() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

/**
 * Fire the registered `agent/turn-stopping` handler, which runs one fold boundary pass.
 *
 * @param {{ listeners: any[] }} fake
 * @param {any} agent
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
async function turnStopping(fake, agent, signal) {
  const listener = fake.listeners.find((entry) => entry.event === 'agent/turn-stopping')
  assert.ok(listener, 'the plugin registered a turn-stopping handler')
  await listener.handler({ agent, signal })
}

/**
 * A mounted plugin whose projection holds one due delegate task, plus the fake LLM seam.
 *
 * @param {{
 *   config?: any,
 *   meter?: any,
 *   llm?: any,
 *   llmThenGone?: boolean,
 *   text?: string,
 *   usage?: any,
 *   header?: any,
 *   agentOptions?: any,
 *   session?: any,
 *   state?: any,
 * }} [options]
 */
function delegateMount(options = {}) {
  configureFakeLlm({ text: options.text, usage: options.usage })
  const llm = options.llm === undefined ? fakeLlm() : options.llm
  const session = options.session ?? fakeSession({ header: options.header })
  // A mount that is not about route selection still needs one: the last-resort agent options.
  const agentOptions =
    options.agentOptions === undefined
      ? { provider: 'deepseek', model: 'deepseek-chat' }
      : options.agentOptions
  const agent = { session, options: agentOptions ?? {} }
  const mounted = mount({
    config: options.config,
    meter: options.meter,
    llm,
    llmThenGone: options.llmThenGone,
    state: options.state ?? stateWith(),
  })
  return { ...mounted, llm, session, agent }
}

/**
 * Run one boundary pass and wait for the generation it starts to finish.
 *
 * @param {ReturnType<typeof delegateMount>} run
 * @returns {Promise<any>} the request the fake LLM received
 */
async function generated(run) {
  const streamed = run.llm.nextStreamCall()
  await turnStopping(run.fake, run.agent)
  const request = await streamed
  await flushMicrotasks()
  return request
}

// ---------------------------------------------------------------------------
// The mount path: registrations, a second apply and the wire view

test('apply registers exactly one projection, one prompt section, three tools and two hooks', () => {
  const { fake } = mount()

  assert.deepEqual(
    fake.tools.map((tool) => tool.name),
    ['task_begin', 'task_end', 'fold_recall'],
  )
  assert.equal(fake.projections.length, 1)
  const projection = fake.projections[0]
  assert.equal(projection.key, PROJECTION_KEY)
  assert.equal(projection.stateVersion, STATE_VERSION)
  assert.equal(typeof projection.wire.view, 'function')
  assert.equal(typeof projection.wire.viewSchema.parse, 'function')
  assert.doesNotThrow(() => projection.stateSchema.parse(initialState()))

  assert.deepEqual(fake.sections, [{ name: 'task-folding', order: PROMPT_ORDER, text: PROMPT_SECTION }])
  assert.deepEqual(
    fake.listeners.map((listener) => listener.event),
    ['agent/pre-step', 'agent/turn-stopping'],
  )
  assert.deepEqual(fake.logs, [], 'a healthy mount logs nothing')
})

test('a second apply on the same context is refused and leaves the first registration intact', () => {
  const { fake } = mount()
  plugin.apply(fake.ctx, {})

  // The host's tool registry refuses a duplicate name, so the second apply takes no tool, and the
  // projection/prompt/hooks are only reached after the tools register successfully. The first
  // apply's registrations are untouched: nothing is half-registered and nothing is disposed.
  assert.deepEqual(
    fake.tools.map((tool) => tool.name),
    ['task_begin', 'task_end', 'fold_recall'],
  )
  assert.equal(fake.projections.length, 1)
  assert.equal(fake.sections.length, 1)
  assert.equal(fake.listeners.length, 2)
  assert.equal(fake.logs.length, 1)
  assert.equal(fake.logs[0]?.level, 'warn')
  assert.match(String(fake.logs[0]?.message), /already registered/)
  assert.match(String(fake.logs[0]?.message), new RegExp(PLUGIN_NAME))
  assert.match(String(fake.logs[0]?.message), /restart/)
})

test('a registration failure that is not an Error is reported as text', () => {
  /** @type {{ commits: any[], failures: any[] }} */
  const record = { commits: [], failures: [] }
  const fake = fakeContext({ toolsFail: 'the tool sink is gone' })
  resetCompactionPort()
  createCompactionPort(fake.ctx, { loader: compactionLoader(record) })
  plugin.apply(fake.ctx, {})

  assert.deepEqual(fake.tools, [])
  assert.deepEqual(fake.projections, [])
  assert.deepEqual(fake.sections, [])
  assert.deepEqual(fake.listeners, [])
  assert.equal(fake.logs.length, 1)
  assert.equal(fake.logs[0]?.level, 'warn')
  assert.match(String(fake.logs[0]?.message), /the tool sink is gone/)
  assert.match(String(fake.logs[0]?.message), /not activated/)
})

test('a rejected projection registration is logged and does not escape apply', async () => {
  const { fake } = mount({ projectionsReject: new Error('no projection store') })
  await flushMicrotasks()

  const error = fake.logs.find((entry) => entry.level === 'error')
  assert.ok(error, 'the rejection is reported')
  assert.match(String(error.message), /projection registration failed: no projection store/)
})

test('the wire view is empty before the first task and lists the task once it is created', () => {
  const { fake } = mount()
  const projection = fake.projections[0]

  // docs/03 §4.4: the wire view is the three empty lists, never null and never undefined.
  const empty = projection.wire.view(projection.init({}, 0))
  assert.deepEqual(empty, { open: [], folding: [], recent: [] })
  assert.doesNotThrow(() => projection.wire.viewSchema.parse(empty))

  const sim = new Sim()
  sim.begin('Ship the mount test')
  let state = projection.init({}, 0)
  for (const event of sim.events) state = projection.apply(state, event)
  const view = projection.wire.view(state)
  assert.deepEqual(view.open, [{ id: 'T1', title: 'Ship the mount test', depth: 0 }])
  assert.deepEqual(view.folding, [])
  assert.deepEqual(view.recent, [])
  assert.doesNotThrow(() => projection.wire.viewSchema.parse(view))
})

test('the pre-step handler hands back a decision it does not extend unchanged', async () => {
  const { fake } = mount({ llm: fakeLlm() })
  const preStep = fake.listeners.find((listener) => listener.event === 'agent/pre-step')?.handler
  assert.ok(preStep, 'the plugin registered a pre-step handler')
  const session = fakeSession()

  // Only an `enter` decision can carry a hint (docs/03 §8); anything else passes through.
  const exit = { kind: 'exit' }
  const exitInput = await preStep({ agent: { session }, turn: 1, step: 1 }, async () => exit)
  assert.equal(exitInput, exit)

  // A payload without a session (or without an agent at all) is handed back as it came, and the
  // hint path is never taken.
  const enter = { kind: 'enter', messages: [] }
  assert.equal(await preStep({ agent: {} }, async () => enter), enter)
  assert.equal(await preStep(undefined, async () => enter), enter)
  assert.deepEqual(fake.logs, [])
})

// ---------------------------------------------------------------------------
// Delegate route selection: settings override > session route > agent options (docs/03 §5.4)

test('the settings override wins over the session route and the agent options', async () => {
  const run = delegateMount({
    config: { summarizationProvider: 'settings-provider', summarizationModel: 'settings-model' },
    header: { config: { provider: 'header-provider', model: 'header-model' }, tools: [] },
    agentOptions: { provider: 'agent-provider', model: 'agent-model' },
  })
  const request = await generated(run)
  assert.equal(request.provider, 'settings-provider')
  assert.equal(request.model, 'settings-model')
})

test('without an override the session route is used', async () => {
  const run = delegateMount({
    config: {},
    header: { config: { provider: 'header-provider', model: 'header-model' }, tools: [] },
    agentOptions: { provider: 'agent-provider', model: 'agent-model' },
  })
  const request = await generated(run)
  assert.equal(request.provider, 'header-provider')
  assert.equal(request.model, 'header-model')
})

test('the agent options are the last resort', async () => {
  const run = delegateMount({
    config: {},
    agentOptions: { provider: 'agent-provider', model: 'agent-model' },
  })
  const request = await generated(run)
  assert.equal(request.provider, 'agent-provider')
  assert.equal(request.model, 'agent-model')
})

test('an override with only one half is not applied', async () => {
  const run = delegateMount({
    // The schema documents "set together" (docs/03 §10); a half override falls through.
    config: { summarizationProvider: 'settings-provider' },
    header: { config: { provider: 'header-provider', model: 'header-model' }, tools: [] },
    agentOptions: { provider: 'agent-provider', model: 'agent-model' },
  })
  const request = await generated(run)
  assert.equal(request.provider, 'header-provider')
  assert.equal(request.model, 'header-model')
})

test('an incomplete session route falls through to the agent options', async () => {
  const run = delegateMount({
    config: {},
    header: { config: { provider: 'header-provider' }, tools: [] },
    agentOptions: { provider: 'agent-provider', model: 'agent-model' },
  })
  const request = await generated(run)
  assert.equal(request.provider, 'agent-provider')
  assert.equal(request.model, 'agent-model')
})

test('with no route at all start returns null before it streams anything', async () => {
  const run = delegateMount({ config: {}, agentOptions: null })
  await turnStopping(run.fake, run.agent)
  await flushMicrotasks()

  assert.equal(run.llm.calls.length, 0, 'no provider, so no call was made')
  assert.equal(
    run.fake.logs.filter((entry) => /no delegate summary/.test(entry.message)).length,
    0,
    'a missing route is a null generation, not an error',
  )

  // The null generation is a failed attempt (docs/03 §5.4): the next boundary records it durably
  // and does not retry the provider-less call.
  await turnStopping(run.fake, run.agent)
  assert.equal(run.record.commits.length, 0)
  assert.equal(run.record.failures.length, 1)
  assert.equal(run.llm.calls.length, 0)
})

test('the generated request is the prefix-anchored envelope with the chosen route', async () => {
  const tools = [{ name: 'read', parameters: {} }]
  const toolHistory = [{ id: 'call_1' }]
  const header = { config: { provider: 'deepseek', model: 'deepseek-chat' }, tools }
  const session = fakeSession({ header, toolHistory })
  const signal = new AbortController().signal
  const run = delegateMount({ config: {}, session })
  const streamed = run.llm.nextStreamCall()
  await turnStopping(run.fake, run.agent, signal)
  const request = await streamed
  await flushMicrotasks()

  assert.equal(request.provider, 'deepseek')
  assert.equal(request.model, 'deepseek-chat')
  assert.equal(request.purpose, 'compaction')
  assert.equal(request.maxTokens, DELEGATE_MAX_TOKENS)
  assert.equal(request.sessionId, session.id)
  assert.equal(request.signal, signal, 'the turn signal reaches the delegate call')
  assert.equal(request.tools, tools, 'the header tool schemas are passed through unchanged')
  assert.equal(request.toolHistory, toolHistory, 'the session tool history is passed unchanged')
  // The prefix begins with the in-history system/message and ends with the span: positions 0..6.
  assert.equal(request.messages.length, 8, 'seven surface messages plus the instruction')
  assert.equal(request.messages[0].role, 'system')
  assert.equal(request.messages[1].role, 'user')
  const instruction = at(at(request.messages, request.messages.length - 1).content, 0).text
  assert.equal(
    instruction,
    texts.renderDelegateInstruction({
      index: indexLinesFor({ session, region: { startIndex: 2, endIndex: 6 } }),
      budgetTokens: 200,
    }),
  )
})

// ---------------------------------------------------------------------------
// No LLM service (docs/03 §11)

test('without an LLM service no generation starts and the reason is said once', async () => {
  const run = delegateMount({ config: {}, llm: null })
  await turnStopping(run.fake, run.agent)
  await turnStopping(run.fake, run.agent)

  const warnings = run.fake.logs.filter((entry) => /LLM service is not available/.test(entry.message))
  assert.equal(warnings.length, 1, 'the one-shot line is logged once, not per boundary')
  assert.match(String(warnings[0]?.message), /tasks wait as before/)
  assert.equal(run.record.commits.length, 0)
  assert.equal(run.record.failures.length, 0, 'a task with no summarizer is not a failed attempt')
})

test('an LLM service that is gone by start time returns null before reading settings', async () => {
  /** @type {(string | symbol)[]} */
  const configReads = []
  /** @type {any} */
  const config = new Proxy(
    {},
    {
      /** @param {any} _target @param {string | symbol} key */
      get(_target, key) {
        configReads.push(key)
        return undefined
      },
    },
  )
  const run = delegateMount({ config, llm: fakeLlm(), llmThenGone: true })
  await turnStopping(run.fake, run.agent)
  await flushMicrotasks()

  assert.equal(run.fake.llmLookups, 2, 'supports() probed the service, then start() looked it up again')
  assert.equal(run.llm.calls.length, 0)
  assert.deepEqual(configReads, [], 'start returned before readSettings touched the config')
  assert.equal(run.record.commits.length, 0)
})

// ---------------------------------------------------------------------------
// The instruction budget: min(1500, max(200, round(spanTokens / 10)))

/**
 * @param {{ perMessage: number, budgetTokens: number }} expected
 * @param {ReturnType<typeof delegateMount>} run
 * @param {any} request
 */
function assertBudget(expected, run, request) {
  const instruction = at(at(request.messages, request.messages.length - 1).content, 0).text
  assert.equal(
    instruction,
    texts.renderDelegateInstruction({
      index: indexLinesFor({ session: run.session, region: { startIndex: 2, endIndex: 6 } }),
      budgetTokens: expected.budgetTokens,
    }),
    `spanTokens ${expected.perMessage * 5} must resolve to a ${expected.budgetTokens}-token budget`,
  )
}

test('a tiny span clamps the instruction budget up to 200 tokens', async () => {
  const run = delegateMount({ config: {}, meter: fakeMeter({ perMessage: 1 }) })
  const request = await generated(run)
  assertBudget({ perMessage: 1, budgetTokens: 200 }, run, request)
  const instruction = at(at(request.messages, request.messages.length - 1).content, 0).text
  assert.ok(instruction.includes('at most about 200 tokens'))
})

test('a middle span budgets a tenth of its tokens', async () => {
  const run = delegateMount({ config: {}, meter: fakeMeter({ perMessage: 1000 }) })
  const request = await generated(run)
  // Five span messages of 1000 tokens: round(5000 / 10) = 500.
  assertBudget({ perMessage: 1000, budgetTokens: 500 }, run, request)
})

test('a huge span clamps the instruction budget down to 1500 tokens', async () => {
  const run = delegateMount({ config: {}, meter: fakeMeter({ perMessage: 10_000 }) })
  const request = await generated(run)
  // Five span messages of 10,000 tokens: 50,000 / 10 would be 5,000, capped at DELEGATE_BUDGET.
  assertBudget({ perMessage: 10_000, budgetTokens: 1500 }, run, request)
})

// ---------------------------------------------------------------------------
// Summary validation and the commit (docs/03 §5.4)

test('a valid summary is held as blocks with its usage and committed at the next boundary', async () => {
  const usage = { inputTokens: 900, outputTokens: 42 }
  const run = delegateMount({ usage })
  await generated(run)
  assert.equal(run.record.commits.length, 0, 'generation never commits inside the first pass')

  await turnStopping(run.fake, run.agent)
  const commit = at(run.record.commits, 0)
  assert.equal(commit.start, 2)
  assert.equal(commit.end, 6)
  const node = at(commit.prepared.summary, 0)
  assert.equal(node.type, 'text')
  assert.match(node.text, /^# T1 · /, 'the committed node carries the task heading')
  assert.ok(node.text.includes(DEFAULT_SUMMARY), 'the generated summary is the node body')
  assert.equal(node.text.split('— fold of').length - 1, 1, 'one trailer, never two')
  assert.deepEqual(commit.prepared.usage, usage, 'the provider usage is carried to the host row')
  // The fold's recorded route follows the session's last header or, without one, the agent
  // options (runner.routeOf); the delegate route is not reused for it.
  assert.equal(commit.prepared.provider, 'deepseek')
  assert.equal(commit.prepared.model, 'deepseek-chat')
})

test('an accepted summary without usage commits no usage field', async () => {
  const run = delegateMount()
  await generated(run)
  await turnStopping(run.fake, run.agent)
  const commit = at(run.record.commits, 0)
  assert.equal(Object.hasOwn(commit.prepared, 'usage'), false)
})

test('a summary without a leading ## section is rejected and recorded as a failed attempt', async () => {
  const run = delegateMount({ text: 'a summary that never opens with a section heading' })
  await generated(run)
  await turnStopping(run.fake, run.agent)

  assert.equal(run.record.commits.length, 0, 'nothing was committed')
  assert.equal(run.record.failures.length, 1, 'the rejection counts toward the durable cap')
  assert.equal(run.llm.calls.length, 1, 'the rejected text is not regenerated in this pass')
})

test('a summary larger than the allowed share of the span is rejected', async () => {
  const run = delegateMount({
    // maxSummaryRatio is clamped to at least 0.05: 5 % of a 5,000-token span is 250 tokens, and
    // the fake meter says every message (including this summary) is 1,000.
    config: { maxSummaryRatio: 0.05 },
    meter: fakeMeter({ perMessage: 1000 }),
    text: `## Done\n${'word '.repeat(100)}`,
  })
  await generated(run)
  await turnStopping(run.fake, run.agent)

  assert.equal(run.record.commits.length, 0)
  assert.equal(run.record.failures.length, 1)
})

// ---------------------------------------------------------------------------
// Route resolution (host/summarizer.js routeOfRequest, used by the delegate path)

test('routeOfRequest reads the provider and model from the latest request header', () => {
  const session = fakeSession({ header: { config: { provider: 'header-provider', model: 'header' } } })
  assert.deepEqual(routeOfRequest(session), { provider: 'header-provider', model: 'header' })
})

test('routeOfRequest returns null unless the header carries a complete route', () => {
  const withoutHeader = fakeSession()
  assert.equal(routeOfRequest(withoutHeader), null, 'no requestHeader() at all')

  /** @param {any} header */
  const withHeader = (header) => ({ ...fakeSession(), requestHeader: () => header })
  assert.equal(routeOfRequest(withHeader(undefined)), null)
  assert.equal(routeOfRequest(withHeader({})), null, 'no config')
  assert.equal(routeOfRequest(withHeader({ config: 'deepseek' })), null, 'config is not an object')
  assert.equal(routeOfRequest(withHeader({ config: {} })), null, 'no provider')
  assert.equal(routeOfRequest(withHeader({ config: { provider: '' } })), null, 'empty provider')
  assert.equal(routeOfRequest(withHeader({ config: { provider: 42 } })), null, 'non-string provider')
  assert.equal(routeOfRequest(withHeader({ config: { provider: 'deepseek' } })), null, 'no model')
  assert.equal(routeOfRequest(withHeader({ config: { provider: 'deepseek', model: '' } })), null)
  assert.equal(routeOfRequest(withHeader({ config: { provider: 'deepseek', model: 7 } })), null)
})

// ---------------------------------------------------------------------------
// host/resolve.js: how a host package is found

/** The package manifest of this repository: an existing entry whose parent holds node_modules. */
const REPO_PACKAGE = fileURLToPath(new URL('../package.json', import.meta.url))
/** The repository root after symlink resolution, as runtimeModulesDir computes it. */
const REPO_DIR = fs.realpathSync(fileURLToPath(new URL('..', import.meta.url)))
const REPO_NODE_MODULES = path.join(REPO_DIR, 'node_modules')
const TEST_FILE = fileURLToPath(new URL('./mount.test.js', import.meta.url))
const MISSING_PACKAGE = 'dsh-task-folding-no-such-host-package'

test('loadHostModule returns the bare import untouched when it resolves', async () => {
  const fake = { BlockAssembler: class {} }
  /** @type {string[]} */
  const specs = []
  const found = await loadHostModule('host-package', {
    importer: async (spec) => {
      specs.push(spec)
      return fake
    },
  })
  assert.equal(found, fake)
  assert.deepEqual(specs, ['host-package'])
})

test('a bare import that yields nothing falls back to the runtime node_modules', async () => {
  const found = await loadHostModule('@eslint/js', { importer: async () => null, entry: REPO_PACKAGE })
  // The runtime-anchored route is a plain createRequire from that node_modules: same module.
  const direct = createRequire(path.join(REPO_NODE_MODULES, 'noop.js'))('@eslint/js')
  assert.equal(found, direct)
})

test('a throwing bare import falls back to the runtime node_modules too', async () => {
  const found = await loadHostModule('@eslint/js', {
    importer: async () => {
      throw new Error('bare resolution is not available here')
    },
    entry: TEST_FILE,
  })
  assert.equal(found, createRequire(path.join(REPO_NODE_MODULES, 'noop.js'))('@eslint/js'))
})

test('a package the runtime does not hold resolves to null', async () => {
  assert.equal(
    await loadHostModule(MISSING_PACKAGE, { importer: async () => null, entry: REPO_PACKAGE }),
    null,
  )
  assert.equal(await loadHostModule(MISSING_PACKAGE, { importer: async () => null }), null)
})

test('a package whose main cannot be required resolves to null', async () => {
  // @types/node is installed, so the runtime dir is found, but it exports only type declarations:
  // require() throws and the loader answers null instead of leaking the error.
  assert.equal(await loadHostModule('@types/node', { importer: async () => null, entry: REPO_PACKAGE }), null)
})

test('a missing entry or a failing realpath resolves to null', async () => {
  assert.equal(await loadHostModule(MISSING_PACKAGE, { importer: async () => null, entry: '' }), null)
  assert.equal(
    await loadHostModule(MISSING_PACKAGE, { importer: async () => null, entry: '/no such entry/plugin.js' }),
    null,
  )
})

test('runtimeModulesDir walks up from the entry to the nearest node_modules', () => {
  assert.equal(runtimeModulesDir(TEST_FILE, '@eslint/js'), REPO_NODE_MODULES)
  assert.equal(runtimeModulesDir(REPO_PACKAGE, '@eslint/js'), REPO_NODE_MODULES)
  assert.equal(runtimeModulesDir(TEST_FILE, MISSING_PACKAGE), null)
})

test('runtimeModulesDir returns null without an entry or at the filesystem root', () => {
  assert.equal(runtimeModulesDir(undefined, '@eslint/js'), null)
  assert.equal(runtimeModulesDir('', '@eslint/js'), null)
  // Walking past the root terminates instead of looping.
  assert.equal(runtimeModulesDir('/', MISSING_PACKAGE), null)
})

test('loadSchemastery unwraps the default export, the namespace or nothing', async () => {
  /** @type {any} */
  const schema = () => ({})
  schema.object = () => ({})
  assert.equal(await loadSchemastery({ importer: async () => ({ default: schema }) }), schema)
  assert.equal(await loadSchemastery({ importer: async () => schema }), schema)
  assert.equal(await loadSchemastery({ importer: async () => ({ default: () => ({}) }) }), null)
  assert.equal(await loadSchemastery({ importer: async () => ({ default: {} }) }), null)
  assert.equal(await loadSchemastery({ importer: async () => ({}) }), null)
  assert.equal(await loadSchemastery({ importer: async () => null }), null)
})
