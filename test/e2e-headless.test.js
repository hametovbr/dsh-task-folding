// Tests for scripts/e2e-headless.js (docs/09-testing-plan.md T5): the NDJSON turn stream, the
// journal inspection, and the check list, over the two sessions a live run recorded into
// test/fixtures/logs/e2e-headless-*.jsonl. A check that cannot fail proves nothing, so every
// required check is broken at least once here: the events are the host's real output, the
// mutations are the defects a release must catch.

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { analyzeSession } from '../scripts/eval-report.js'
import { inspectJournal, judge, parseNdjson, summarizeTurn } from '../scripts/e2e-headless.js'
import { journalEvents, readJournalText } from '../scripts/journal.js'
import { analyzeJournal, judgeJournal } from '../scripts/verify-cache.js'
import { M2_LOGS } from './fixtures/journals.js'

/** @typedef {import('../host/domain/types.js').SessionEvent} SessionEvent */

const SELF_LOG = 'e2e-headless-self.jsonl'
const DELEGATE_LOG = 'e2e-headless-delegate.jsonl'
/** The provider floor of docs/03 §12 invariant 9; scripts/e2e-headless.js uses the same value. */
const MIN_CACHE_RATIO = 0.8
const SETTINGS = { minSpanTokens: 2000 }

/**
 * @param {string} name
 * @returns {SessionEvent[]}
 */
function readLog(name) {
  return journalEvents(readJournalText(join(M2_LOGS, name)))
}

/**
 * A turn stream the scripted session is expected to produce. The live streams are model output, so
 * the checks are exercised against the shape rather than against one transcript.
 *
 * @param {string[]} names
 * @returns {ReturnType<typeof summarizeTurn>}
 */
function scriptedTurn(names) {
  return {
    sessionId: 'session-fixture',
    calls: names.map((name) => ({ name, args: '{}' })),
    text: '',
    kind: 'completed',
    completed: true,
  }
}

/**
 * Everything `judge` reads, assembled from one journal.
 *
 * @param {SessionEvent[]} events
 * @param {'self' | 'delegate'} scenario
 * @param {{ first?: ReturnType<typeof summarizeTurn>, recall?: ReturnType<typeof summarizeTurn> }} [turns]
 */
function evidence(events, scenario, turns = {}) {
  return {
    scenario,
    first: turns.first ?? scriptedTurn(['task_begin', 'read', 'read', 'task_end']),
    recall: turns.recall ?? scriptedTurn(['fold_recall']),
    journal: inspectJournal(events),
    cache: judgeJournal(analyzeJournal(events, 'fixture'), MIN_CACHE_RATIO),
    report: analyzeSession(events, { label: scenario }),
    settings: SETTINGS,
  }
}

/** @param {{ name: string, ok: boolean, detail: string }[]} checks @returns {string[]} */
function failed(checks) {
  return checks.filter((check) => !check.ok).map((check) => check.name)
}

/** @param {string} name @param {SessionEvent[]} events @param {'self' | 'delegate'} scenario */
function assertPasses(name, events, scenario) {
  const checks = judge(evidence(events, scenario))
  assert.deepEqual(
    failed(checks),
    [],
    `${name}: ${checks
      .filter((c) => !c.ok)
      .map((c) => `${c.name} (${c.detail})`)
      .join('; ')}`,
  )
  assert.ok(checks.length >= 20, `${name}: ${checks.length} checks`)
}

// ---------------------------------------------------------------------------
// The turn stream

test('parseNdjson keeps whole events and drops a torn last line', () => {
  const events = parseNdjson('{"type":"session","sessionId":"s"}\n\n{"type":"final"}\n{"type":"st')
  assert.equal(events.length, 2)
  assert.equal(events[0]?.type, 'session')
  assert.equal(events[1]?.type, 'final')
})

test('summarizeTurn reads the session, the calls and the completion', () => {
  const turn = summarizeTurn(
    [
      '{"type":"session","sessionId":"session-a"}',
      '{"type":"tool_call","tool":"task_begin","input":{"title":"x"}}',
      '{"type":"final","reason":{"kind":"completed"},"text":"done"}',
    ].join('\n'),
  )
  assert.equal(turn.sessionId, 'session-a')
  assert.deepEqual(turn.calls, [{ name: 'task_begin', args: '{"title":"x"}' }])
  assert.equal(turn.completed, true)
  assert.equal(turn.kind, 'completed')
})

test('summarizeTurn reports an errored turn as incomplete', () => {
  const turn = summarizeTurn(
    [
      '{"type":"session","sessionId":"session-b"}',
      '{"type":"final","reason":{"kind":"error"},"text":""}',
    ].join('\n'),
  )
  assert.equal(turn.completed, false)
  assert.equal(turn.kind, 'error')
})

// ---------------------------------------------------------------------------
// The journal

test('inspectJournal recovers the fold, the roster and the recalls of the recorded delegate session', () => {
  const journal = inspectJournal(readLog(DELEGATE_LOG))
  assert.equal(journal.verdict, 'delegate')
  for (const tool of ['task_begin', 'task_end', 'fold_recall']) assert.ok(journal.tools.includes(tool), tool)
  assert.ok(journal.systemText.includes('Task folding.'), 'the prompt section is in the system message')
  assert.equal(journal.state.folds.length, 1)
  const row = journal.state.folds[0]
  assert.ok(row !== undefined)
  assert.equal(row.taskId, 'T1')
  assert.ok(row.nodeSeq !== null)
  assert.equal(journal.summaries.length, 1)
  assert.equal(journal.summaries[0]?.source, 'delegate')
  assert.ok((journal.summaries[0]?.usage?.cacheReadTokens ?? 0) > 0, 'a delegate fold reports usage')
  assert.ok(journal.recalls.length >= 1, `${journal.recalls.length} recall call(s)`)
  assert.equal(journal.rejected.length, 0)
})

test('inspectJournal reads the recorded self session as a self fold', () => {
  const journal = inspectJournal(readLog(SELF_LOG))
  assert.equal(journal.verdict, 'queued')
  assert.equal(journal.summaries.length, 1)
  assert.equal(journal.summaries[0]?.source, 'self')
  assert.equal(journal.summaries[0]?.usage, null)
})

// ---------------------------------------------------------------------------
// The positive path

test('the recorded delegate session passes every check', () => {
  assertPasses('delegate', readLog(DELEGATE_LOG), 'delegate')
})

test('the recorded self session passes every check', () => {
  assertPasses('self', readLog(SELF_LOG), 'self')
})

test('the recorded delegate session keeps the cache-hit rate it was recorded with', () => {
  const cache = judgeJournal(analyzeJournal(readLog(DELEGATE_LOG), DELEGATE_LOG), MIN_CACHE_RATIO)
  assert.equal(cache.ok, true)
  assert.equal(cache.checked, 1)
  assert.ok((cache.worstRatio ?? 0) >= MIN_CACHE_RATIO)
})

// ---------------------------------------------------------------------------
// The negative path: every required check fails when its evidence is broken

/**
 * @param {SessionEvent[]} events
 * @param {(event: SessionEvent) => boolean} predicate
 * @returns {SessionEvent[]}
 */
const drop = (events, predicate) => events.filter((event) => !predicate(event))

/**
 * @param {SessionEvent[]} events
 * @returns {SessionEvent[]}
 */
const withoutReplacements = (events) =>
  events.filter((event) => {
    const op = event.surfaceOp
    return !(typeof op === 'object' && op !== null && op.op === 'replace')
  })

/** @param {SessionEvent[]} events */
const withoutSummaries = (events) => drop(events, (event) => event.type === 'compaction/summary')

/**
 * @param {SessionEvent[]} events
 * @returns {SessionEvent[]}
 */
function withLowCacheRead(events) {
  return events.map((event) => {
    if (event.type !== 'compaction/summary' || event.data?.usage === undefined) return event
    return { ...event, data: { ...event.data, usage: { ...event.data.usage, cacheReadTokens: 1 } } }
  })
}

/**
 * @param {SessionEvent[]} events
 * @returns {SessionEvent[]}
 */
function withoutSummaryUsage(events) {
  return events.map((event) => {
    if (event.type !== 'compaction/summary') return event
    const data = { ...event.data }
    delete data.usage
    return { ...event, data }
  })
}

/**
 * @param {SessionEvent[]} events
 * @param {string} verdict
 * @returns {SessionEvent[]}
 */
function withVerdict(events, verdict) {
  return events.map((event) => {
    if (event.type !== 'tool/result' || event.data?.meta?.op !== 'end') return event
    return { ...event, data: { ...event.data, meta: { ...event.data.meta, verdict } } }
  })
}

test('a fold without its replacement fails the span check', () => {
  const checks = judge(evidence(withoutReplacements(readLog(DELEGATE_LOG)), 'delegate'))
  assert.ok(
    failed(checks).includes('the replacement covers the task span exactly'),
    failed(checks).join('; '),
  )
})

test('a fold without its summary never reaches folded', () => {
  const checks = judge(evidence(withoutSummaries(readLog(DELEGATE_LOG)), 'delegate'))
  assert.ok(failed(checks).includes('the task ended folded'), failed(checks).join('; '))
})

test('a delegate fold without usage fails the source check', () => {
  const checks = judge(evidence(withoutSummaryUsage(readLog(DELEGATE_LOG)), 'delegate'))
  assert.ok(failed(checks).includes('the fold is a delegate fold'), failed(checks).join('; '))
})

test('a delegate fold that replays almost nothing fails the cache check', () => {
  const checks = judge(evidence(withLowCacheRead(readLog(DELEGATE_LOG)), 'delegate'))
  assert.ok(failed(checks).includes('the cache-hit check passes'), failed(checks).join('; '))
})

test('a task closed with the wrong verdict fails the config check', () => {
  const checks = judge(evidence(withVerdict(readLog(DELEGATE_LOG), 'queued'), 'delegate'))
  assert.ok(failed(checks).includes('the profile config reached the plugin'), failed(checks).join('; '))
})

test('a session without recall calls fails the recall check', () => {
  const events = drop(
    readLog(DELEGATE_LOG),
    (event) => event.type === 'tool/call' && event.data?.name === 'fold_recall',
  )
  const checks = judge(evidence(events, 'delegate'))
  assert.ok(failed(checks).includes('fold_recall returned the originals'), failed(checks).join('; '))
})

test('a turn that never closed the task fails the transcript checks', () => {
  const checks = judge(
    evidence(readLog(DELEGATE_LOG), 'delegate', { first: scriptedTurn(['task_begin', 'read']) }),
  )
  const names = failed(checks)
  assert.ok(names.includes('the model closed the task'), names.join('; '))
  assert.ok(names.includes('the model read 2 files inside the span'), names.join('; '))
})

test('a delegate fold judged as a self fold fails the source checks', () => {
  const checks = judge(evidence(readLog(DELEGATE_LOG), 'self'))
  const names = failed(checks)
  assert.ok(names.includes('the fold is a self fold'), names.join('; '))
  assert.ok(names.includes('the profile config reached the plugin'), names.join('; '))
})
