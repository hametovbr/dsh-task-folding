// Snapshot replay of the live M3 sessions (test/fixtures/logs/m3-*.jsonl): the fold transaction,
// the nested/relay case, a realm compaction next to our own, and a single small fold.

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, initialState, isEndMeta, parseState } from '../host/projection.js'
import { journalEvents, readJournalText } from '../scripts/journal.js'
import { M2_LOGS } from './fixtures/journals.js'

/** @typedef {import('../host/types.js').SessionEvent} SessionEvent */
/** @typedef {import('../host/types.js').State} State */

const readLog = (/** @type {string} */ name) => journalEvents(readJournalText(join(M2_LOGS, name)))

/** @param {readonly SessionEvent[]} events @param {State} [from] */
function replay(events, from = initialState()) {
  return events.reduce(apply, from)
}

const EXPECTED = {
  'm3-fold-and-recall.jsonl': {
    tasks: { T1: { title: 'inspect data files', status: 'folded', foldIndex: 0, estTokens: 10965 } },
    folds: [{ summarySeq: 44, taskId: 'T1', shadowedCount: 5 }],
  },
  'm3-single-fold.jsonl': {
    tasks: { T1: { title: 'small one', status: 'folded', foldIndex: 0, estTokens: 6428 } },
    folds: [{ summarySeq: 42, taskId: 'T1', shadowedCount: 4 }],
  },
  'm3-nested-relay.jsonl': {
    tasks: {
      T1: { title: 'outer', status: 'below-floor', foldIndex: null, estTokens: 1859 },
      T2: { title: 'inner', status: 'folded', foldIndex: 0, estTokens: 12619 },
      T3: { title: 'sibling', status: 'folded', foldIndex: 1, estTokens: 7587 },
    },
    folds: [
      { summarySeq: 63, taskId: 'T2', shadowedCount: 8 },
      { summarySeq: 89, taskId: 'T3', shadowedCount: 6 },
    ],
  },
  'm3-realm-compaction.jsonl': {
    tasks: { T1: { title: 'both engines three', status: 'absorbed', foldIndex: null } },
    folds: [{ summarySeq: 61, taskId: null, shadowedCount: 16 }],
  },
}

test('the live M3 journals replay to their recorded state', () => {
  for (const [name, expected] of Object.entries(EXPECTED)) {
    const state = replay(readLog(name))
    for (const [id, fields] of Object.entries(expected.tasks)) {
      const task = state.tasks[id]
      assert.ok(task, `${name}: ${id} exists`)
      const row = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (task))
      for (const [field, value] of Object.entries(fields))
        assert.equal(row[field], value, `${name}: ${id}.${field}`)
    }
    assert.equal(state.folds.length, expected.folds.length, `${name}: fold rows`)
    expected.folds.forEach((fold, index) => {
      const row = state.folds[index]
      assert.ok(row)
      assert.equal(row.summarySeq, fold.summarySeq, `${name}: fold ${index} summary`)
      assert.equal(row.taskId, fold.taskId, `${name}: fold ${index} task`)
      assert.equal(row.shadowedCount, fold.shadowedCount, `${name}: fold ${index} size`)
      assert.equal(typeof row.nodeSeq, 'number', `${name}: fold ${index} replacement`)
    })
    assert.equal(state.pendingSummary, null, `${name}: nothing waits for a replacement`)
    assert.deepEqual(state.open, [], `${name}: no task is left open`)
  }
})

test('our fold and the realm checkpoint are distinguishable in the log', () => {
  const ours = readLog('m3-single-fold.jsonl')
  const realm = readLog('m3-realm-compaction.jsonl')
  const summaryOf = (/** @type {readonly SessionEvent[]} */ events) =>
    events.filter((event) => event.type === 'compaction/summary').map((event) => event.data)

  const selfFold = summaryOf(ours)
  const realmFold = summaryOf(realm)
  assert.equal(selfFold.length, 1)
  assert.equal(realmFold.length, 1)
  // A self fold is an unmarked result: it never identifies a ctx.llm.stream call.
  assert.equal(selfFold[0].llmStreamCall, undefined, 'our fold carries no LLM call identity')
  assert.equal(selfFold[0].usage, undefined, 'our fold reports no token usage')
  assert.equal(realmFold[0].llmStreamCall, true, 'the realm checkpoint came from the LLM seam')
  assert.ok(realmFold[0].usage, 'the realm checkpoint reports usage')
  for (const data of [...selfFold, ...realmFold]) {
    assert.equal(typeof data.provider, 'string')
    assert.equal(typeof data.model, 'string')
  }
})

test('a fold replaces exactly the task span and keeps the summary text', () => {
  const events = readLog('m3-fold-and-recall.jsonl')
  const state = replay(events)
  const task = state.tasks.T1
  assert.ok(task)
  const replacement = events.find(
    (event) => event.type === 'user/message' && event.surfaceOp && typeof event.surfaceOp === 'object',
  )
  assert.ok(replacement)
  const op = /** @type {{ startSeq: number, endSeq: number }} */ (
    /** @type {unknown} */ (replacement.surfaceOp)
  )
  assert.equal(op.startSeq, task.spanStart, 'the replacement starts at the task span start')
  assert.equal(op.endSeq, task.endCut, 'and ends at its end cut')
  const shadowed = /** @type {number[]} */ (
    events.find((event) => event.type === 'compaction/summary')?.data.shadowedSeqs ?? []
  )
  assert.ok(shadowed.length > 2, 'the whole span was shadowed, not just its edges')
  assert.equal(shadowed[0], task.spanStart, 'the first shadowed node opens the span')
  assert.equal(shadowed.at(-1), task.endCut, 'the last shadowed node closes it')

  const text = replacement.data.content.map((/** @type {any} */ block) => block.text ?? '').join('\n')
  assert.match(text, /# T1 · inspect data files/)
  assert.match(text, /— fold of T1 · \d+ messages · ~[\d.]+k tokens · outcome: done · originals: fold_recall/)
  // The model's own summary is inside, so the values it kept survive the fold.
  assert.ok(text.includes('PLAUSIBLE-KEY-7781'), 'the summary keeps the access key')
})

test('the nested session folded inner tasks and left the outer one under the floor', () => {
  const state = replay(readLog('m3-nested-relay.jsonl'))
  assert.equal(state.tasks.T2?.status, 'folded')
  assert.equal(state.tasks.T3?.status, 'folded')
  assert.equal(state.tasks.T1?.status, 'below-floor')
  assert.ok(
    /** @type {number} */ (state.tasks.T1?.spanStart) < /** @type {number} */ (state.tasks.T2?.spanStart),
    'the outer span starts first',
  )
  // The two inner folds are rows the recall path will list.
  assert.deepEqual(
    state.folds.map((row) => row.taskId),
    ['T2', 'T3'],
  )
})

test('the M3 journals resume from a checkpoint exactly like a full replay', () => {
  for (const name of Object.keys(EXPECTED)) {
    const events = readLog(name)
    const full = replay(events)
    const step = Math.max(1, Math.floor(events.length / 10))
    for (const k of events.map((_, i) => i).filter((i) => i % step === 0)) {
      const checkpoint = parseState(JSON.parse(JSON.stringify(replay(events.slice(0, k)))))
      assert.deepEqual(replay(events.slice(k), checkpoint), full, `${name}: resume at ${k}`)
    }
  }
})

test('every task_end meta in the M3 journals is still accepted by the reducer', () => {
  for (const name of Object.keys(EXPECTED)) {
    for (const event of readLog(name)) {
      const meta = event.type === 'tool/result' ? event.data?.meta : undefined
      if (meta === undefined || typeof meta !== 'object' || meta === null) continue
      const candidate = /** @type {Record<string, unknown>} */ (meta)
      if (candidate.tf !== 1 || candidate.op !== 'end') continue
      assert.ok(isEndMeta(candidate), `${name}: seq ${event.seq}`)
    }
  }
})
