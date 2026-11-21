// Tests for scripts/eval-report.js: the docs/06 §5.3 metrics over synthetic journals (built here
// because the metric definitions are the thing under test) and over the real M5 delegate fold,
// plus the CLI's label=path handling and exit codes.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { analyzeSession, analyzeSuite, formatSuite, parseArgs } from '../scripts/eval-report.js'
import { journalEvents, readJournalText } from '../scripts/journal.js'
import { M2_LOGS } from './fixtures/journals.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(ROOT, 'scripts', 'eval-report.js')

/** @param {string} name */
const readLog = (name) => journalEvents(readJournalText(join(M2_LOGS, name)))

/**
 * @param {number | null} actual
 * @param {number} expected
 * @param {string} message
 */
function closeTo(actual, expected, message) {
  assert.equal(typeof actual, 'number', `${message}: measured`)
  assert.ok(Math.abs(/** @type {number} */ (actual) - expected) < 1e-9, `${message}: ${actual} ≈ ${expected}`)
}

// ---------------------------------------------------------------------------
// Synthetic journals

/**
 * @param {number} inputTokens
 * @param {number} cacheReadTokens
 * @param {number} outputTokens
 * @returns {any}
 */
function usage(inputTokens, cacheReadTokens, outputTokens) {
  return {
    inputTokens,
    cacheReadTokens,
    outputTokens,
    cacheWriteTokens: 0,
    totalTokens: inputTokens + cacheReadTokens + outputTokens,
  }
}

/**
 * @param {{ id: string, name: string, args?: Record<string, unknown> }} call
 * @returns {any}
 */
function callBlock(call) {
  return { type: 'tool-call', id: call.id, name: call.name, arguments: JSON.stringify(call.args ?? {}) }
}

/**
 * @param {number} seq
 * @param {number} time
 * @param {{ id: string, name: string, args?: Record<string, unknown> }[]} calls
 * @param {any} [usageValue]
 * @returns {any}
 */
function assistant(seq, time, calls, usageValue) {
  /** @type {any} */
  const data = {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: calls.map(callBlock) },
  }
  if (usageValue !== undefined) data.usage = usageValue
  return { type: 'assistant/message', seq, time, data }
}

/**
 * @param {number} seq
 * @param {number} time
 * @param {string} callId
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @returns {any}
 */
function toolCall(seq, time, callId, name, args) {
  return {
    type: 'tool/call',
    seq,
    time,
    data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) },
  }
}

/**
 * @param {number} seq
 * @param {number} time
 * @param {string} callId
 * @param {{ meta?: any, isError?: boolean, text?: string }} [options]
 * @returns {any}
 */
function toolResult(seq, time, callId, options = {}) {
  /** @type {any} */
  const data = {
    turn: 1,
    step: 1,
    message: {
      role: 'tool',
      source: { kind: 'tool', callId },
      toolCallId: callId,
      content: [{ type: 'text', text: options.text ?? 'ok' }],
      isError: options.isError === true,
      id: `result-${seq}`,
    },
  }
  if (options.meta !== undefined) data.meta = options.meta
  return { type: 'tool/result', seq, time, data, sourceEventSeqs: [], surfaceOp: 'append' }
}

/** @param {string} id @returns {any} */
function beginMeta(id) {
  return { tf: 1, op: 'begin', id, title: `task ${id}`, parent: null }
}

/** @param {string} id @param {string} callId @returns {any} */
function endMeta(id, callId) {
  return {
    tf: 1,
    op: 'end',
    id,
    merged: [],
    verdict: 'queued',
    outcome: 'done',
    estTokens: 1200,
    summaryChars: 20,
    callId,
  }
}

/**
 * A session that exercises every metric: one folded task, a self fold and a delegate fold, reads
 * before and after the first fold, five recall calls, and one rejected task_end.
 *
 * Seqs 0-22 are turn 1 (task T1 opened, two files read, T1 closed); 23-60 are turn 2 (the self
 * fold of T1 at seq 26, rereads, recall, a rejected call and the delegate summary at seq 58).
 *
 * @returns {any[]}
 */
function syntheticSession() {
  return [
    { type: 'permission/preset', seq: 0, time: 1000, data: { preset: 'workspace-write' } },
    { type: 'turn/start', seq: 1, time: 1001, data: { turn: 1 } },
    { type: 'step/start', seq: 2, time: 1002, data: { turn: 1, step: 1 } },
    {
      type: 'system/message',
      seq: 3,
      time: 1003,
      data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'system' }] } },
    },
    {
      type: 'user/message',
      seq: 4,
      time: 1004,
      data: { content: [{ type: 'text', text: 'do the thing' }], role: 'user' },
    },
    {
      type: 'request/header',
      seq: 5,
      time: 1005,
      data: { header: { config: { provider: 'p', model: 'm' }, tools: [] }, reason: 'initial' },
    },
    assistant(6, 1010, [{ id: 'c1', name: 'task_begin', args: { title: 'task one' } }], usage(100, 900, 50)),
    toolCall(7, 1011, 'c1', 'task_begin', { title: 'task one' }),
    toolResult(8, 1012, 'c1', { meta: beginMeta('T1') }),
    { type: 'step/end', seq: 9, time: 1013, data: { turn: 1, step: 1 } },
    { type: 'step/start', seq: 10, time: 1020, data: { turn: 1, step: 2 } },
    assistant(
      11,
      1021,
      [
        { id: 'c2', name: 'read', args: { file_path: './a.md' } },
        { id: 'c3', name: 'read', args: { file_path: 'b.md' } },
      ],
      usage(200, 800, 60),
    ),
    toolCall(12, 1022, 'c2', 'read', { file_path: './a.md' }),
    toolCall(13, 1023, 'c3', 'read', { file_path: 'b.md' }),
    toolResult(14, 1024, 'c2'),
    toolResult(15, 1025, 'c3'),
    { type: 'step/end', seq: 16, time: 1026, data: { turn: 1, step: 2 } },
    { type: 'step/start', seq: 17, time: 1030, data: { turn: 1, step: 3 } },
    assistant(18, 1031, [{ id: 'c4', name: 'task_end', args: { summary: 'done' } }]),
    toolCall(19, 1032, 'c4', 'task_end', { summary: 'done' }),
    toolResult(20, 1033, 'c4', { meta: endMeta('T1', 'c4') }),
    { type: 'step/end', seq: 21, time: 1034, data: { turn: 1, step: 3 } },
    { type: 'turn/end', seq: 22, time: 1040, data: { turn: 1 } },

    { type: 'turn/start', seq: 23, time: 2000, data: { turn: 2 } },
    { type: 'step/start', seq: 24, time: 2001, data: { turn: 2, step: 4 } },
    { type: 'compaction/start', seq: 25, time: 2010, data: { compactionId: 'cp1', turn: 2 } },
    {
      type: 'compaction/summary',
      seq: 26,
      time: 2011,
      data: {
        compactionId: 'cp1',
        summary: [{ type: 'text', text: 'x'.repeat(400) }],
        shadowedRange: { start: 11, end: 20 },
        shadowedSeqs: [11, 14, 15, 18, 20],
        shadowedTokenCount: 1000,
        provider: 'p',
        model: 'm',
      },
    },
    {
      type: 'user/message',
      seq: 27,
      time: 2012,
      data: { content: [{ type: 'text', text: '[summary]' }], role: 'user' },
      sourceEventSeqs: [11, 14, 15, 18, 20],
      surfaceOp: { op: 'replace', startSeq: 11, endSeq: 20 },
    },
    { type: 'compaction/end', seq: 28, time: 2013, data: { compactionId: 'cp1', turn: 2 } },
    { type: 'step/end', seq: 29, time: 2014, data: { turn: 2, step: 4 } },
    { type: 'step/start', seq: 30, time: 2020, data: { turn: 2, step: 5 } },
    assistant(
      31,
      2021,
      [
        { id: 'c5', name: 'read', args: { file_path: './a.md' } },
        { id: 'c6', name: 'read', args: { file_path: 'c.md' } },
        { id: 'c7', name: 'read', args: { file_path: 'b.md' } },
      ],
      usage(300, 700, 70),
    ),
    toolCall(32, 2022, 'c5', 'read', { file_path: './a.md' }),
    toolCall(33, 2023, 'c6', 'read', { file_path: 'c.md' }),
    toolCall(34, 2024, 'c7', 'read', { file_path: 'b.md' }),
    toolResult(35, 2025, 'c5'),
    toolResult(36, 2026, 'c6'),
    toolResult(37, 2027, 'c7'),
    { type: 'step/end', seq: 38, time: 2028, data: { turn: 2, step: 5 } },
    { type: 'step/start', seq: 39, time: 2030, data: { turn: 2, step: 6 } },
    assistant(40, 2031, [
      { id: 'c8', name: 'fold_recall', args: {} },
      { id: 'c9', name: 'fold_recall', args: { task: 'T1', grep: 'ledger' } },
      { id: 'c10', name: 'fold_recall', args: { task: 'T1', from: 1, to: 2 } },
      { id: 'c11', name: 'fold_range', args: { task: 'T1' } },
      { id: 'c12', name: 'fold_grep', args: { grep: 'x' } },
    ]),
    toolCall(41, 2032, 'c8', 'fold_recall', {}),
    toolCall(42, 2033, 'c9', 'fold_recall', { task: 'T1', grep: 'ledger' }),
    toolCall(43, 2034, 'c10', 'fold_recall', { task: 'T1', from: 1, to: 2 }),
    toolCall(44, 2035, 'c11', 'fold_range', { task: 'T1' }),
    toolCall(45, 2036, 'c12', 'fold_grep', { grep: 'x' }),
    toolResult(46, 2037, 'c8'),
    toolResult(47, 2038, 'c9'),
    toolResult(48, 2039, 'c10'),
    toolResult(49, 2040, 'c11'),
    toolResult(50, 2041, 'c12'),
    { type: 'step/end', seq: 51, time: 2042, data: { turn: 2, step: 6 } },
    { type: 'step/start', seq: 52, time: 2043, data: { turn: 2, step: 7 } },
    assistant(53, 2044, [{ id: 'c13', name: 'task_end', args: {} }]),
    toolCall(54, 2045, 'c13', 'task_end', {}),
    toolResult(55, 2046, 'c13', { isError: true, text: 'Error: task_end failed: no open task' }),
    { type: 'step/end', seq: 56, time: 2047, data: { turn: 2, step: 7 } },
    { type: 'compaction/start', seq: 57, time: 3000, data: { compactionId: 'cp2', turn: 2 } },
    {
      type: 'compaction/summary',
      seq: 58,
      time: 3001,
      data: {
        compactionId: 'cp2',
        summary: [{ type: 'text', text: 'y'.repeat(200) }],
        shadowedRange: { start: 41, end: 50 },
        shadowedSeqs: [41, 50],
        shadowedTokenCount: 500,
        provider: 'p',
        model: 'm',
        usage: usage(50, 950, 100),
      },
    },
    { type: 'compaction/end', seq: 59, time: 3002, data: { compactionId: 'cp2', turn: 2 } },
    { type: 'turn/end', seq: 60, time: 3003, data: { turn: 2 } },
  ]
}

/**
 * A journal with a read call but no usage, no fold, no step and no timestamps: every metric that
 * needs those must be null, never zero.
 *
 * @returns {any[]}
 */
function minimalSession() {
  return [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'hi' }], role: 'user' } },
    assistant(2, 0, [{ id: 'c1', name: 'read', args: { file_path: 'a.md' } }]),
    toolCall(3, 0, 'c1', 'read', { file_path: 'a.md' }),
    toolResult(4, 0, 'c1'),
  ].map((event) => {
    // The synthetic timestamps above are irrelevant here: strip them so wall clock is unsupported.
    const withoutTime = { ...event }
    delete withoutTime.time
    return withoutTime
  })
}

/**
 * @param {string} dir
 * @param {string} name
 * @param {readonly any[]} events
 */
function writeJournal(dir, name, events) {
  const lines = [JSON.stringify({ type: 'session', version: 4, id: `session-${name}`, cwd: '~/work' })]
  for (const event of events) lines.push(JSON.stringify(event))
  const path = join(dir, name)
  writeFileSync(path, `${lines.join('\n')}\n`)
  return path
}

// ---------------------------------------------------------------------------
// Metrics

test('a self fold and a delegate fold are told apart, and the summary size is an estimate', () => {
  const report = analyzeSession(syntheticSession(), { label: 'synthetic' })
  assert.equal(report.label, 'synthetic')
  assert.equal(report.folds.count, 2)
  assert.equal(report.folds.self, 1)
  assert.equal(report.folds.delegate, 1)
  assert.deepEqual(report.folds.verdicts, { folded: 1 })

  const [selfFold, delegateFold] = report.folds.rows
  assert.ok(selfFold && delegateFold)
  assert.equal(selfFold.seq, 26)
  assert.equal(selfFold.kind, 'self', 'a summary without usage made no LLM request')
  assert.equal(selfFold.usage, null)
  assert.equal(selfFold.taskId, 'T1', 'the projection matched the replacement to the task span')
  assert.equal(selfFold.shadowedSeqs, 5)
  assert.equal(selfFold.shadowedTokens, 1000)
  assert.equal(selfFold.summaryChars, 400)
  closeTo(selfFold.summaryEstimateTokens, 100, 'charCount / 4')
  closeTo(selfFold.summaryToSpanRatio, 0.1, 'summary / span')
  assert.match(selfFold.source, /data\.usage/)
  assert.match(selfFold.source, /charCount/)

  assert.equal(delegateFold.seq, 58)
  assert.equal(delegateFold.kind, 'delegate', 'usage marks an LLM-backed (delegate) fold')
  assert.equal(delegateFold.taskId, null, 'the second summary was never committed to a span')
  assert.ok(delegateFold.usage)
  assert.equal(delegateFold.usage.requests, 1)
  assert.equal(delegateFold.usage.cacheReadTokens, 950)
  assert.equal(delegateFold.usage.inputTokens, 50)
  assert.equal(delegateFold.usage.outputTokens, 100)
  assert.equal(delegateFold.usage.totalTokens, 1100)
  closeTo(delegateFold.usage.cacheHitShare, 0.95, 'delegate cache-hit share')
  assert.equal(delegateFold.shadowedTokens, 500)
  assert.equal(delegateFold.summaryChars, 200)
  closeTo(delegateFold.summaryToSpanRatio, 0.1, 'delegate summary / span')
})

test('billed tokens split main and fold requests and compute the cache-hit share', () => {
  const report = analyzeSession(syntheticSession(), { label: 'synthetic' })
  assert.ok(report.billed)
  const { main, fold } = report.billed
  assert.ok(main && fold)
  assert.equal(main.requests, 3, 'three assistant messages carried usage')
  assert.equal(main.cacheReadTokens, 900 + 800 + 700)
  assert.equal(main.inputTokens, 100 + 200 + 300)
  assert.equal(main.outputTokens, 50 + 60 + 70)
  assert.equal(main.totalTokens, 1050 + 1060 + 1070)
  assert.equal(main.promptTokens, 3000)
  closeTo(main.cacheHitShare, 2400 / 3000, 'main cache-hit share')
  // A self fold is not a request, so only the delegate summary counts here.
  assert.equal(fold.requests, 1)
  assert.equal(fold.cacheReadTokens, 950)
  assert.equal(fold.inputTokens, 50)
  assert.equal(fold.outputTokens, 100)
  assert.equal(fold.totalTokens, 1100)
  closeTo(fold.cacheHitShare, 950 / 1000, 'fold cache-hit share')
  assert.match(report.billed.source, /assistant\/message\.data\.usage/)
  assert.match(report.billed.source, /compaction\/summary\.data\.usage/)
})

test('context, prompt, steps, turns and wall clock come from the log fields', () => {
  const report = analyzeSession(syntheticSession(), { label: 'synthetic' })
  assert.ok(report.context)
  assert.equal(report.context.requests, 3)
  assert.equal(report.context.peakTokens, 1000)
  closeTo(report.context.meanTokens, 1000, 'mean context')
  // request/header carried no token count, so the usage-derived size is the only source.
  assert.match(report.context.source, /cacheReadTokens \+ inputTokens/)
  assert.match(report.context.source, /request\/header/)

  assert.ok(report.prompt)
  assert.equal(report.prompt.tokens, 1000)
  assert.match(report.prompt.source, /cacheReadTokens \+ inputTokens/)

  assert.ok(report.steps)
  assert.equal(report.steps.count, 7)
  assert.ok(report.turns)
  assert.equal(report.turns.count, 2)
  assert.ok(report.wallClockMs)
  assert.equal(report.wallClockMs.ms, 3003 - 1000)
  assert.match(report.wallClockMs.source, /event\.time/)
})

test('a read after the first fold of a previously read path is a reread; a first read is not', () => {
  const report = analyzeSession(syntheticSession(), { label: 'synthetic' })
  assert.ok(report.rereads)
  assert.equal(report.rereads.count, 2, 'a.md and b.md were read before the fold and again after it')
  assert.equal(report.rereads.boundarySeq, 26)
  assert.deepEqual(
    report.rereads.rows.map((row) => [row.path, row.firstReadSeq]),
    [
      ['a.md', 12],
      ['b.md', 13],
    ],
    'the leading "./" is stripped, so a.md matches across both spellings',
  )
  assert.ok(
    !report.rereads.rows.some((row) => row.path === 'c.md'),
    'c.md was first read after the fold, so it is not a reread',
  )
  assert.match(report.rereads.source, /first compaction\/summary/)
})

test('recall calls count by mode and per fold', () => {
  const report = analyzeSession(syntheticSession(), { label: 'synthetic' })
  assert.equal(report.recall.calls, 5)
  assert.deepEqual(report.recall.byKind, { recall: 1, range: 2, grep: 2 })
  closeTo(report.recall.perFold, 5 / 2, 'recall calls per fold')
  assert.match(report.recall.source, /fold_recall/)
  assert.match(report.recall.source, /perFold|per fold/i)
})

test('a rejected call of one of our tools is counted; other tools are not', () => {
  const events = syntheticSession()
  // A rejected bash call must not count even though its result is an error.
  events.push(assistant(61, 3100, [{ id: 'c14', name: 'bash', args: { command: 'false' } }]))
  events.push(toolCall(62, 3101, 'c14', 'bash', { command: 'false' }))
  events.push(toolResult(63, 3102, 'c14', { isError: true, text: 'exit code: 1' }))
  const report = analyzeSession(events, { label: 'synthetic' })
  assert.equal(report.rejectedCalls.count, 1)
  assert.deepEqual(report.rejectedCalls.rows, [{ seq: 55, tool: 'task_end', toolCallId: 'c13' }])
  assert.match(report.rejectedCalls.source, /isError/)
})

test('a metric the log cannot support is null with a why, never zero', () => {
  const report = analyzeSession(minimalSession(), { label: 'minimal' })
  assert.equal(report.billed, null)
  assert.match(report.why.billed ?? '', /data\.usage/)
  assert.equal(report.context, null)
  assert.match(report.why.context ?? '', /data\.usage/)
  assert.equal(report.prompt, null)
  assert.match(report.why.prompt ?? '', /data\.usage/)
  assert.equal(report.rereads, null, 'no fold means no boundary for a reread')
  assert.match(report.why.rereads ?? '', /no fold/)
  assert.equal(report.steps, null)
  assert.match(report.why.steps ?? '', /step\/start/)
  assert.equal(report.wallClockMs, null)
  assert.match(report.why.wallClockMs ?? '', /event\.time/)
  // Counts over a scan are real facts and stay numeric.
  assert.equal(report.folds.count, 0)
  assert.deepEqual(report.folds.verdicts, {})
  assert.equal(report.recall.calls, 0)
  assert.equal(report.recall.perFold, null)
  assert.match(report.recall.why.perFold ?? '', /no fold/)
  assert.ok(report.turns)
  assert.equal(report.turns.count, 1)
  assert.equal(report.rejectedCalls.count, 0)
})

test('every supported metric names the field it came from', () => {
  const report = analyzeSession(syntheticSession(), { label: 'synthetic' })
  /** @type {[string, any][]} */
  const metrics = [
    ['billed', report.billed],
    ['context', report.context],
    ['folds', report.folds],
    ['recall', report.recall],
    ['rereads', report.rereads],
    ['rejectedCalls', report.rejectedCalls],
    ['steps', report.steps],
    ['turns', report.turns],
    ['wallClockMs', report.wallClockMs],
    ['prompt', report.prompt],
  ]
  for (const [name, metric] of metrics) {
    assert.ok(metric, `${name} is measured on this journal`)
    assert.equal(typeof metric.source, 'string', `${name}.source`)
    assert.ok(metric.source.length > 0, `${name}.source is not empty`)
  }
  for (const fold of report.folds.rows) assert.equal(typeof fold.source, 'string')
})

// ---------------------------------------------------------------------------
// Suite and report

test('the suite aggregates sessions per configuration and keeps nulls', () => {
  const suite = analyzeSuite([
    { events: syntheticSession(), label: 'a.jsonl', configuration: 'C' },
    { events: syntheticSession(), label: 'b.jsonl', configuration: 'C' },
    { events: minimalSession(), label: 'c.jsonl', configuration: 'D' },
  ])
  assert.equal(suite.sessions.length, 3)
  assert.equal(suite.sessions[0]?.configuration, 'C')
  assert.equal(suite.sessions[2]?.configuration, 'D')
  const [c, d] = suite.aggregate.perConfiguration
  assert.ok(c && d)
  assert.equal(c.configuration, 'C')
  assert.equal(c.sessionCount, 2)
  assert.deepEqual(c.labels, ['a.jsonl', 'b.jsonl'])
  assert.ok(c.billed?.main)
  assert.equal(c.billed.main.requests, 6)
  assert.equal(c.billed.main.totalTokens, 6360)
  closeTo(c.billed.main.cacheHitShare, 0.8, 'aggregate cache-hit share')
  assert.equal(c.folds.count, 4)
  assert.equal(c.folds.self, 2)
  assert.equal(c.folds.delegate, 2)
  assert.deepEqual(c.folds.verdicts, { folded: 2 })
  assert.equal(c.recall.calls, 10)
  closeTo(c.recall.perFold, 10 / 4, 'aggregate recall per fold')
  assert.ok(c.rereads)
  assert.equal(c.rereads.count, 4)
  assert.equal(c.rejectedCalls.count, 2)
  assert.ok(c.steps)
  assert.equal(c.steps.total, 14)
  assert.equal(c.steps.median, 7)
  assert.ok(c.wallClockMs)
  assert.equal(c.wallClockMs.total, 2 * 2003)
  assert.equal(c.wallClockMs.median, 2003)
  assert.ok(c.prompt)
  assert.equal(c.prompt.tokens, 1000)

  assert.equal(d.configuration, 'D')
  assert.equal(d.billed, null)
  assert.equal(d.context, null)
  assert.equal(d.rereads, null)
  assert.match(d.why.rereads ?? '', /no session/)
})

test('the markdown report states the method and shows one table per configuration plus an aggregate row', () => {
  const suite = analyzeSuite([
    { events: syntheticSession(), label: 'a.jsonl', configuration: 'C' },
    { events: minimalSession(), label: 'b.jsonl', configuration: 'D' },
  ])
  const markdown = formatSuite(suite)
  assert.match(markdown, /^# Evaluation report/m)
  assert.match(markdown, /## Method/)
  assert.match(markdown, /\| Metric \| Value \| Source \|/)
  assert.match(markdown, /## Configuration C/)
  assert.match(markdown, /## Configuration D/)
  assert.match(markdown, /### Folds/)
  assert.match(markdown, /## Aggregate/)
  assert.match(markdown, /\| Configuration \| Sessions \|/)
  // Unsupported metrics are visible as such, and nothing leaks into the text as undefined.
  assert.match(markdown, /n\/a \(/)
  assert.doesNotMatch(markdown, /undefined|NaN/)
  // The method statement names each non-obvious derivation.
  assert.match(markdown, /charact(er|ters) count of the summary text divided by 4/)
  assert.match(markdown, /host\/domain\/projection\.js/)
  assert.match(markdown, /no number is invented/)
})

// ---------------------------------------------------------------------------
// The real M5 journal

test('the real M5 delegate fold is reported with its usage and the session totals', () => {
  const events = readLog('m5-delegate-fold.jsonl')
  const report = analyzeSession(events, { label: 'm5-delegate-fold' })
  assert.equal(report.folds.count, 1)
  assert.deepEqual(report.folds.verdicts, { folded: 1 })
  const fold = report.folds.rows[0]
  assert.ok(fold)
  assert.equal(fold.kind, 'delegate', 'the plugin delegate fold is unmarked but reports usage')
  assert.equal(fold.taskId, 'T1')
  assert.equal(fold.shadowedTokens, 12950)
  assert.ok(fold.usage)
  assert.equal(fold.usage.cacheReadTokens, 22912)
  assert.equal(fold.usage.inputTokens, 218)
  assert.equal(fold.usage.outputTokens, 441)
  assert.equal(fold.usage.totalTokens, 23571)
  closeTo(fold.usage.cacheHitShare, 22912 / (22912 + 218), 'fold cache-hit share')

  // The summary node size is the estimate, derived from the recorded summary text.
  const summary = events.find((event) => event.type === 'compaction/summary')
  assert.ok(summary)
  const blocks = /** @type {any[]} */ (summary.data?.summary ?? [])
  const text = blocks.map((block) => block.text ?? '').join('')
  assert.equal(fold.summaryChars, text.length)
  closeTo(fold.summaryEstimateTokens, text.length / 4, 'estimate')
  closeTo(fold.summaryToSpanRatio, text.length / 4 / 12950, 'summary / span')

  assert.ok(report.billed)
  assert.ok(report.billed.main)
  assert.equal(report.billed.main.requests, 29)
  assert.equal(report.billed.main.cacheReadTokens, 1139968)
  assert.equal(report.billed.main.inputTokens, 106497)
  assert.equal(report.billed.main.outputTokens, 3281)
  assert.equal(report.billed.main.totalTokens, 1249746)
  assert.ok(report.billed.fold)
  assert.equal(report.billed.fold.requests, 1)
  assert.equal(report.billed.fold.totalTokens, 23571)

  assert.ok(report.context)
  assert.equal(report.context.peakTokens, 62290)
  closeTo(report.context.meanTokens, 42981.55172413793, 'mean context over the 29 requests')
  assert.ok(report.prompt)
  assert.equal(report.prompt.tokens, 10820)
  assert.ok(report.steps)
  assert.equal(report.steps.count, 29)
  assert.ok(report.turns)
  assert.equal(report.turns.count, 11)
  assert.ok(report.wallClockMs)
  assert.equal(report.wallClockMs.ms, 650595)

  assert.equal(report.recall.calls, 1)
  assert.deepEqual(report.recall.byKind, { recall: 1, range: 0, grep: 0 })
  assert.equal(report.recall.perFold, 1)
  assert.ok(report.rereads)
  assert.equal(report.rereads.count, 1)
  assert.equal(report.rereads.rows[0]?.path, 'ledger.md')
  assert.equal(report.rejectedCalls.count, 0)
})

// ---------------------------------------------------------------------------
// CLI

test('the CLI reads journals, names configurations with label=path, and prints markdown or JSON', () => {
  mkdirSync(join(ROOT, '.tmp'), { recursive: true })
  const dir = mkdtempSync(join(ROOT, '.tmp', 'eval-report-'))
  try {
    const journal = writeJournal(dir, 'self-fold.jsonl', syntheticSession())

    const markdown = spawnSync(process.execPath, [SCRIPT, journal], { encoding: 'utf8' })
    assert.equal(markdown.status, 0)
    assert.match(markdown.stdout, /## Configuration self-fold — 1 session/)
    assert.match(markdown.stdout, /## Aggregate/)
    assert.match(markdown.stdout, /delegate/)

    const labelled = spawnSync(process.execPath, [SCRIPT, `C=${journal}`, '--json'], { encoding: 'utf8' })
    assert.equal(labelled.status, 0)
    const suite = JSON.parse(labelled.stdout)
    assert.equal(suite.sessions.length, 1)
    assert.equal(suite.sessions[0].label, 'self-fold')
    assert.equal(suite.sessions[0].configuration, 'C')
    assert.equal(suite.aggregate.perConfiguration[0].configuration, 'C')
    assert.equal(suite.aggregate.perConfiguration[0].billed.main.requests, 3)
    assert.equal(suite.sessions[0].folds.rows.length, 2)
    assert.equal(suite.sessions[0].folds.rows[1].kind, 'delegate')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the CLI exits 0 for readable journals and 2 for a missing one or bad arguments', () => {
  mkdirSync(join(ROOT, '.tmp'), { recursive: true })
  const dir = mkdtempSync(join(ROOT, '.tmp', 'eval-report-'))
  try {
    const journal = writeJournal(dir, 'minimal.jsonl', minimalSession())
    const missing = spawnSync(process.execPath, [SCRIPT, join(dir, 'missing.jsonl')], { encoding: 'utf8' })
    assert.equal(missing.status, 2)
    assert.match(missing.stderr, /cannot read/)
    assert.match(missing.stderr, /usage:/)

    const none = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
    assert.equal(none.status, 2)
    assert.match(none.stderr, /at least one journal/)

    const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' })
    assert.equal(help.status, 0)
    assert.match(help.stdout, /usage: node scripts\/eval-report\.js/)

    // A journal with nothing to measure still reports (nulls), it does not fail.
    const empty = spawnSync(process.execPath, [SCRIPT, journal], { encoding: 'utf8' })
    assert.equal(empty.status, 0)
    assert.match(empty.stdout, /n\/a \(/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the argument parser splits label=path only when the left side is a label', () => {
  assert.deepEqual(parseArgs(['C=a.jsonl', '--json']), {
    journals: [{ configuration: 'C', path: 'a.jsonl', label: 'a' }],
    json: true,
    help: false,
  })
  // A path that itself contains "=" before a slash stays whole.
  assert.deepEqual(parseArgs(['dir/a=b.jsonl']).journals[0], {
    configuration: 'a=b',
    path: 'dir/a=b.jsonl',
    label: 'a=b',
  })
  assert.deepEqual(parseArgs(['x=dir/a.jsonl']).journals[0], {
    configuration: 'x',
    path: 'dir/a.jsonl',
    label: 'a',
  })
  assert.throws(() => parseArgs(['--json']), /at least one journal/)
  assert.throws(() => parseArgs(['--nope', 'a.jsonl']), /unknown option/)
})
