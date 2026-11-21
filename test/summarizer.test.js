// The delegate summarizer (docs/03 §5.4, §7.2): the prefix-identical request, the numbered span
// index, the instruction, the LLM call envelope and the output validation. No network: the LLM
// seam is a fake async generator and the host package is a stub loader.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveRegion } from '../host/planner.js'
import { foldIndex } from '../host/recall.js'
import {
  buildDelegateRequest,
  generateDelegateSummary,
  indexLinesFor,
  routeOfRequest,
  validateDelegateSummary,
} from '../host/summarizer.js'
import * as texts from '../host/texts.js'
import { Sim } from './fixtures/sim.js'
import { harnessOf, sessionOf } from './fixtures/tools.js'

/** @typedef {import('../host/planner.js').FoldRegion} FoldRegion */
/** @typedef {import('../host/types.js').Task} Task */

/** A summary that clears minSummaryChars without being large. */
const SUMMARY = `## Done\n${'Wired the delegate path and checked its envelope. '.repeat(5)}`

/** The header's tools array, compared by identity in the pass-through assertions. */
const HEADER_TOOLS = [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }]

/** Shared by the call-envelope tests. */
const TOOL_HISTORY = { tools: [], updates: [] }

/**
 * A session over the simulator with the request/header and tool history the delegate path reads
 * (docs/02 §2).
 *
 * @param {Sim} sim
 * @param {{ config?: any, tools?: any[] } | undefined} [header]
 */
function sessionWith(sim, header) {
  return {
    ...sessionOf(sim),
    requestHeader: () => header,
    toolHistory: () => TOOL_HISTORY,
  }
}

/**
 * An assistant message with one `read` call whose result has the given number of lines.
 *
 * @param {Sim} sim
 * @param {string} path
 * @param {number} lines
 */
function readBatch(sim, path, lines) {
  const { ids } = sim.assistant([{ name: 'read', args: { path } }])
  const callId = ids[0]
  if (callId === undefined) throw new Error('the sim gave no call id')
  const callSeq = sim.push({ type: 'tool/call', data: { callId, name: 'read' } })
  sim.push({
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [
          { type: 'text', text: Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n') },
        ],
        isError: false,
      },
    },
    surfaceOp: 'append',
    sourceEventSeqs: [callSeq],
  })
  sim.stepEnd()
}

/**
 * A session with one closed task: work before it, a user message and a 309-line tool read inside
 * it, then the close batch. The span is a fold region.
 */
async function taskFixture() {
  const sim = new Sim()
  sim.user('earlier work outside the task')
  const h = harnessOf(sim)
  await h.batch([{ name: 'task_begin', args: { title: 'inspect the delegate path' } }])
  sim.user('look at the fold runner')
  readBatch(sim, 'src/fold-runner.js', 309)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  const task = sim.state.tasks['T1']
  if (task === undefined) throw new Error('the sim did not record task T1')
  const region = resolveRegion(task, sim.nodes)
  if (region.kind !== 'fold') throw new Error(`expected a fold region, got ${region.kind}`)
  return { sim, h, task, region }
}

// ---------------------------------------------------------------------------
// The request

test('the request is the surface prefix then the span, derived exactly as the host derives them', async () => {
  const { sim, h, region } = await taskFixture()
  const session = sessionWith(sim, { config: { provider: 'deepseek', model: 'deepseek-chat' } })
  const request = buildDelegateRequest({ session, region })

  // Built directly from sim.nodes: every surface node up to the end of the span, in order.
  const expected = sim.nodes.slice(0, region.endIndex + 1).map((seq) => {
    const event = sim.bySeq.get(seq)
    if (event === undefined) throw new Error(`no event for seq ${seq}`)
    return h.session.deriveEventMessage(event)
  })
  assert.deepEqual(request.messages, expected, 'prefix plus span, message for message')
  assert.equal(request.messages.length, region.endIndex + 1, 'nothing was added, dropped or reordered')

  const prefix = request.messages.slice(0, region.startIndex)
  const span = request.messages.slice(region.startIndex)
  assert.equal(prefix.length, region.startIndex, 'every node before the span is in the prefix')
  assert.equal(prefix[0].role, 'system', 'the prefix begins with the in-history system message')
  assert.equal(span.length, region.endIndex - region.startIndex + 1, 'one message per span node')
  assert.equal(span[0].content[0].text, 'look at the fold runner', 'the span starts at its first node')
})

test('the request carries the header tools array itself, not a copy or a reorder', async () => {
  const { sim, region } = await taskFixture()
  const header = { config: { provider: 'p', model: 'm' }, tools: HEADER_TOOLS }
  const session = sessionWith(sim, header)
  const request = buildDelegateRequest({ session, region })

  assert.deepEqual(request.tools, session.requestHeader()?.tools, 'the tools are the header schemas')
  assert.equal(
    request.tools,
    session.requestHeader()?.tools,
    'the same array reference: no copy, map or reorder',
  )
})

test('tools are omitted when the latest header does not carry them', async () => {
  const { sim, region } = await taskFixture()
  const without = buildDelegateRequest({
    session: sessionWith(sim, { config: { provider: 'p', model: 'm' } }),
    region,
  })
  assert.equal('tools' in without, false, 'a tool-less header adds no tools property')

  const bare = buildDelegateRequest({ session: sessionOf(sim), region })
  assert.equal('tools' in bare, false, 'a session that never saw a header is fine')
})

test('routeOfRequest reads provider and model from the latest request/header', async () => {
  const { sim } = await taskFixture()
  assert.deepEqual(
    routeOfRequest(sessionWith(sim, { config: { provider: 'deepseek', model: 'deepseek-chat' } })),
    { provider: 'deepseek', model: 'deepseek-chat' },
  )
  assert.equal(routeOfRequest(sessionWith(sim, { tools: HEADER_TOOLS })), null, 'no config means no route')
  assert.equal(routeOfRequest(sessionWith(sim, undefined)), null, 'no header means no route')
  assert.equal(routeOfRequest(sessionOf(sim)), null, 'a session without requestHeader is fine')
})

// ---------------------------------------------------------------------------
// The span index

test('indexLinesFor numbers the span in surface order with one-line briefs', async () => {
  const { sim, region } = await taskFixture()
  const lines = indexLinesFor({ session: sessionOf(sim), region })

  assert.equal(lines.length, region.endIndex - region.startIndex + 1, 'one line per span message')
  for (const [i, line] of lines.entries()) assert.match(line, new RegExp(`^L${i + 1} \\S`))
  assert.equal(lines[0], 'L1 user: look at the fold runner')
  assert.equal(lines[1], 'L2 assistant: thinking')
  assert.equal(lines[2], 'L3 tool read: 309 lines', 'a tool line names the tool and a size hint')
  assert.equal(lines[3], 'L4 assistant: thinking')
  assert.equal(lines[4], 'L5 tool task_end: result')

  // The index is exactly the fold_recall index of the fold this summary becomes (docs/04 §1).
  sim.fold('T1')
  const recall = foldIndex(sim.state, sessionOf(sim), 1).split('\n').slice(1)
  assert.deepEqual(lines, recall)
})

// ---------------------------------------------------------------------------
// The instruction

test('the instruction carries the budget, the nested-fold rule and the index, and forbids tools', () => {
  const index = ['L1 user: look at the fold runner', 'L2 tool read: 309 lines']
  const instruction = texts.renderDelegateInstruction({ index, budgetTokens: 1500 })

  assert.ok(instruction.startsWith('You are acting as the summarizer'), 'it sets the task')
  assert.ok(instruction.includes('5-10%'), 'the 5-10 % size aim (docs/03 §7.2)')
  assert.ok(instruction.includes('1,500 tokens'), 'the token budget is rendered')
  assert.ok(instruction.includes('<compacted-summary>'), 'the nested-fold marker is named')
  assert.match(instruction, /keep their conclusions/)
  assert.match(instruction, /do not re-narrate/)
  assert.doesNotMatch(instruction, /why:/i, 'no rationale is demanded on every bullet')
  assert.match(instruction, /never call a tool/, 'it says the call must not use tools')
  assert.ok(instruction.includes('exact file paths'), 'it says what to write about')
  assert.ok(instruction.includes('identifiers'))
  assert.ok(instruction.includes('corrections'))
  assert.ok(instruction.includes('what failed'))
  assert.ok(instruction.includes(index[0] ?? ''), 'the index lines are part of the instruction')
  assert.ok(instruction.includes(index[1] ?? ''))
  // Byte-stable for the same inputs.
  assert.equal(texts.renderDelegateInstruction({ index, budgetTokens: 1500 }), instruction)
})

// ---------------------------------------------------------------------------
// The call

/**
 * The subset of `@deepseek-ai/dsh-llm`'s BlockAssembler the delegate path uses, with the real
 * package's semantics for text blocks, usage and finish
 * (packages/llm/dsh-llm/src/assembler.ts).
 */
class StubBlockAssembler {
  constructor() {
    /** @type {Map<number, { blockType: string, text: string, block?: any }>} */
    this.partials = new Map()
    /** @type {number[]} */
    this.order = []
    /** @type {any} */
    this._usage = undefined
    /** @type {any} */
    this._finish = undefined
  }

  /** @param {any} chunk */
  push(chunk) {
    if (chunk.type === 'block-start') {
      this.ensure(chunk.index, chunk.blockType)
    } else if (chunk.type === 'text-delta') {
      this.ensure(chunk.index, 'text').text += chunk.text
    } else if (chunk.type === 'block-end') {
      this.ensure(chunk.index, chunk.block.type).block = chunk.block
    } else if (chunk.type === 'usage') {
      this._usage = chunk.usage
    } else if (chunk.type === 'finish') {
      this._finish = chunk.reason
    } else {
      throw new Error(`unexpected chunk ${JSON.stringify(chunk)}`)
    }
  }

  /**
   * @param {number} index
   * @param {string} [blockType]
   */
  ensure(index, blockType = 'text') {
    let partial = this.partials.get(index)
    if (partial === undefined) {
      partial = { blockType, text: '' }
      this.partials.set(index, partial)
      this.order.push(index)
    }
    return partial
  }

  /** @returns {any[]} */
  blocks() {
    return this.order.map((index) => {
      const partial = this.ensure(index)
      return partial.block ?? { type: 'text', text: partial.text }
    })
  }

  get usage() {
    return this._usage
  }

  get finish() {
    return this._finish ?? { kind: 'stop' }
  }
}

/** @param {any[]} chunks */
async function* streamOfChunks(chunks) {
  for (const chunk of chunks) yield chunk
}

/**
 * A fake `ctx.llm`: streams the chunks and records every call envelope.
 *
 * @param {any[]} chunks
 */
function fakeLlm(chunks) {
  /** @type {any[]} */
  const calls = []
  return {
    calls,
    llm: {
      /** @param {any} options */
      stream(options) {
        calls.push(options)
        return streamOfChunks(chunks)
      },
    },
  }
}

/**
 * A stub loader that resolves only the host LLM package, from the installed host's exports.
 *
 * @param {string[]} [specs]
 * @returns {(spec: string) => Promise<any>}
 */
function loaderFor(specs = []) {
  return async (/** @type {string} */ spec) => {
    specs.push(spec)
    return spec === '@deepseek-ai/dsh-llm' ? { BlockAssembler: StubBlockAssembler } : null
  }
}

/** One complete text response plus usage and a stop finish. @param {string} text */
function stopChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 900, outputTokens: 42 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

test('generateDelegateSummary assembles the stream and sends the prefix-identical envelope', async () => {
  const text = '## Done\nWired the delegate path and checked its envelope.'
  const { llm, calls } = fakeLlm(stopChunks(text))
  /** @type {string[]} */
  const specs = []
  const request = {
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'system' }] },
      { role: 'user', content: [{ type: 'text', text: 'fix the redirect loop' }] },
    ],
    tools: HEADER_TOOLS,
  }
  const instruction = texts.renderDelegateInstruction({
    index: ['L1 user: fix the redirect loop'],
    budgetTokens: 1500,
  })
  const signal = new AbortController().signal
  const result = await generateDelegateSummary({
    llm,
    loader: loaderFor(specs),
    request,
    instruction,
    route: { provider: 'deepseek', model: 'deepseek-chat' },
    maxTokens: 1500,
    sessionId: 'session-1',
    toolHistory: TOOL_HISTORY,
    signal,
  })

  assert.deepEqual(result.blocks, [{ type: 'text', text }])
  assert.equal(result.text, text)
  assert.deepEqual(result.usage, { inputTokens: 900, outputTokens: 42 })
  assert.deepEqual(specs, ['@deepseek-ai/dsh-llm'], 'the assembler comes from the host package')

  assert.equal(calls.length, 1)
  const sent = calls[0]
  assert.equal(sent.provider, 'deepseek')
  assert.equal(sent.model, 'deepseek-chat')
  assert.equal(sent.purpose, 'compaction')
  assert.equal(sent.maxTokens, 1500)
  assert.equal(sent.sessionId, 'session-1')
  assert.equal(sent.signal, signal)
  assert.equal(sent.toolHistory, TOOL_HISTORY, 'the session tool history is passed unchanged')
  assert.equal(sent.tools, request.tools, 'the header tools array is passed unchanged')
  assert.deepEqual(sent.messages.slice(0, -1), request.messages, 'the replayed prefix is unchanged')
  assert.deepEqual(
    sent.messages.at(-1),
    { role: 'user', content: [{ type: 'text', text: instruction }] },
    'the instruction is the final user message and nothing follows it',
  )
})

test('the envelope omits tools and signal when they are absent', async () => {
  const { llm, calls } = fakeLlm(stopChunks('## Done\nok'))
  await generateDelegateSummary({
    llm,
    loader: loaderFor(),
    request: { messages: [] },
    instruction: 'summarize',
    route: { provider: 'p', model: 'm' },
    maxTokens: 100,
    sessionId: 's',
    toolHistory: undefined,
  })
  const sent = calls[0]
  assert.equal('tools' in sent, false)
  assert.equal('signal' in sent, false)
})

test('a terminal finish rejects with the provider message', async () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'partial' },
    {
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'SERVER', message: 'provider exploded' } },
    },
  ]
  await assert.rejects(
    generateDelegateSummary({
      llm: fakeLlm(chunks).llm,
      loader: loaderFor(),
      request: { messages: [] },
      instruction: 'summarize',
      route: { provider: 'p', model: 'm' },
      maxTokens: 100,
      sessionId: 's',
      toolHistory: TOOL_HISTORY,
    }),
    /provider exploded/,
  )
})

test('an aborted finish rejects with the provider message', async () => {
  const chunks = [
    { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'client aborted' } } },
  ]
  await assert.rejects(
    generateDelegateSummary({
      llm: fakeLlm(chunks).llm,
      loader: loaderFor(),
      request: { messages: [] },
      instruction: 'summarize',
      route: { provider: 'p', model: 'm' },
      maxTokens: 100,
      sessionId: 's',
      toolHistory: TOOL_HISTORY,
    }),
    /client aborted/,
  )
})

test('a token-cap truncation and an empty output reject', async () => {
  await assert.rejects(
    generateDelegateSummary({
      llm: fakeLlm([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: '## Done\ncut' },
        { type: 'finish', reason: { kind: 'max-tokens' } },
      ]).llm,
      loader: loaderFor(),
      request: { messages: [] },
      instruction: 'summarize',
      route: { provider: 'p', model: 'm' },
      maxTokens: 5,
      sessionId: 's',
      toolHistory: TOOL_HISTORY,
    }),
    { message: texts.DELEGATE_MAX_TOKENS },
  )

  await assert.rejects(
    generateDelegateSummary({
      llm: fakeLlm([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: '   ' },
        { type: 'finish', reason: { kind: 'stop' } },
      ]).llm,
      loader: loaderFor(),
      request: { messages: [] },
      instruction: 'summarize',
      route: { provider: 'p', model: 'm' },
      maxTokens: 100,
      sessionId: 's',
      toolHistory: TOOL_HISTORY,
    }),
    { message: texts.DELEGATE_EMPTY_OUTPUT },
  )
})

// ---------------------------------------------------------------------------
// Validation

/** The estimator seam is the host's `SpanEstimator.text`; characters stand in for tokens. */
const ESTIMATOR = { text: (/** @type {string} */ text) => text.length }

/** @param {Partial<{ spanTokens: number, maxSummaryRatio: number }>} [overrides] */
function validationOptions(overrides = {}) {
  return { spanTokens: 1000, maxSummaryRatio: 0.5, estimator: ESTIMATOR, ...overrides }
}

test('validateDelegateSummary rejects empty text and text without a section', () => {
  assert.deepEqual(validateDelegateSummary('', validationOptions()), {
    ok: false,
    reason: texts.DELEGATE_EMPTY,
  })
  assert.deepEqual(validateDelegateSummary('  \n ', validationOptions()), {
    ok: false,
    reason: texts.DELEGATE_EMPTY,
  })
  assert.deepEqual(validateDelegateSummary('plain prose only', validationOptions()), {
    ok: false,
    reason: texts.DELEGATE_NO_SECTION,
  })
})

test('validateDelegateSummary allows at most three short preamble lines', () => {
  const options = validationOptions()
  assert.deepEqual(validateDelegateSummary('note\nnote\nnote\n## Done\nok', options), {
    ok: true,
    blocks: [{ type: 'text', text: 'note\nnote\nnote\n## Done\nok' }],
  })
  assert.equal(validateDelegateSummary('a\nb\nc\nd\n## Done\nok', options).ok, false)
  assert.equal(validateDelegateSummary(`${'x'.repeat(201)}\n## Done\nok`, options).ok, false)
})

test('validateDelegateSummary rejects a summary over the allowed share of the span', () => {
  /** @type {string[]} */
  const seen = []
  const estimator = {
    /** @param {string} text */
    text(text) {
      seen.push(text)
      return text.length
    },
  }
  const text = `## Done\n${'x'.repeat(200)}`
  const result = validateDelegateSummary(text, { spanTokens: 100, maxSummaryRatio: 0.5, estimator })
  assert.equal(result.ok, false)
  if (result.ok) throw new Error('unreachable')
  assert.match(result.reason, /too large/)
  assert.match(result.reason, /limit/)
  assert.deepEqual(seen, [text], 'the estimator prices the exact text')
})

test('validateDelegateSummary accepts a sectioned summary and returns the text block', () => {
  const text = '## Done\nWired the request and checked its envelope.'
  assert.deepEqual(validateDelegateSummary(text, validationOptions()), {
    ok: true,
    blocks: [{ type: 'text', text }],
  })
})
