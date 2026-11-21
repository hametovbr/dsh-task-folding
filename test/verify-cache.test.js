// Tests for scripts/verify-cache.js: the cache-hit comparison over the real M3 journals and over
// synthetic sessions, plus the CLI's exit codes and --json shape. The analysis is a pure export,
// so most cases are asserted directly; the CLI gets a small smoke test.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  analyzeJournal,
  cacheHitRatio,
  judgeJournal,
  MEDIAN_TOLERANCE,
  parseArgs,
} from '../scripts/verify-cache.js'
import { journalEvents, readJournalText } from '../scripts/journal.js'
import { M2_LOGS } from './fixtures/journals.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(ROOT, 'scripts', 'verify-cache.js')

/** @param {string} name */
const readLog = (name) => journalEvents(readJournalText(join(M2_LOGS, name)))

/**
 * @param {number | null} actual
 * @param {number} expected
 * @param {string} message
 */
function closeTo(actual, expected, message) {
  assert.equal(typeof actual, 'number', `${message}: measured`)
  const value = /** @type {number} */ (actual)
  assert.ok(Math.abs(value - expected) < 1e-9, `${message}: ${value} ≈ ${expected}`)
}

/**
 * @param {number} cacheReadTokens
 * @param {number} inputTokens
 */
function usageOf(cacheReadTokens, inputTokens) {
  return {
    inputTokens,
    outputTokens: 100,
    cacheReadTokens,
    cacheWriteTokens: 0,
    totalTokens: cacheReadTokens + inputTokens + 100,
  }
}

/** @param {number} seq @param {number} cacheReadTokens @param {number} inputTokens */
function mainEvent(seq, cacheReadTokens, inputTokens) {
  return { type: 'assistant/message', seq, data: { usage: usageOf(cacheReadTokens, inputTokens) } }
}

/** @param {number} seq @param {number} cacheReadTokens @param {number} inputTokens */
function delegateSummary(seq, cacheReadTokens, inputTokens) {
  return {
    type: 'compaction/summary',
    seq,
    data: {
      compactionId: `c${seq}`,
      summary: [{ type: 'text', text: '## Synthetic\nbody' }],
      shadowedRange: { start: seq - 1, end: seq },
      shadowedSeqs: [seq - 1],
      shadowedTokenCount: 3000,
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      llmStreamCall: true,
      usage: usageOf(cacheReadTokens, inputTokens),
    },
  }
}

/** @param {number} seq */
function unmeasuredDelegateSummary(seq) {
  return {
    type: 'compaction/summary',
    seq,
    data: {
      compactionId: `u${seq}`,
      summary: [{ type: 'text', text: '## Synthetic\nbody' }],
      shadowedTokenCount: 900,
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      llmStreamCall: true,
    },
  }
}

/** @param {number} seq */
function selfSummary(seq) {
  return {
    type: 'compaction/summary',
    seq,
    data: {
      compactionId: `s${seq}`,
      summary: [{ type: 'text', text: '## Synthetic\nbody' }],
      shadowedRange: { start: seq - 1, end: seq },
      shadowedSeqs: [seq - 1],
      shadowedTokenCount: 2000,
      provider: 'deepseek-official',
      model: 'deepseek-flash',
    },
  }
}

/** Four main requests at 99.0/99.0/98.0/98.0 %, median 98.5 %. */
function mainRequests() {
  return [mainEvent(2, 9900, 100), mainEvent(4, 9900, 100), mainEvent(6, 9800, 200), mainEvent(8, 9800, 200)]
}

/**
 * @param {string} dir
 * @param {string} name
 * @param {readonly object[]} events
 */
function writeJournal(dir, name, events) {
  const lines = [JSON.stringify({ type: 'session', version: 4, id: `session-${name}`, cwd: '~/work' })]
  for (const event of events) lines.push(JSON.stringify(event))
  const path = join(dir, name)
  writeFileSync(path, `${lines.join('\n')}\n`)
  return path
}

test('the ratio divides cache reads by the whole prompt', () => {
  assert.equal(cacheHitRatio({ inputTokens: 100, cacheReadTokens: 900 }), 0.9)
  // No cache field means the adapter reported no cache use.
  assert.equal(cacheHitRatio({ inputTokens: 100 }), 0)
  // No prompt count leaves nothing to measure, and neither does an empty prompt.
  assert.equal(cacheHitRatio({ cacheReadTokens: 900 }), null)
  assert.equal(cacheHitRatio({ inputTokens: 0, cacheReadTokens: 0 }), null)
  assert.equal(cacheHitRatio(null), null)
})

test('the real LLM checkpoint reports its cache ratio and the session benchmark', () => {
  const analysis = analyzeJournal(readLog('m3-realm-compaction.jsonl'), 'realm')
  assert.equal(analysis.summaries.length, 1)
  const row = analysis.summaries[0]
  assert.ok(row)
  assert.equal(row.seq, 61)
  assert.equal(row.source, 'delegate')
  assert.equal(row.llmStreamCall, true)
  assert.equal(row.provider, 'deepseek-official')
  assert.equal(row.model, 'deepseek-flash')
  assert.equal(row.shadowedTokenCount, 18782)
  assert.ok(row.usage)
  assert.equal(row.usage.cacheReadTokens, 25088)
  assert.equal(row.usage.inputTokens, 466)
  closeTo(row.usage.cacheHitRatio, 25088 / (25088 + 466), 'checkpoint ratio')

  // The session's own main requests: the last is 24,960 cache-read / 216 fresh (99.1 %); the
  // median sits between the two middle calls.
  assert.equal(analysis.mainRequests.count, 6)
  closeTo(analysis.mainRequests.minRatio, 10880 / (10880 + 12824), 'main min')
  closeTo(
    analysis.mainRequests.medianRatio,
    (10752 / (10752 + 152) + 24960 / (24960 + 216)) / 2,
    'main median',
  )

  const verdict = judgeJournal(analysis, 0.8)
  assert.equal(verdict.ok, true)
  assert.equal(verdict.checked, 1)
  assert.equal(verdict.missingUsage, 0)
  assert.equal(verdict.failures.length, 0)
})

test('a self fold is reported but never counted against the ratio', () => {
  const analysis = analyzeJournal(readLog('m3-single-fold.jsonl'), 'single')
  assert.equal(analysis.summaries.length, 1)
  const row = analysis.summaries[0]
  assert.ok(row)
  assert.equal(row.seq, 42)
  assert.equal(row.source, 'self')
  assert.equal(row.llmStreamCall, false)
  assert.equal(row.usage, null)
  assert.equal(analysis.mainRequests.count, 4)
  closeTo(
    analysis.mainRequests.medianRatio,
    (10880 / (10880 + 6417) + 10752 / (10752 + 138)) / 2,
    'main median',
  )
  // No threshold, however strict, fails a session whose only summary made no LLM call.
  const verdict = judgeJournal(analysis, 1)
  assert.equal(verdict.ok, true)
  assert.equal(verdict.checked, 0)
  assert.equal(verdict.failures.length, 0)
})

test('an LLM-backed summary without usage is reported missing, not failed', () => {
  const analysis = analyzeJournal([...mainRequests(), unmeasuredDelegateSummary(10)], 'unmeasured')
  const verdict = judgeJournal(analysis, 0.8)
  assert.equal(verdict.missingUsage, 1)
  assert.equal(verdict.checked, 0)
  assert.equal(verdict.ok, true)
})

test('an LLM-backed summary below the floor fails', () => {
  const analysis = analyzeJournal([...mainRequests(), delegateSummary(10, 7000, 3000)], 'floor')
  const verdict = judgeJournal(analysis, 0.8)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.failures.length, 1)
  const failure = verdict.failures[0]
  assert.ok(failure)
  assert.equal(failure.seq, 10)
  assert.equal(failure.belowFloor, true)
  assert.equal(failure.belowMedian, true)
})

test('an LLM-backed summary above the floor but far below the main requests fails too', () => {
  const analysis = analyzeJournal([...mainRequests(), delegateSummary(10, 8500, 1500)], 'median')
  const verdict = judgeJournal(analysis, 0.8)
  assert.equal(verdict.ok, false)
  const failure = verdict.failures[0]
  assert.ok(failure)
  assert.equal(failure.belowFloor, false)
  assert.equal(failure.belowMedian, true)
  closeTo(failure.deltaPoints, -13.5, 'delta points')
  assert.ok(
    (failure.deltaPoints ?? 0) < -MEDIAN_TOLERANCE * 100,
    'the gap exceeds the tolerance in percentage points',
  )
})

test('an LLM-backed summary that matches the main requests passes; a self fold beside it is ignored', () => {
  const analysis = analyzeJournal(
    [...mainRequests(), delegateSummary(10, 9900, 100), selfSummary(12)],
    'match',
  )
  assert.equal(analysis.summaries.length, 2)
  const verdict = judgeJournal(analysis, 0.8)
  assert.equal(verdict.ok, true)
  assert.equal(verdict.checked, 1)
  assert.equal(verdict.failures.length, 0)
  closeTo(verdict.medianRatio, 0.985, 'session median')
  closeTo(verdict.worstRatio, 0.99, 'worst summary')
})

test('the CLI passes the real M3 fixtures and reports the self fold', () => {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, join(M2_LOGS, 'm3-realm-compaction.jsonl'), join(M2_LOGS, 'm3-single-fold.jsonl')],
    { encoding: 'utf8' },
  )
  assert.equal(result.status, 0)
  assert.match(result.stdout, /delegate/)
  assert.match(result.stdout, /98\.2%/)
  assert.match(result.stdout, /self fold \(no LLM call\)/)
  assert.match(result.stdout, /— ok/)
})

test('the CLI compares summaries with the main requests and exits 1 when they trail', () => {
  mkdirSync(join(ROOT, '.tmp'), { recursive: true })
  const dir = mkdtempSync(join(ROOT, '.tmp', 'verify-cache-'))
  try {
    const worse = writeJournal(dir, 'worse.jsonl', [...mainRequests(), delegateSummary(10, 8500, 1500)])
    const closer = writeJournal(dir, 'closer.jsonl', [...mainRequests(), delegateSummary(10, 9900, 100)])

    const failed = spawnSync(process.execPath, [SCRIPT, worse], { encoding: 'utf8' })
    assert.equal(failed.status, 1)
    // Both numbers are printed, so the comparison is auditable.
    assert.match(failed.stdout, /85\.0%/)
    assert.match(failed.stdout, /98\.5%/)
    assert.match(failed.stdout, /FAIL/)
    assert.match(failed.stderr, /cache check failed/)

    const passed = spawnSync(process.execPath, [SCRIPT, closer], { encoding: 'utf8' })
    assert.equal(passed.status, 0)
    assert.match(passed.stdout, /99\.0%/)
    assert.match(passed.stdout, /— ok/)

    const asJson = spawnSync(process.execPath, [SCRIPT, closer, '--json'], { encoding: 'utf8' })
    assert.equal(asJson.status, 0)
    const report = JSON.parse(asJson.stdout)
    assert.equal(report.minRatio, 0.8)
    assert.equal(report.medianTolerance, MEDIAN_TOLERANCE)
    assert.equal(report.ok, true)
    assert.equal(report.journals.length, 1)
    const block = report.journals[0]
    assert.equal(block.journal, closer)
    assert.equal(block.summaries.length, 1)
    assert.equal(block.summaries[0].source, 'delegate')
    assert.equal(block.summaries[0].llmStreamCall, true)
    assert.equal(block.mainRequests.count, 4)
    assert.equal(block.verdict.ok, true)

    const failedJson = spawnSync(process.execPath, [SCRIPT, worse, '--json'], { encoding: 'utf8' })
    assert.equal(failedJson.status, 1)
    const bad = JSON.parse(failedJson.stdout)
    assert.equal(bad.ok, false)
    assert.equal(bad.journals[0].verdict.failures[0].belowFloor, false)
    assert.equal(bad.journals[0].verdict.failures[0].belowMedian, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the CLI refuses a bad threshold and a missing journal', () => {
  const badRatio = spawnSync(
    process.execPath,
    [SCRIPT, join(M2_LOGS, 'm3-single-fold.jsonl'), '--min-ratio', '2'],
    { encoding: 'utf8' },
  )
  assert.equal(badRatio.status, 2)
  assert.match(badRatio.stderr, /--min-ratio/)

  const missing = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /at least one journal/)
})

test('the argument parser accepts both threshold spellings', () => {
  assert.deepEqual(parseArgs(['a.jsonl', '--min-ratio', '0.9', '--json']), {
    files: ['a.jsonl'],
    minRatio: 0.9,
    json: true,
    help: false,
  })
  assert.equal(parseArgs(['a.jsonl', '--min-ratio=0.5']).minRatio, 0.5)
})

test('a delegate fold is recognised by its usage even when the host did not mark it', () => {
  // This plugin's delegate fold hands prepared blocks to the host, so the summary is unmarked
  // (docs/adr/0004) — but it still reports the provider usage, which is what makes it auditable.
  const events = [
    { seq: 1, type: 'assistant/message', data: { usage: { inputTokens: 100, cacheReadTokens: 900 } } },
    {
      seq: 2,
      type: 'compaction/summary',
      data: {
        provider: 'p',
        model: 'm',
        shadowedTokenCount: 5000,
        usage: { inputTokens: 50, cacheReadTokens: 950 },
      },
    },
    {
      seq: 3,
      type: 'compaction/summary',
      data: { provider: 'p', model: 'm', shadowedTokenCount: 4000 },
    },
  ]
  const analysis = analyzeJournal(events, 'synthetic.jsonl')
  const [delegate, self] = analysis.summaries
  assert.equal(delegate?.source, 'delegate', 'usage alone marks an LLM-backed summary')
  assert.equal(delegate?.llmStreamCall, false, 'the marker itself is absent, as designed')
  assert.equal(self?.source, 'self', 'no marker and no usage is a self fold')
  const verdict = judgeJournal(analysis, 0.8)
  assert.equal(verdict.ok, true, 'the delegate fold counts toward the cache check')
  assert.equal(verdict.checked, 1, 'exactly one LLM-backed summary was checked')
})
