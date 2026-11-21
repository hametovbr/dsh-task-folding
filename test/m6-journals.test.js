// Snapshot replay of the live M6 hint session (test/fixtures/logs/m6-hints.jsonl): one stale-task
// hint per bucket, published once and latched durably across restarts.

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { maybeHint } from '../host/prompt/hints.js'
import { apply, initialState } from '../host/domain/projection.js'
import { readSettings } from '../host/domain/settings.js'
import { journalEvents, readJournalText } from '../scripts/journal.js'
import { M2_LOGS } from './fixtures/journals.js'

/** @typedef {import('../host/domain/types.js').SessionEvent} SessionEvent */
/** @typedef {import('../host/domain/types.js').State} State */

const events = journalEvents(readJournalText(join(M2_LOGS, 'm6-hints.jsonl')))
/** @param {readonly SessionEvent[]} list @param {State} [from] */
const replay = (list, from = initialState()) => list.reduce(apply, from)

test('the live hint session published one hint per bucket and latched on the last one', () => {
  const state = replay(events)
  const hints = events.filter(
    (event) => event.type === 'user/message' && event.data?.source?.kind === 'task-folding:hint',
  )
  assert.deepEqual(
    hints.map((event) => event.data.source.key),
    ['T1:5', 'T1:10'],
    'the 5-step bucket fired once, then the 10-step bucket',
  )
  assert.equal(state.hintKey, 'T1:10', 'the projection latched the last key durably')
  assert.equal(state.open.length, 1, 'the task was never closed in this session')
  const text = hints[0]?.data.content?.[0]?.text ?? ''
  assert.match(text, /^Task T1 "long running" has been open for 5\+ steps\./)
})

test('the latch suppresses a repeat of the same bucket after a restart', () => {
  // The profile in the live session used `staleTaskSteps: 5`; the resulting 5/10/20 buckets are
  // what the projection state must now suppress.
  const settings = readSettings({ staleTaskSteps: 5 })
  const state = replay(events)
  assert.equal(maybeHint(state, settings), null, 'nothing new at the latched key')

  // With `staleTaskSteps: 5` the buckets are 5, 10 and 20. Age counts from the task's own opening,
  // so the boundaries are derived from it instead of assumed.
  const openedAt = state.tasks.T1?.openedAt ?? 0
  const insideLatched = { ...state, assistantCount: openedAt + 15 }
  assert.equal(maybeHint(insideLatched, settings), null, 'age 15 is inside the latched 10 bucket')
  const nextBucket = { ...state, assistantCount: openedAt + 25 }
  assert.equal(maybeHint(nextBucket, settings)?.key, 'T1:20', 'the 20 bucket is publishable again')
})
