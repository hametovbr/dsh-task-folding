// The inbound read a commit site does before it builds a fold node (ADR 0009): which region nodes
// are user/message candidates, with the source kind the pin rules dispatch on.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { inboundUserNodes } from '../host/runtime/fold-context.js'

/** @typedef {any} Event */

/**
 * A session-like object: the event map and the host-shaped derivation of its message.
 *
 * @param {Map<number, Event>} events
 * @param {(event: Event) => any} [derive]
 */
function sessionOf(events, derive = (event) => event.message ?? event.data) {
  return {
    eventAt: (/** @type {number} */ seq) => events.get(seq),
    deriveEventMessage: derive,
  }
}

/** @param {Map<number, Event>} events @param {number} seq @param {Event} event */
function put(events, seq, event) {
  events.set(seq, { seq, ...event })
}

/** A `user/message` shaped event. @param {any[]} content @param {any} [source] */
function userEvent(content, source) {
  return { type: 'user/message', data: { role: 'user', content, source } }
}

test('the region yields its user/message nodes in surface order, with kind and text', () => {
  const events = new Map()
  put(events, 1, { type: 'system/message', data: { role: 'system', content: [{ type: 'text', text: 's' }] } })
  put(events, 2, userEvent([{ type: 'text', text: 'the request' }], { kind: 'user' }))
  put(events, 3, { type: 'assistant/message', data: { message: { role: 'assistant', content: [] } } })
  put(events, 4, userEvent([{ type: 'text', text: 'an advisor note' }], { kind: 'advisor:concern' }))
  const inbound = inboundUserNodes(sessionOf(events), [1, 2, 3, 4], 0, 3)
  assert.deepEqual(inbound, [
    { seq: 2, kind: 'user', text: 'the request' },
    { seq: 4, kind: 'advisor:concern', text: 'an advisor note' },
  ])
})

test('only the requested surface range is read', () => {
  const events = new Map()
  put(events, 1, userEvent([{ type: 'text', text: 'before' }], { kind: 'user' }))
  put(events, 2, { type: 'assistant/message', data: { message: { role: 'assistant', content: [] } } })
  put(events, 3, userEvent([{ type: 'text', text: 'inside' }], { kind: 'user' }))
  const inbound = inboundUserNodes(sessionOf(events), [1, 2, 3], 1, 2)
  assert.deepEqual(inbound, [{ seq: 3, kind: 'user', text: 'inside' }])
})

test('a missing surface seq or a missing event is skipped', () => {
  const events = new Map()
  put(events, 1, userEvent([{ type: 'text', text: 'kept' }], { kind: 'user' }))
  // Position 1 has no event and position 2 is past the end of the list; neither may throw.
  const inbound = inboundUserNodes(sessionOf(events), [1, 9], 0, 2)
  assert.deepEqual(inbound, [{ seq: 1, kind: 'user', text: 'kept' }])
})

test('a message the host cannot derive, or a text-less one, is skipped', () => {
  const events = new Map()
  put(events, 1, userEvent([{ type: 'text', text: 'lost in derivation' }], { kind: 'user' }))
  put(events, 2, userEvent([{ type: 'image', url: 'file://x.png' }], { kind: 'user' }))
  put(events, 3, userEvent([], { kind: 'user' }))
  const session = sessionOf(events, (event) => (event.seq === 1 ? null : event.data))
  assert.deepEqual(inboundUserNodes(session, [1, 2, 3], 0, 2), [])
})

test('several text blocks are joined, and the text is trimmed', () => {
  const events = new Map()
  put(
    events,
    1,
    userEvent(
      [
        { type: 'text', text: ' first part ' },
        { type: 'tool-call', name: 'read' },
        { type: 'text', text: 'second part' },
      ],
      { kind: 'user' },
    ),
  )
  const inbound = inboundUserNodes(sessionOf(events), [1], 0, 0)
  assert.deepEqual(inbound, [{ seq: 1, kind: 'user', text: 'first part \nsecond part' }])
})

test('a source that names no kind is reported as unknown', () => {
  const events = new Map()
  put(events, 1, userEvent([{ type: 'text', text: 'no source' }]))
  put(events, 2, userEvent([{ type: 'text', text: 'kindless source' }], {}))
  put(events, 3, userEvent([{ type: 'text', text: 'numeric kind' }], { kind: 7 }))
  const inbound = inboundUserNodes(sessionOf(events), [1, 2, 3], 0, 2)
  assert.deepEqual(
    inbound.map((node) => node.kind),
    ['unknown', 'unknown', 'unknown'],
  )
})
