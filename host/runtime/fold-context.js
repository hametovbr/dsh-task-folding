// What a commit site reads from the region before it builds a fold node (ADR 0009): the inbound
// `user/message` nodes the region shadows, with the source kind the pin rules need. Reading the
// session is the commit site's job; this module only shapes that reading for
// `host/domain/fold-node.js`, so the three commit sites cannot disagree about what is inbound.

import { FOLD_UNKNOWN_KIND } from '../domain/texts.js'

/** @typedef {{ seq: number, kind: string, text: string }} InboundNode */

/**
 * The region's inbound user/message nodes, in surface order. The role gate is here: assistant text,
 * tool calls and tool results are what the summary is for, so they are never pin candidates.
 * Messages without textual content carry nothing to quote or reference and are skipped.
 *
 * @param {any} session a host session: `eventAt(seq)` and `deriveEventMessage(event)`
 * @param {readonly number[]} nodes the current surface node seqs
 * @param {number} startIndex first surface position of the region
 * @param {number} endIndex last surface position of the region, inclusive
 * @returns {InboundNode[]}
 */
export function inboundUserNodes(session, nodes, startIndex, endIndex) {
  /** @type {InboundNode[]} */
  const inbound = []
  for (let i = startIndex; i <= endIndex; i++) {
    const seq = nodes[i]
    if (seq === undefined) continue
    const event = session.eventAt(seq)
    if (!event || event.type !== 'user/message') continue
    const message = session.deriveEventMessage(event)
    const text = textOf(message)
    if (text === '') continue
    const source = message.source
    const kind = source && typeof source.kind === 'string' ? source.kind : FOLD_UNKNOWN_KIND
    inbound.push({ seq, kind, text })
  }
  return inbound
}

/**
 * The textual content of a derived message, trimmed. Non-text blocks (images, tool calls) have no
 * wording to pin; a user turn that carried only those yields nothing.
 *
 * @param {any} message
 * @returns {string}
 */
function textOf(message) {
  if (!message || !Array.isArray(message.content)) return ''
  /** @type {string[]} */
  const parts = []
  for (const block of message.content) {
    if (block && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}
