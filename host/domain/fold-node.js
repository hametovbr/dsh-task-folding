// The node a fold commits: the one producer of node form, shared by the self, delegate and
// implicit-turn commit sites (docs/03 §7.3, docs/adr/0009-fold-keeps-user-text.md).
//
// It sanitises the model's summary in both directions and pins what the fold would otherwise
// destroy: the human's inbound text is quoted verbatim, plugin-authored nodes are named and
// referenced, and re-injected context produces nothing. Reading the region is the caller's job;
// this module only shapes the plain data bag it receives.
//
// Pure: no ctx, no I/O, no clock, no randomness.

import * as texts from './texts.js'

/** @typedef {{ id: string, title: string, outcome: string | null }} FoldTask */
/** @typedef {{ text(text: string): number }} TextEstimator */

/**
 * One inbound surface node of the folded region, as the commit site extracted it. `kind` is the
 * message's `source.kind`; an unknown source is the string `unknown`.
 *
 * @typedef {object} InboundNode
 * @property {number} seq
 * @property {string} kind
 * @property {string} text
 */

/**
 * The plain data bag a commit site hands over, before the node's own size is measured.
 *
 * @typedef {object} FoldNodeInput
 * @property {readonly InboundNode[]} inbound the region's user/message nodes, in surface order
 * @property {number} spanTokens tokens the region shadows
 * @property {TextEstimator} estimator the plugin's own token estimator
 * @property {FoldTask | null} task the folded task, or null for an implicit turn fold
 * @property {number | null} fold the 1-based fold number; required when `task` is null
 * @property {number} messages messages the region shadows, for the trailer
 */

/**
 * The input plus the node's own size (see {@link nodeTokensOf}), which the adaptive pin budget
 * subtracts from half the span.
 *
 * @typedef {FoldNodeInput & { nodeTokens: number }} FoldNodeContext
 */

/** A single node pin never quotes more than this many characters (ADR 0009, Caps). */
export const MAX_PIN_CHARS = 2000
/** One pinned section never exceeds this many characters, heading included. */
export const MAX_SECTION_CHARS = 4000
/** Below this many tokens of adaptive budget a pin is replaced by a marker, not squeezed. */
export const MIN_PIN_TOKENS = 40
/**
 * Kinds the host or a memory plugin re-injects every turn (ADR 0009): a frozen copy would compete
 * with the live one, and pinning a checkpoint into the next one recurses.
 */
export const REINJECTED_KINDS = Object.freeze(
  new Set([
    'compact-checkpoint',
    'agent-instructions',
    'runtime-context',
    'time-context',
    'skill-catalog',
    'dsh-mnemon',
  ]),
)

/** The plugin's own copied trailer: a summary that carries it must not produce a second one. */
const TRAILER_LINE = /^— fold of T[0-9]+ · .*$/
/** The plugin's own node heading, copied to the front of a summary by a model that saw a fold. */
const HEADING_LINE = /^# T[0-9]+ · .*$/
/** A nested checkpoint inside a summary is folded work, not a sentence to reproduce. */
const COMPACTED_BLOCK = /<compacted-summary>[\s\S]*?<\/compacted-summary>/g

/**
 * Remove from the model's text the parts this plugin itself wrote, and elide a nested checkpoint.
 *
 * `summary` also strips a leading `# T<n> · …` heading, because a summary has no use for one: the
 * node adds its own. `pin` never strips the heading — a user's own text may legitimately start with
 * one, and verbatim fidelity is the point. Both modes leave the text idempotent, so a sanitised
 * node sanitised again does not change.
 *
 * @param {string} text
 * @param {'summary' | 'pin'} mode
 * @returns {string}
 */
export function sanitizeFoldText(text, mode) {
  const elided = text.replace(COMPACTED_BLOCK, texts.FOLD_ELIDED_SUMMARY)
  const lines = elided.split('\n').filter((line) => !TRAILER_LINE.test(line))
  if (mode === 'summary') {
    // Leading blank lines are removed here rather than by the final trim: after the trim the next
    // heading would be leading on a second pass, which would break idempotence.
    while (lines.length > 0) {
      const first = lines[0] ?? ''
      if (first.trim() !== '' && !HEADING_LINE.test(first)) break
      lines.shift()
    }
  }
  return lines.join('\n').trim()
}

/**
 * The text of the model's own blocks, joined: the summary that goes inside the node. A node has one
 * text block, so non-text blocks carry nothing the model reads later.
 *
 * @param {readonly any[]} blocks
 * @returns {string}
 */
export function foldBlocksText(blocks) {
  /** @type {string[]} */
  const parts = []
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * The node's size without the pinned sections, measured with the plugin's estimator. The commit
 * site passes the result back as `nodeTokens`; the adaptive pin budget is what is left of half the
 * span after it, which is what keeps a node smaller than the region it replaces.
 *
 * @param {readonly any[]} blocks
 * @param {FoldNodeInput} input
 * @returns {number}
 */
export function nodeTokensOf(blocks, input) {
  return input.estimator.text(foldNodeText(blocks, { ...input, inbound: [], nodeTokens: 0 }))
}

/**
 * The node text. The summary is sanitised first; then the pinned sections are rendered under the
 * adaptive budget, which is what keeps a node smaller than the span it replaces.
 *
 * @param {readonly any[]} blocks the model's blocks (a self summary or generated text)
 * @param {FoldNodeContext} ctx
 * @returns {string}
 */
export function foldNodeText(blocks, ctx) {
  const summary = sanitizeFoldText(foldBlocksText(blocks), 'summary')
  const sections = pinnedSections(ctx)
  const stats = { messages: ctx.messages, tokens: ctx.spanTokens }
  return ctx.task === null
    ? texts.renderTurnFoldNode(summary, stats, ctx.fold, sections)
    : texts.renderFoldNode(ctx.task, summary, stats, sections)
}

/**
 * The single producer of node form (ADR 0009), called at every commit site.
 *
 * @param {readonly any[]} blocks the model's blocks
 * @param {FoldNodeContext} ctx
 * @returns {any[]} the prepared blocks the commit hands the host: one text block
 */
export function finalizeFoldBlocks(blocks, ctx) {
  return [{ type: 'text', text: foldNodeText(blocks, ctx) }]
}

/**
 * The two pinned sections of the node, verbatim first. The pin decision order is ADR 0009's:
 * re-injected kinds produce nothing, the principal's own kind is quoted, everything else is one
 * reference line, and the caps and the adaptive budget degrade a pin to a marker rather than
 * truncating it.
 *
 * @param {FoldNodeContext} ctx
 * @returns {string[]}
 */
function pinnedSections(ctx) {
  const recall = texts.foldRecallPointer(ctx.task === null ? null : ctx.task.id, ctx.fold)
  const budget = Math.floor(ctx.spanTokens / 2) - ctx.nodeTokens
  let pinTokens = 0
  /** @type {string[]} */
  const verbatim = []
  /** @type {string[]} */
  const references = []
  for (const node of ctx.inbound) {
    if (REINJECTED_KINDS.has(node.kind)) continue
    if (node.kind === 'user') {
      const text = sanitizeFoldText(node.text, 'pin')
      if (text === '') continue
      const pin = texts.renderVerbatimPin(text.split('\n'))
      if (text.length <= MAX_PIN_CHARS && fits(pin, budget, pinTokens, ctx)) {
        verbatim.push(pin)
        pinTokens += ctx.estimator.text(pin)
        continue
      }
      references.push(texts.renderFoldPinMarker(node.kind, node.seq, node.text.length, recall))
      continue
    }
    const reference = texts.renderFoldReference(node.kind, node.seq, recall)
    if (fits(reference, budget, pinTokens, ctx)) {
      references.push(reference)
      pinTokens += ctx.estimator.text(reference)
      continue
    }
    references.push(texts.renderFoldPinMarker(node.kind, node.seq, node.text.length, recall))
  }
  /** @type {string[]} */
  const sections = []
  const quoted = fitSection(verbatim, texts.FOLD_VERBATIM_HEADING, recall)
  if (quoted.length > 0) sections.push([texts.FOLD_VERBATIM_HEADING, ...quoted].join('\n'))
  const named = fitSection(references, texts.FOLD_REFERENCE_HEADING, recall)
  if (named.length > 0) sections.push([texts.FOLD_REFERENCE_HEADING, ...named].join('\n'))
  return sections
}

/**
 * Whether one more pin fits the adaptive budget: the remaining budget must both hold the pin and
 * stay above the floor at which a quote is honest.
 *
 * @param {string} pin
 * @param {number} budget
 * @param {number} spent
 * @param {FoldNodeContext} ctx
 */
function fits(pin, budget, spent, ctx) {
  const remaining = budget - spent
  return remaining >= MIN_PIN_TOKENS && ctx.estimator.text(pin) <= remaining
}

/**
 * Keep one section within `MAX_SECTION_CHARS`: the excess lines become one counted elision line,
 * never a silent cut. The per-node cap is applied before a line reaches here. The elision line is
 * reserved for before the fit test, so the section does not grow past the cap it is enforcing.
 *
 * @param {string[]} lines
 * @param {string} heading
 * @param {string} recall
 * @returns {string[]}
 */
function fitSection(lines, heading, recall) {
  if (lines.length === 0) return lines
  const limit = MAX_SECTION_CHARS - heading.length - 1
  let chars = 0
  for (const line of lines) chars += line.length + 1
  if (chars <= limit) return lines
  const reserve = texts.renderFoldElision(lines.length, recall).length + 1
  /** @type {string[]} */
  const kept = []
  let used = 0
  let dropped = 0
  for (const line of lines) {
    if (used + line.length + 1 > limit - reserve) {
      dropped += 1
      continue
    }
    kept.push(line)
    used += line.length + 1
  }
  kept.push(texts.renderFoldElision(dropped, recall))
  return kept
}
