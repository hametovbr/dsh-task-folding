// The delegate summarizer (docs/03 §5.4, §7.2): phase 1 of a delegate fold, generated in the
// background. It builds the prefix-anchored request, renders the span index and the instruction,
// runs one `ctx.llm.stream` call through the host's own `BlockAssembler`, and validates the text
// before the runner may commit it.
//
// The request is prefix-identical to the main request by construction: every surface node before
// the span, then the span, then the instruction as the last user message, with the latest
// request/header's `tools` and the session's `toolHistory` passed through untouched. Changing the
// order or content of `messages` or `tools` silently breaks the provider's prefix cache, which is
// exactly what makes this otherwise expensive call cheap. Nothing here reads the event log
// wholesale, appends events, writes files or touches compaction internals.

import { briefOfSeq, toolCallNames } from './recall.js'
import * as texts from './texts.js'

/** @typedef {import('./planner.js').FoldRegion} FoldRegion */

/**
 * The latest `request/header` (docs/02 §2): the route the main request used and the tool schemas
 * it carried.
 *
 * @typedef {object} DelegateHeader
 * @property {any} [config] the header's `config` (provider, model, sampling scalars)
 * @property {any[]} [tools] the header's tool schemas, absent for a tool-less request
 */

/**
 * The part of the host session the delegate request reads (docs/02 §2).
 *
 * @typedef {object} DelegateSession
 * @property {{ nodes: readonly number[] }} surface
 * @property {(seq: number) => any} eventAt
 * @property {(event: any) => any} deriveEventMessage
 * @property {() => DelegateHeader | undefined} [requestHeader]
 */

/**
 * @typedef {object} DelegateRequest
 * @property {any[]} messages
 * @property {any[]} [tools] the header's schemas, unchanged
 */

/**
 * @typedef {object} DelegateLlm
 * @property {(options: any) => AsyncIterable<any>} stream
 */

/**
 * Resolves a host package by bare specifier (the lead passes `loadHostModule`).
 *
 * @typedef {(spec: string) => Promise<any>} HostLoader
 */

/**
 * @typedef {{ provider: string, model: string }} DelegateRoute
 */

/**
 * @typedef {{ type: 'text', text: string }} DelegateBlock
 */

/**
 * @typedef {object} DelegateGeneration
 * @property {DelegateBlock[]} blocks the text blocks of the complete output
 * @property {string} text those blocks joined in order
 * @property {any} usage provider-reported usage, when the stream carried one
 */

// ---------------------------------------------------------------------------
// The request

/**
 * Build the delegate request for one region: the surface prefix, then the span, then nothing. The
 * instruction is appended by {@link generateDelegateSummary} as the final user message.
 *
 * @param {{ session: DelegateSession, region: Pick<FoldRegion, 'startIndex' | 'endIndex'> }} input
 * @returns {DelegateRequest}
 */
export function buildDelegateRequest({ session, region }) {
  const nodes = session.surface.nodes
  /** @type {any[]} */
  const messages = []
  // The prefix begins with the in-history system/message when the surface has one (docs/02 §2).
  for (let i = 0; i < region.startIndex; i++) pushNodeMessage(session, nodes, i, messages)
  for (let i = region.startIndex; i <= region.endIndex; i++) pushNodeMessage(session, nodes, i, messages)
  /** @type {DelegateRequest} */
  const request = { messages }
  const header = headerOf(session)
  // Pass the header's array through as-is: a copy is harmless, but the cache only proves identity.
  if (header !== undefined && header.tools !== undefined) request.tools = header.tools
  return request
}

/**
 * The provider/model the session was last routed to, read from the latest `request/header`
 * (docs/02 §2). Null when there is no header or it carries no complete route, so the caller can
 * fall back to the settings override and the agent options (docs/03 §5.4).
 *
 * @param {DelegateSession} session
 * @returns {DelegateRoute | null}
 */
export function routeOfRequest(session) {
  const header = headerOf(session)
  if (header === undefined) return null
  const config = header.config
  if (!config || typeof config !== 'object') return null
  const provider = config.provider
  const model = config.model
  if (typeof provider !== 'string' || provider === '') return null
  if (typeof model !== 'string' || model === '') return null
  return { provider, model }
}

/** @param {DelegateSession} session @returns {DelegateHeader | undefined} */
function headerOf(session) {
  return typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
}

/**
 * @param {DelegateSession} session
 * @param {readonly number[]} nodes
 * @param {number} index
 * @param {any[]} messages
 */
function pushNodeMessage(session, nodes, index, messages) {
  const seq = nodes[index]
  if (seq === undefined) return
  const event = session.eventAt(seq)
  if (event === undefined || event === null) return
  const message = session.deriveEventMessage(event)
  if (message !== null && message !== undefined) messages.push(message)
}

// ---------------------------------------------------------------------------
// The span index and the instruction

/**
 * One numbered line per span message, in surface order, in the same one-line brief style as the
 * fold index (docs/04 §1): `L3 tool read: 309 lines`. Numbering starts at 1, so it matches the
 * `fold_recall` index of the fold this summary becomes.
 *
 * @param {{ session: DelegateSession, region: Pick<FoldRegion, 'startIndex' | 'endIndex'> }} input
 * @returns {string[]}
 */
export function indexLinesFor({ session, region }) {
  const nodes = session.surface.nodes
  /** @type {number[]} */
  const seqs = []
  for (let i = region.startIndex; i <= region.endIndex; i++) {
    const seq = nodes[i]
    if (seq !== undefined) seqs.push(seq)
  }
  const names = toolCallNames(session, seqs)
  /** @type {string[]} */
  const lines = []
  for (const [position, seq] of seqs.entries()) {
    lines.push(texts.renderIndexLine(position + 1, briefOfSeq(session, seq, names)))
  }
  return lines
}

// ---------------------------------------------------------------------------
// The call

/**
 * Run one delegate summarization through the host LLM seam and assemble its output. The instruction
 * is appended as the final user message, after the prefix and the span, so the call stays a prefix
 * of the main request and reuses the provider's cache.
 *
 * Throws on a terminal error or aborted finish (surfacing the provider's own message), on a
 * max-tokens truncation, and when the assembled output carries no text (docs/03 §5.4).
 *
 * @param {object} input
 * @param {DelegateLlm} input.llm the host's `ctx.llm`, never wrapped or patched
 * @param {HostLoader} input.loader resolves `@deepseek-ai/dsh-llm` for `BlockAssembler`
 * @param {DelegateRequest} input.request from {@link buildDelegateRequest}
 * @param {string} input.instruction the rendered instruction (docs/03 §7.2)
 * @param {DelegateRoute} input.route
 * @param {number} input.maxTokens
 * @param {string} input.sessionId
 * @param {any} input.toolHistory from `session.toolHistory()`, unchanged
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<DelegateGeneration>}
 */
export async function generateDelegateSummary({
  llm,
  loader,
  request,
  instruction,
  route,
  maxTokens,
  sessionId,
  toolHistory,
  signal,
}) {
  const llmModule = await loader('@deepseek-ai/dsh-llm')
  const resolved = llmModule === null || llmModule === undefined ? undefined : llmModule.BlockAssembler
  if (typeof resolved !== 'function') throw new Error(texts.DELEGATE_NO_ASSEMBLER)
  const Assembler = /** @type {new () => any} */ (resolved)
  const assembler = new Assembler()

  /** @type {any[]} */
  const messages = [...request.messages, { role: 'user', content: [{ type: 'text', text: instruction }] }]
  /** @type {any} */
  const options = {
    provider: route.provider,
    model: route.model,
    messages,
    toolHistory,
    maxTokens,
    sessionId,
    purpose: 'compaction',
  }
  // Same reason as in buildDelegateRequest: hand the exact arrays over, never a reshaped copy.
  if (request.tools !== undefined) options.tools = request.tools
  if (signal !== undefined) options.signal = signal

  for await (const chunk of llm.stream(options)) assembler.push(chunk)
  throwOnFinish(assembler.finish)

  const output = assembler.blocks()
  /** @type {DelegateBlock[]} */
  const blocks = []
  const raw = Array.isArray(output) ? output : []
  for (const block of raw) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text })
    }
  }
  if (!blocks.some((block) => block.text.trim() !== '')) throw new Error(texts.DELEGATE_EMPTY_OUTPUT)
  return { blocks, text: blocks.map((block) => block.text).join(''), usage: assembler.usage }
}

/**
 * Fail closed on a finish that cannot yield a complete summary; surface the provider's message
 * when the finish carries one (docs/02 §7).
 *
 * @param {any} finish
 */
function throwOnFinish(finish) {
  if (!finish || typeof finish !== 'object') return
  if (finish.kind === 'max-tokens') throw new Error(texts.DELEGATE_MAX_TOKENS)
  if (finish.kind !== 'error' && finish.kind !== 'aborted') return
  const failure = finish.failure
  if (failure && typeof failure.message === 'string' && failure.message !== '') {
    throw new Error(failure.message)
  }
  throw new Error(finish.kind === 'aborted' ? texts.DELEGATE_ABORTED : texts.DELEGATE_FAILED)
}

// ---------------------------------------------------------------------------
// Validation

/** A heading may follow at most this many lines (docs/03 §5.4). */
const PREAMBLE_MAX_LINES = 3
/** A preamble line longer than this is not "short" (docs/03 §5.4). */
const PREAMBLE_MAX_CHARS = 200

/**
 * Validate generated summary text before the runner holds it for commit (docs/03 §5.4): non-empty,
 * opening with a `## ` section after at most three short preamble lines, and no larger than
 * `maxSummaryRatio` of the span. A rejection is a failed generation and counts as an attempt.
 *
 * @param {string} text
 * @param {{ spanTokens: number, maxSummaryRatio: number, estimator: { text(text: string): number } }} options
 * @returns {{ ok: true, blocks: DelegateBlock[] } | { ok: false, reason: string }}
 */
export function validateDelegateSummary(text, { spanTokens, maxSummaryRatio, estimator }) {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, reason: texts.DELEGATE_EMPTY }
  if (!opensWithSection(text)) return { ok: false, reason: texts.DELEGATE_NO_SECTION }
  const tokens = estimateText(estimator, text)
  const limit = maxSummaryRatio * spanTokens
  if (tokens > limit) return { ok: false, reason: texts.DELEGATE_TOO_LARGE(tokens, limit) }
  return { ok: true, blocks: [{ type: 'text', text }] }
}

/**
 * Whether the first `## ` line comes after at most three short preamble lines.
 *
 * @param {string} text
 * @returns {boolean}
 */
function opensWithSection(text) {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.startsWith('## ')) return true
    if (i >= PREAMBLE_MAX_LINES) return false
    if (line.length > PREAMBLE_MAX_CHARS) return false
  }
  return false
}

/**
 * @param {{ text(text: string): number }} estimator
 * @param {string} text
 * @returns {number}
 */
function estimateText(estimator, text) {
  const value = estimator.text(text)
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}
