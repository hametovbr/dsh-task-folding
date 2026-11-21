// Snapshot replay of the live M5 sessions (test/fixtures/logs/m5-*.jsonl): a delegate fold that
// committed from a background generation, and the durable failure cap that stopped a task after
// three failed generations.

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, initialState, isEndMeta } from '../host/projection.js'
import { analyzeJournal, judgeJournal } from '../scripts/verify-cache.js'
import { journalEvents, readJournalText } from '../scripts/journal.js'
import { M2_LOGS } from './fixtures/journals.js'

/** @typedef {import('../host/types.js').SessionEvent} SessionEvent */
/** @typedef {import('../host/types.js').State} State */

const readLog = (/** @type {string} */ name) => journalEvents(readJournalText(join(M2_LOGS, name)))

/** @param {readonly SessionEvent[]} events @param {State} [from] */
function replay(events, from = initialState()) {
  return events.reduce(apply, from)
}

test('a delegate fold commits and keeps the provider cache', () => {
  const events = readLog('m5-delegate-fold.jsonl')
  const state = replay(events)
  const task = state.tasks.T1
  assert.ok(task)
  assert.equal(task.status, 'folded')
  assert.equal(task.foldIndex, 0)
  assert.equal(state.folds.length, 1)
  assert.equal(state.folds[0]?.taskId, 'T1')

  // The summary came from a generation, not from the model's own task_end text: the node the model
  // sees must be the delegate text, and it must carry the provider usage the host recorded.
  const summary = events.find((event) => event.type === 'compaction/summary')
  assert.ok(summary)
  assert.equal(summary.data.llmStreamCall, undefined, 'the plugin fold is unmarked by design')
  assert.ok(summary.data.usage, 'and reports what the provider charged')

  const analysis = analyzeJournal(events, 'm5-delegate-fold.jsonl')
  const verdict = judgeJournal(analysis, 0.8)
  assert.equal(verdict.ok, true, 'the delegate fold meets the cache floor and the median tolerance')
  assert.equal(verdict.checked, 1)
  assert.ok((analysis.summaries[0]?.usage?.cacheReadTokens ?? 0) > 0)
})

test('the durable failure cap turns a task failed after three attempts', () => {
  const events = readLog('m5-failure-cap.jsonl')
  const state = replay(events)
  assert.equal(state.tasks.T1?.status, 'failed')
  assert.equal(state.tasks.T1?.failures, 3)
  const attempts = events.filter(
    (event) =>
      event.type === 'compaction/end' && event.data?.error !== undefined && event.data?.error !== null,
  )
  assert.equal(attempts.length, 3, 'each failed generation left one durable closed attempt')
  const starts = events.filter((event) => event.type === 'compaction/start')
  assert.equal(starts.length, 3)
  // A failed attempt is not a fold: no replacement node and no fold row.
  assert.equal(state.folds.length, 0)
  for (const event of events)
    assert.ok(
      !(event.type === 'user/message' && event.surfaceOp && typeof event.surfaceOp === 'object'),
      'nothing replaced the surface',
    )
})

test('every task_end meta in the M5 journals is still a shape the reducer accepts', () => {
  for (const name of ['m5-delegate-fold.jsonl', 'm5-failure-cap.jsonl']) {
    for (const event of readLog(name)) {
      const meta = event.type === 'tool/result' ? event.data?.meta : undefined
      if (meta === undefined || typeof meta !== 'object' || meta === null) continue
      const candidate = /** @type {Record<string, unknown>} */ (meta)
      if (candidate.tf !== 1 || candidate.op !== 'end') continue
      assert.ok(isEndMeta(candidate), `${name}: seq ${event.seq}`)
    }
  }
})
