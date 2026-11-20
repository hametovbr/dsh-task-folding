// Snapshot replay of the live M2 sessions (test/fixtures/logs/): the real host wrote these
// journals, so they pin the meta shapes, the batch pairing and the cut arithmetic that the
// live acceptance in m2/REPORT.md relied on.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply, initialState, isBeginMeta, isEndMeta, parseState, view } from '../host/projection.js'
import { journalEvents, readJournalText } from '../scripts/journal.js'
import { M2_LOGS } from './fixtures/journals.js'
import { join } from 'node:path'

/** @typedef {import('../host/types.js').SessionEvent} SessionEvent */
/** @typedef {import('../host/types.js').State} State */

/** Decoding happens through the same reader the replay script uses. */
const readLog = (/** @type {string} */ name) => journalEvents(readJournalText(join(M2_LOGS, name)))

/** @param {readonly SessionEvent[]} events @param {State} [from] */
function replay(events, from = initialState()) {
  return events.reduce(apply, from)
}

/** @type {Record<string, { order: string[], open: string[], nextId: number, tasks: Record<string, any> }>} */
const EXPECTED = {
  'm2-nested-relay.jsonl': {
    order: ['T1', 'T2', 'T3'],
    open: [],
    nextId: 4,
    tasks: {
      T1: {
        title: 'outer',
        parent: null,
        depth: 0,
        status: 'below-floor',
        verdict: 'below-floor',
        estTokens: 1999,
        summaryChars: 1277,
      },
      T2: {
        title: 'inner',
        parent: 'T1',
        depth: 1,
        status: 'below-floor',
        verdict: 'below-floor',
        estTokens: 655,
        summaryChars: 827,
      },
      T3: {
        title: 'sibling',
        parent: 'T1',
        depth: 1,
        status: 'below-floor',
        verdict: 'below-floor',
        estTokens: 724,
        summaryChars: 972,
      },
    },
  },
  'm2-merged-resume.jsonl': {
    order: ['T1', 'T2', 'T3'],
    open: [],
    nextId: 4,
    tasks: {
      T1: {
        title: 'parent',
        parent: null,
        depth: 0,
        status: 'queued',
        verdict: 'queued',
        estTokens: 14164,
        summaryChars: 1173,
      },
      T2: {
        title: 'child',
        parent: 'T1',
        depth: 1,
        status: 'merged',
        verdict: null,
        estTokens: -1,
        summaryChars: 0,
      },
      T3: {
        title: 'after restart',
        parent: null,
        depth: 0,
        status: 'queued',
        verdict: 'queued',
        estTokens: 6598,
        summaryChars: 799,
      },
    },
  },
  'm2-config-override.jsonl': {
    order: ['T1'],
    open: [],
    nextId: 2,
    tasks: {
      T1: {
        title: 'config probe',
        parent: null,
        depth: 0,
        status: 'delegate',
        verdict: 'delegate',
        estTokens: 362,
        summaryChars: 872,
      },
    },
  },
}

test('the live M2 journals replay to their recorded state', () => {
  assert.deepEqual(Object.keys(EXPECTED).sort(), readLogNames())
  for (const [name, expected] of Object.entries(EXPECTED)) {
    const state = replay(readLog(name))
    assert.deepEqual(state.order, expected.order, `${name}: task order`)
    assert.deepEqual(state.open, expected.open, `${name}: nothing is left open`)
    assert.equal(state.nextId, expected.nextId, `${name}: next id`)
    for (const [id, fields] of Object.entries(expected.tasks)) {
      const task = state.tasks[id]
      assert.ok(task, `${name}: ${id} exists`)
      const row = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (task))
      for (const [field, value] of Object.entries(fields))
        assert.equal(row[field], value, `${name}: ${id}.${field}`)
      assert.ok(['opening', 'closing'].includes(task.status) === false, `${name}: ${id} is settled`)
    }
    // Nothing is left waiting for a replacement.
    assert.equal(state.pendingSummary, null, `${name}: no pending summary`)
  }
})

test('every task-mark meta in the live journals is a shape the reducer accepts', () => {
  for (const name of readLogNames()) {
    let begins = 0
    let ends = 0
    for (const event of readLog(name)) {
      const meta = event.type === 'tool/result' ? event.data?.meta : undefined
      // Other tools write their own meta; only a `tf: 1` payload claims to be ours.
      if (!isRecord(meta) || meta.tf !== 1) continue
      assert.ok(
        isBeginMeta(meta) || isEndMeta(meta),
        `${name}: seq ${event.seq} carries unknown meta ${JSON.stringify(meta)}`,
      )
      if (isBeginMeta(meta)) begins += 1
      if (isEndMeta(meta)) ends += 1
    }
    // Every begun task becomes a row; a task closed implicitly by its parent has no end meta.
    const state = replay(readLog(name))
    assert.ok(begins > 0, `${name}: at least one task_begin meta`)
    assert.equal(begins, state.order.length, `${name}: one row per task_begin meta`)
    assert.ok(ends <= begins, `${name}: no end without a begin`)
    assert.equal(
      ends,
      state.order.filter((id) => state.tasks[id]?.verdict !== null).length,
      `${name}: one end meta per task that was closed on its own`,
    )
  }
})

test('the relay in one message produced adjacent cuts', () => {
  const events = readLog('m2-nested-relay.jsonl')
  const state = replay(events)
  const inner = state.tasks.T2
  const sibling = state.tasks.T3
  assert.ok(inner && sibling)
  assert.equal(inner.endCut, sibling.beginCut, 'endCut(inner) == beginCut(sibling)')
  assert.ok(typeof inner.endCut === 'number')

  // The two calls really shared one assistant message: same batch, hence the same cut.
  const carried = callMessages(events)
  const messages = events
    .filter((event) => event.type === 'tool/result' && isRecord(event.data?.meta) && event.data.meta.tf === 1)
    .map((event) => {
      const meta = /** @type {any} */ (event.data?.meta)
      const callId = event.data?.message?.toolCallId
      return { op: meta.op, id: meta.id, message: carried.get(callId) }
    })
  const relayEnd = messages.find((m) => m.op === 'end' && m.id === 'T2')
  const relayBegin = messages.find((m) => m.op === 'begin' && m.id === 'T3')
  assert.ok(relayEnd && relayBegin, 'both relay calls are in the log')
  assert.equal(relayEnd.message, relayBegin.message, 'both calls shared one assistant message')
})

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The assistant/message seq that carried each call id.
 *
 * @param {readonly SessionEvent[]} events
 * @returns {Map<unknown, number | undefined>}
 */
function callMessages(events) {
  /** @type {Map<unknown, number | undefined>} */
  const byCall = new Map()
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    for (const block of event.data?.message?.content ?? []) {
      if (block?.type === 'tool-call') byCall.set(block.id, event.seq)
    }
  }
  return byCall
}

test('a task closed with its subtask open records the merge, not a second close', () => {
  const state = replay(readLog('m2-merged-resume.jsonl'))
  assert.equal(state.tasks.T1?.status, 'queued')
  assert.equal(state.tasks.T2?.status, 'merged')
  assert.equal(state.tasks.T2?.endMsgSeq, null, 'the merged child was never closed on its own')
  assert.deepEqual(state.tasks.T1?.verdict, 'queued')
})

test('a resumed session continues the id sequence and keeps earlier tasks', () => {
  const events = readLog('m2-merged-resume.jsonl')
  const state = replay(events)
  const firstThree = events.filter((event) => event.type === 'assistant/message').length
  assert.ok(firstThree > 0)
  // The third task was begun in a different process from the first two; its id continues.
  assert.deepEqual(state.order, ['T1', 'T2', 'T3'])
  const beginSeqs = events.filter((event) => event.data?.meta?.op === 'begin').map((event) => event.seq)
  assert.equal(beginSeqs.length, 3)
  assert.ok(
    /** @type {number} */ (beginSeqs[2]) > /** @type {number} */ (beginSeqs[1]),
    'task ids follow the log, not the process',
  )
})

test('the live journals resume from a checkpoint exactly like a full replay', () => {
  for (const name of readLogNames()) {
    const events = readLog(name)
    const full = replay(events)
    const step = Math.max(1, Math.floor(events.length / 12))
    for (const k of events.map((_, i) => i).filter((i) => i % step === 0)) {
      const checkpoint = parseState(JSON.parse(JSON.stringify(replay(events.slice(0, k)))))
      assert.deepEqual(replay(events.slice(k), checkpoint), full, `${name}: resume at ${k}`)
    }
  }
})

test('the wire view of a live session is derived, not stored', () => {
  const state = replay(readLog('m2-merged-resume.jsonl'))
  const wire = view(state)
  assert.deepEqual(wire.open, [])
  assert.equal(wire.folding.length, 2)
  assert.equal(wire.recent.length, 1)
  assert.equal(wire.recent[0]?.status, 'merged')
})

/** @returns {string[]} */
function readLogNames() {
  return Object.keys(EXPECTED).sort()
}
