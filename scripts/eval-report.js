#!/usr/bin/env node
// Turn a set of DeepSeek Harness session journals into the evaluation metrics table of
// docs/06-testing.md §5.3 (M7).
//
//   node scripts/eval-report.js [--json] [label=]<journal>...
//
// A journal may be written `label=path`, where the label names the configuration the session
// belongs to, so the journals of one configuration aggregate together. Without a label a journal
// forms its own configuration, named after its file.
//
// The analysis is pure over an event list (`analyzeSession`, `analyzeSuite`) so it is testable
// without files; the CLI only reads journals. Every metric names the log field it came from in a
// `source` string. A metric the log cannot support is null and the reason is in `why` — never a
// zero, and never an estimate unless the label says `estimate`.
//
// Read-only: the only host module imported is the pure projection, nothing is written and no
// network is touched.

import { pathToFileURL } from 'node:url'

import { apply, initialState } from '../host/domain/projection.js'
import { journalEvents, readJournalText } from './journal.js'

/** @typedef {import('../host/domain/types.js').SessionEvent} SessionEvent */
/** @typedef {import('../host/domain/types.js').State} State */

/** The summary node size estimate divides the summary's character count by this. */
export const SUMMARY_CHARS_PER_TOKEN = 4

/** Tools the evaluation counts as recall. The host tool is `fold_recall`; the others are aliases. */
const RECALL_TOOLS = new Set(['fold_recall', 'fold_range', 'fold_grep'])

/** Tools the plugin owns; a rejected call is an error result for one of these. */
const OUR_TOOLS = new Set(['task_begin', 'task_end', 'fold_recall'])

/** Tool names the host uses to read a file, newest first; the path is in `arguments.file_path`. */
const READ_TOOLS = new Set(['read', 'read_file', 'file_read'])

/** Path argument names a read call may carry, in order of preference. */
const READ_PATH_FIELDS = ['file_path', 'filePath', 'path', 'file', 'filename']

/**
 * Token fields a `request/header` event might carry in a future host build. The host types in
 * this repository (dsh-session `EpochHeader`: config, adapterDefaults, tools) have none, so the
 * preferred path is normally absent and the usage-derived fallback is used.
 */
const HEADER_TOKEN_FIELDS = ['promptTokens', 'promptTokenCount', 'contextTokens', 'tokenCount', 'tokens']

// Every metric's `source` names the field it was computed from, so a reader can audit the number.
const SOURCE = {
  billed:
    'assistant/message.data.usage (main requests) and compaction/summary.data.usage (fold requests); ' +
    'the host TokenUsage counts are disjoint, so cache-hit share = cacheReadTokens / (cacheReadTokens + inputTokens)',
  context:
    'assistant/message.data.usage: cacheReadTokens + inputTokens per main request (request/header in this ' +
    'host carries config, adapterDefaults and tools only, no token count)',
  foldsCount:
    'host/domain/projection.js apply() replay from initialState(): state.folds.length (one row per compaction/summary)',
  verdicts:
    'host/domain/projection.js apply() replay from initialState(): state.tasks[*].status over state.order',
  foldKind:
    'compaction/summary.data.usage presence: usage → delegate, no usage → self (the scripts/verify-cache.js rule)',
  shadowed:
    'compaction/summary.data.shadowedTokenCount (the host token meter) and compaction/summary.data.shadowedSeqs length',
  summaryEstimate:
    'charCount of the text blocks in compaction/summary.data.summary / 4 (estimate: the token meter is ' +
    'unavailable offline)',
  summaryRatio: 'summaryEstimateTokens / shadowedTokens',
  recall:
    'tool/call events named fold_recall, fold_range or fold_grep (an assistant/message tool-call block fills a ' +
    'missing call event; deduped by call id)',
  recallKind:
    'fold_recall arguments: grep → grep, from/to → range, neither → recall; fold_range and fold_grep map by name',
  recallPerFold: 'recall calls / folds count',
  rereads:
    'read tool calls (data.name "read") paired to their tool/result (data.message.toolCallId): a result after ' +
    'the first compaction/summary whose path was read before it; the path is trimmed and a leading "./" stripped',
  rejected:
    'tool/result rows with data.message.isError === true whose call (tool/call data.name) is task_begin, ' +
    'task_end or fold_recall',
  steps: 'count of step/start events',
  turns: 'count of turn/start events',
  wallClock: 'event.time: latest minus earliest (milliseconds since the epoch)',
  prompt:
    'first assistant/message.data.usage: cacheReadTokens + inputTokens (request/header has no token count in ' +
    'this host)',
}

// ---------------------------------------------------------------------------
// Session analysis

/**
 * Analyze one session journal. Pure over the event list: replaying the same events twice yields
 * the same report.
 *
 * @param {readonly SessionEvent[]} events the log, in order, without the session header
 * @param {{ label?: string }} [options]
 */
export function analyzeSession(events, options = {}) {
  const label = typeof options.label === 'string' && options.label !== '' ? options.label : 'session'
  const state = replay(events)
  const mainRows = usageRows(events, 'assistant/message')
  const foldUsageRows = usageRows(events, 'compaction/summary')
  const headerCounts = headerTokenCounts(events)
  /** @type {Record<string, string>} */
  const why = {}

  const main = mainRows.length === 0 ? null : sumUsage(mainRows)
  const fold = foldUsageRows.length === 0 ? null : sumUsage(foldUsageRows)
  const billed =
    main === null && fold === null
      ? null
      : {
          source: SOURCE.billed,
          main,
          fold,
          why: {
            ...(main === null ? { main: 'no assistant/message carried data.usage' } : {}),
            ...(fold === null
              ? { fold: 'no compaction/summary carried data.usage (a self fold makes no request by design)' }
              : {}),
          },
        }
  if (billed === null) why.billed = 'no assistant/message and no compaction/summary carried data.usage'

  const context = contextMetric(mainRows, headerCounts)
  if (context === null)
    why.context = 'no main request carried data.usage and no request/header gave a token count'

  const folds = foldsMetric(events, state)
  const calls = collectCalls(events)
  const recall = recallMetric(calls, folds.count)
  const readsAfterFold = rereadsMetric(events, calls, folds.rows)
  if (readsAfterFold === null)
    why.rereads = 'the journal has no fold (compaction/summary), so "after the first fold" has no boundary'
  const rejectedCalls = rejectedMetric(events, calls)

  const steps = stepsMetric(events)
  if (steps === null) why.steps = 'the journal has no step/start events'
  const turns = turnsMetric(events)
  if (turns === null) why.turns = 'the journal has no turn/start events'
  const wallClockMs = wallClockMetric(events)
  if (wallClockMs === null) why.wallClockMs = 'fewer than two events carry event.time'

  const prompt = promptMetric(mainRows, headerCounts)
  if (prompt === null) why.prompt = 'no request/header token count and no main request with data.usage'

  return {
    label,
    billed,
    context,
    folds,
    recall,
    rereads: readsAfterFold,
    rejectedCalls,
    steps,
    turns,
    wallClockMs,
    prompt,
    why,
    eventCount: events.length,
  }
}

/**
 * Aggregate analyzed sessions by configuration. `sessions` is the input of `analyzeSession`
 * plus the configuration the session belongs to.
 *
 * @param {readonly { events: readonly SessionEvent[], label?: string, configuration?: string }[]} sessions
 */
export function analyzeSuite(sessions) {
  const analyzed = sessions.map((session, index) => {
    const label =
      typeof session.label === 'string' && session.label !== '' ? session.label : `session-${index + 1}`
    return {
      ...analyzeSession(session.events, { label }),
      configuration:
        typeof session.configuration === 'string' && session.configuration !== ''
          ? session.configuration
          : 'default',
    }
  })
  /** @type {Map<string, (typeof analyzed)[number][]>} */
  const groups = new Map()
  for (const session of analyzed) {
    const group = groups.get(session.configuration)
    if (group) group.push(session)
    else groups.set(session.configuration, [session])
  }
  const perConfiguration = [...groups.entries()].map(([configuration, group]) =>
    aggregateConfiguration(configuration, group),
  )
  return { sessions: analyzed, aggregate: { perConfiguration } }
}

/**
 * @param {string} configuration
 * @param {readonly (ReturnType<typeof analyzeSession> & { configuration: string })[]} sessions
 */
function aggregateConfiguration(configuration, sessions) {
  const sessionCount = sessions.length
  const labels = sessions.map((session) => session.label)
  /** @type {Record<string, string>} */
  const why = {}

  const main = mergeBilledSides(sessions.map((session) => session.billed?.main ?? null))
  const fold = mergeBilledSides(sessions.map((session) => session.billed?.fold ?? null))
  const billed =
    main === null && fold === null
      ? null
      : {
          source: `${SOURCE.billed}. Summed over the configuration's sessions.`,
          main,
          fold,
          why: {
            ...(main === null
              ? { main: 'no session in this configuration recorded main-request usage' }
              : {}),
            ...(fold === null
              ? { fold: 'no session in this configuration recorded fold-request usage' }
              : {}),
          },
        }
  if (billed === null) why.billed = 'no session in this configuration recorded assistant or fold usage'

  const context = contextAggregate(sessions)
  if (context === null) why.context = 'no session in this configuration carried a context size'

  const folds = foldsAggregate(sessions)
  const recall = recallAggregate(sessions, folds.count)
  const rereads = rereadsAggregate(sessions)
  if (rereads === null)
    why.rereads = 'no session in this configuration has a fold, so there is no reread boundary'
  const rejectedCalls = {
    count: sum(sessions.map((session) => session.rejectedCalls.count)),
    source: `${SOURCE.rejected}. Summed over the configuration's sessions.`,
  }
  const steps = countAggregate(
    sessions.map((session) => session.steps?.count ?? null),
    SOURCE.steps,
  )
  if (steps === null) why.steps = 'no session in this configuration has step/start events'
  const turns = countAggregate(
    sessions.map((session) => session.turns?.count ?? null),
    SOURCE.turns,
  )
  if (turns === null) why.turns = 'no session in this configuration has turn/start events'
  const wallClockMs = countAggregate(
    sessions.map((session) => session.wallClockMs?.ms ?? null),
    SOURCE.wallClock,
  )
  if (wallClockMs === null) why.wallClockMs = 'no session in this configuration has event timestamps'
  const prompt = promptAggregate(sessions)
  if (prompt === null) why.prompt = 'no session in this configuration has a first-request prompt count'

  return {
    configuration,
    sessionCount,
    labels,
    billed,
    context,
    folds,
    recall,
    rereads,
    rejectedCalls,
    steps,
    turns,
    wallClockMs,
    prompt,
    why,
  }
}

/** @param {readonly SessionEvent[]} events */
function replay(events) {
  /** @type {State} */
  let state = initialState()
  for (const event of events) state = apply(state, event)
  return state
}

// ---------------------------------------------------------------------------
// Billed and context

/**
 * @typedef {object} BilledSide
 * @property {number} requests
 * @property {number | null} cacheReadTokens
 * @property {number | null} inputTokens
 * @property {number | null} outputTokens
 * @property {number | null} totalTokens
 * @property {number | null} promptTokens
 * @property {number | null} cacheHitShare
 */

/**
 * @param {readonly SessionEvent[]} events
 * @param {string} type
 * @returns {Record<string, unknown>[]}
 */
function usageRows(events, type) {
  /** @type {Record<string, unknown>[]} */
  const rows = []
  for (const event of events) {
    if (event.type !== type || !isRecord(event.data) || !isRecord(event.data.usage)) continue
    rows.push(event.data.usage)
  }
  return rows
}

/**
 * Sum one side's usage rows. A missing `cacheReadTokens` means the adapter reported no cache use
 * and counts as 0, matching `scripts/verify-cache.js`; a missing `inputTokens` leaves the prompt
 * unknown. The host's counts are disjoint, so the prompt is cache-read plus fresh input.
 *
 * @param {readonly Record<string, unknown>[]} rows
 * @returns {BilledSide}
 */
function sumUsage(rows) {
  let requests = 0
  let cacheRead = 0
  let input = 0
  let output = 0
  let total = 0
  let sawCacheRead = false
  let sawInput = false
  let sawOutput = false
  let sawTotal = false
  for (const row of rows) {
    requests += 1
    const cacheReadValue = finite(row.cacheReadTokens)
    if (cacheReadValue !== null) {
      sawCacheRead = true
      cacheRead += cacheReadValue
    }
    const inputValue = finite(row.inputTokens)
    if (inputValue !== null) {
      sawInput = true
      input += inputValue
    }
    const outputValue = finite(row.outputTokens)
    if (outputValue !== null) {
      sawOutput = true
      output += outputValue
    }
    const totalValue = finite(row.totalTokens)
    if (totalValue !== null) {
      sawTotal = true
      total += totalValue
    }
  }
  const promptTokens = sawInput ? (sawCacheRead ? cacheRead : 0) + input : null
  return {
    requests,
    cacheReadTokens: sawCacheRead ? cacheRead : sawInput ? 0 : null,
    inputTokens: sawInput ? input : null,
    outputTokens: sawOutput ? output : null,
    totalTokens: sawTotal ? total : null,
    promptTokens,
    cacheHitShare: promptTokens !== null && promptTokens > 0 ? cacheRead / promptTokens : null,
  }
}

/**
 * The prompt size of one usage row: the host's counts are disjoint, so the whole prompt is
 * cache-read input plus fresh input.
 *
 * @param {Record<string, unknown>} row
 * @returns {number | null}
 */
function promptOf(row) {
  const input = finite(row.inputTokens)
  if (input === null) return null
  return (finite(row.cacheReadTokens) ?? 0) + input
}

/**
 * Merge per-session sides into one configuration side.
 *
 * @param {readonly (BilledSide | null)[]} sides
 * @returns {BilledSide | null}
 */
function mergeBilledSides(sides) {
  const present = sides.filter(isNotNull)
  if (present.length === 0) return null
  let requests = 0
  let cacheRead = 0
  let input = 0
  let output = 0
  let total = 0
  let sawCacheRead = false
  let sawInput = false
  let sawOutput = false
  let sawTotal = false
  for (const side of present) {
    requests += side.requests
    if (side.cacheReadTokens !== null) {
      sawCacheRead = true
      cacheRead += side.cacheReadTokens
    }
    if (side.inputTokens !== null) {
      sawInput = true
      input += side.inputTokens
    }
    if (side.outputTokens !== null) {
      sawOutput = true
      output += side.outputTokens
    }
    if (side.totalTokens !== null) {
      sawTotal = true
      total += side.totalTokens
    }
  }
  const promptTokens = sawInput ? (sawCacheRead ? cacheRead : 0) + input : null
  return {
    requests,
    cacheReadTokens: sawCacheRead ? cacheRead : sawInput ? 0 : null,
    inputTokens: sawInput ? input : null,
    outputTokens: sawOutput ? output : null,
    totalTokens: sawTotal ? total : null,
    promptTokens,
    cacheHitShare: promptTokens !== null && promptTokens > 0 ? cacheRead / promptTokens : null,
  }
}

/**
 * A `request/header` token count, when a log carries one. The host types in this repository do
 * not, so this normally returns an empty list and the usage-derived path below is used.
 *
 * @param {readonly SessionEvent[]} events
 * @returns {{ seq: number, field: string, tokens: number }[]}
 */
function headerTokenCounts(events) {
  /** @type {{ seq: number, field: string, tokens: number }[]} */
  const counts = []
  for (const event of events) {
    if (event.type !== 'request/header' || !isRecord(event.data)) continue
    const holders = [
      { name: 'header', value: event.data.header },
      { name: 'data', value: event.data },
    ]
    for (const holder of holders) {
      if (!isRecord(holder.value)) continue
      const found = firstTokenField(holder.value)
      if (found === null) continue
      counts.push({
        seq: event.seq,
        field: `request/header.data.${holder.name}.${found.field}`,
        tokens: found.tokens,
      })
      break
    }
  }
  return counts
}

/**
 * @param {Record<string, unknown>} holder
 * @returns {{ field: string, tokens: number } | null}
 */
function firstTokenField(holder) {
  for (const field of HEADER_TOKEN_FIELDS) {
    const tokens = finite(holder[field])
    if (tokens !== null) return { field, tokens }
  }
  return null
}

/**
 * @param {readonly Record<string, unknown>[]} rows
 * @param {readonly { seq: number, field: string, tokens: number }[]} headerCounts
 */
function contextMetric(rows, headerCounts) {
  if (headerCounts.length > 0) {
    const values = headerCounts.map((count) => count.tokens)
    return {
      peakTokens: Math.max(...values),
      meanTokens: sum(values) / values.length,
      requests: values.length,
      source:
        `request/header token count (${headerCounts[0] ? headerCounts[0].field : 'request/header'}); ` +
        'peak and mean over the logged request headers',
    }
  }
  const prompts = rows.map(promptOf).filter(isNotNull)
  if (prompts.length === 0) return null
  return {
    peakTokens: Math.max(...prompts),
    meanTokens: sum(prompts) / prompts.length,
    requests: prompts.length,
    source: SOURCE.context,
  }
}

/**
 * @param {readonly Record<string, unknown>[]} rows
 * @param {readonly { seq: number, field: string, tokens: number }[]} headerCounts
 */
function promptMetric(rows, headerCounts) {
  if (headerCounts.length > 0 && headerCounts[0]) {
    return {
      tokens: headerCounts[0].tokens,
      source: `first request/header token count (${headerCounts[0].field})`,
    }
  }
  const first = rows.length > 0 ? promptOf(rows[0] ?? {}) : null
  if (first === null) return null
  return { tokens: first, source: SOURCE.prompt }
}

/**
 * @param {readonly (ReturnType<typeof analyzeSession> & { configuration: string })[]} sessions
 */
function contextAggregate(sessions) {
  const present = sessions.map((session) => session.context).filter(isNotNull)
  if (present.length === 0) return null
  const requests = sum(present.map((entry) => entry.requests))
  const weighted = sum(present.map((entry) => entry.meanTokens * entry.requests))
  return {
    peakTokens: Math.max(...present.map((entry) => entry.peakTokens)),
    meanTokens: requests > 0 ? weighted / requests : null,
    requests,
    sessionCount: present.length,
    source: `${SOURCE.context}. Peak over the configuration; mean weighted by main-request count.`,
  }
}

/**
 * @param {readonly { prompt: { tokens: number } | null }[]} sessions
 */
function promptAggregate(sessions) {
  const values = sessions.map((session) => session.prompt?.tokens ?? null).filter(isNotNull)
  if (values.length === 0) return null
  return {
    tokens: median(values),
    sessionCount: values.length,
    source: `${SOURCE.prompt}. Median over the configuration's sessions.`,
  }
}

// ---------------------------------------------------------------------------
// Folds

/**
 * @param {readonly SessionEvent[]} events
 * @param {State} state
 */
function foldsMetric(events, state) {
  /** @type {Map<number, import('../host/domain/types.js').FoldRow>} */
  const projected = new Map()
  for (const row of state.folds) projected.set(row.summarySeq, row)

  const rows = events
    .filter((event) => event.type === 'compaction/summary')
    .map((event) => foldRow(event, projected.get(event.seq) ?? null))

  /** @type {Record<string, number>} */
  const verdicts = {}
  for (const id of state.order) {
    const task = state.tasks[id]
    if (!task) continue
    verdicts[task.status] = (verdicts[task.status] ?? 0) + 1
  }

  return {
    count: state.folds.length,
    self: rows.filter((row) => row.kind === 'self').length,
    delegate: rows.filter((row) => row.kind === 'delegate').length,
    verdicts,
    rows,
    source: `${SOURCE.foldsCount}; verdicts: ${SOURCE.verdicts}`,
  }
}

/**
 * @param {SessionEvent} event a compaction/summary event
 * @param {import('../host/domain/types.js').FoldRow | null} projected
 */
function foldRow(event, projected) {
  const data = isRecord(event.data) ? event.data : {}
  const usage = isRecord(data.usage) ? sumUsage([data.usage]) : null
  const shadowedSeqs = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : null
  const shadowedTokens = finite(data.shadowedTokenCount)
  const summaryChars = summaryCharsOf(data.summary)
  const summaryEstimateTokens = summaryChars === null ? null : summaryChars / SUMMARY_CHARS_PER_TOKEN
  const summaryToSpanRatio =
    summaryEstimateTokens !== null && shadowedTokens !== null && shadowedTokens > 0
      ? summaryEstimateTokens / shadowedTokens
      : null
  /** @type {Record<string, string>} */
  const why = {}
  if (shadowedTokens === null) why.shadowedTokens = 'compaction/summary.data.shadowedTokenCount is absent'
  if (summaryChars === null) why.summaryChars = 'compaction/summary.data.summary is absent'
  if (summaryToSpanRatio === null)
    why.summaryToSpanRatio =
      summaryEstimateTokens === null || shadowedTokens === null
        ? 'the span size or the summary size is unknown'
        : 'the shadowed span reports zero tokens'
  return {
    seq: event.seq,
    taskId: projected === null ? null : projected.taskId,
    kind: usage === null ? 'self' : 'delegate',
    usage,
    shadowedSeqs,
    shadowedTokens,
    summaryChars,
    summaryEstimateTokens,
    summaryToSpanRatio,
    source: `${SOURCE.foldKind}; span: ${SOURCE.shadowed}; summary: ${SOURCE.summaryEstimate}`,
    why,
  }
}

/**
 * @param {unknown} value `compaction/summary.data.summary`
 * @returns {number | null}
 */
function summaryCharsOf(value) {
  if (!Array.isArray(value)) return null
  let chars = 0
  for (const block of value) {
    if (!isRecord(block)) continue
    if (typeof block.text === 'string') chars += block.text.length
  }
  return chars
}

/**
 * @param {readonly (ReturnType<typeof analyzeSession>)[]} sessions
 */
function foldsAggregate(sessions) {
  /** @type {Record<string, number>} */
  const verdicts = {}
  for (const session of sessions) mergeCounts(verdicts, session.folds.verdicts)
  const count = sum(sessions.map((session) => session.folds.count))
  return {
    count,
    self: sum(sessions.map((session) => session.folds.self)),
    delegate: sum(sessions.map((session) => session.folds.delegate)),
    verdicts,
    source: `${SOURCE.foldsCount}; verdicts: ${SOURCE.verdicts}. Summed over the configuration's sessions.`,
  }
}

// ---------------------------------------------------------------------------
// Recall, rereads, rejected calls

/**
 * @typedef {object} ToolCall
 * @property {string} id
 * @property {string} name
 * @property {Record<string, unknown>} args
 * @property {number} seq
 */

/**
 * Every tool call of the log, deduped by call id. `tool/call` is the canonical event; the
 * tool-call blocks of an `assistant/message` fill in for a log that predates or omits it.
 *
 * @param {readonly SessionEvent[]} events
 * @returns {ToolCall[]}
 */
function collectCalls(events) {
  /** @type {Map<string, ToolCall>} */
  const byId = new Map()
  /** @type {Map<string, { name: string, args: string | Record<string, unknown>, seq: number }>} */
  const blocks = new Map()
  for (const event of events) {
    if (event.type === 'tool/call' && isRecord(event.data)) {
      const id = typeof event.data.callId === 'string' ? event.data.callId : null
      const name = typeof event.data.name === 'string' ? event.data.name : null
      if (id === null || name === null) continue
      byId.set(id, { id, name, args: parseToolArgs(event.data.arguments), seq: event.seq })
    } else if (event.type === 'assistant/message' && isRecord(event.data) && isRecord(event.data.message)) {
      const content = event.data.message.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (!isRecord(block) || block.type !== 'tool-call') continue
        if (typeof block.id !== 'string' || typeof block.name !== 'string') continue
        if (byId.has(block.id)) continue
        const args = block.arguments
        blocks.set(block.id, {
          name: block.name,
          args: typeof args === 'string' || isRecord(args) ? args : {},
          seq: event.seq,
        })
      }
    }
  }
  for (const [id, block] of blocks) {
    if (byId.has(id)) continue
    byId.set(id, { id, name: block.name, args: parseToolArgs(block.args), seq: block.seq })
  }
  return [...byId.values()].sort((left, right) => left.seq - right.seq)
}

/**
 * @param {readonly ToolCall[]} calls
 * @param {number} folds
 */
function recallMetric(calls, folds) {
  const recallCalls = calls.filter((call) => RECALL_TOOLS.has(call.name))
  /** @type {{ recall: number, range: number, grep: number }} */
  const byKind = { recall: 0, range: 0, grep: 0 }
  for (const call of recallCalls) byKind[recallKind(call)] += 1
  /** @type {Record<string, string>} */
  const why = {}
  const perFold = folds === 0 ? null : recallCalls.length / folds
  if (perFold === null) why.perFold = 'the journal has no fold, so there is no per-fold denominator'
  return {
    calls: recallCalls.length,
    byKind,
    perFold,
    source: `${SOURCE.recall}; ${SOURCE.recallKind}; per fold: ${SOURCE.recallPerFold}`,
    why,
  }
}

/**
 * @param {ToolCall} call
 * @returns {'recall' | 'range' | 'grep'}
 */
function recallKind(call) {
  if (call.name === 'fold_range') return 'range'
  if (call.name === 'fold_grep') return 'grep'
  if (typeof call.args.grep === 'string') return 'grep'
  if (typeof call.args.from === 'number' || typeof call.args.to === 'number') return 'range'
  return 'recall'
}

/**
 * @param {readonly (ReturnType<typeof analyzeSession>)[]} sessions
 * @param {number} folds
 */
function recallAggregate(sessions, folds) {
  const byKind = { recall: 0, range: 0, grep: 0 }
  for (const session of sessions) {
    byKind.recall += session.recall.byKind.recall
    byKind.range += session.recall.byKind.range
    byKind.grep += session.recall.byKind.grep
  }
  const calls = sum(sessions.map((session) => session.recall.calls))
  const why = {}
  const perFold = folds === 0 ? null : calls / folds
  if (perFold === null) why.perFold = 'no session in this configuration has a fold'
  return {
    calls,
    byKind,
    perFold,
    source: `${SOURCE.recall}; ${SOURCE.recallKind}; per fold: ${SOURCE.recallPerFold}. Summed over the configuration's sessions.`,
    why,
  }
}

/**
 * @param {readonly SessionEvent[]} events
 * @param {readonly ToolCall[]} calls
 * @param {readonly (ReturnType<typeof foldRow>)[]} folds
 */
function rereadsMetric(events, calls, folds) {
  if (folds.length === 0) return null
  const foldSeqs = folds.map((fold) => fold.seq).filter((seq) => Number.isInteger(seq))
  const firstFoldSeq = foldSeqs.length === 0 ? null : Math.min(...foldSeqs)
  if (firstFoldSeq === null) return null

  const byCallId = new Map(calls.map((call) => [call.id, call]))
  /** @type {Map<string, number>} */
  const readsBefore = new Map()
  for (const call of calls) {
    if (!READ_TOOLS.has(call.name) || call.seq >= firstFoldSeq) continue
    const path = readPath(call.args)
    if (path === null || readsBefore.has(path)) continue
    readsBefore.set(path, call.seq)
  }

  /** @type {{ seq: number, path: string, firstReadSeq: number, toolCallId: string }[]} */
  const rows = []
  for (const event of events) {
    if (event.type !== 'tool/result' || event.seq <= firstFoldSeq) continue
    if (!isRecord(event.data) || !isRecord(event.data.message)) continue
    const callId = event.data.message.toolCallId
    if (typeof callId !== 'string') continue
    const call = byCallId.get(callId)
    if (!call || !READ_TOOLS.has(call.name)) continue
    const path = readPath(call.args)
    if (path === null) continue
    const firstReadSeq = readsBefore.get(path)
    if (firstReadSeq === undefined) continue
    rows.push({ seq: event.seq, path, firstReadSeq, toolCallId: callId })
  }
  return {
    count: rows.length,
    rows,
    folds: folds.length,
    boundarySeq: firstFoldSeq,
    source: SOURCE.rereads,
  }
}

/**
 * @param {readonly (ReturnType<typeof analyzeSession>)[]} sessions
 */
function rereadsAggregate(sessions) {
  const present = sessions.filter((session) => session.rereads !== null)
  if (present.length === 0) return null
  return {
    count: sum(present.map((session) => (session.rereads === null ? 0 : session.rereads.count))),
    sessionCount: present.length,
    source: `${SOURCE.rereads}. Summed over the configuration's sessions.`,
  }
}

/**
 * @param {unknown} value a tool-call arguments payload
 * @returns {Record<string, unknown>}
 */
function parseToolArgs(value) {
  if (isRecord(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return {}
  try {
    const parsed = JSON.parse(value)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * @param {Record<string, unknown>} args
 * @returns {string | null}
 */
function readPath(args) {
  for (const field of READ_PATH_FIELDS) {
    const value = args[field]
    if (typeof value !== 'string' || value.trim() === '') continue
    const trimmed = value.trim()
    return trimmed.startsWith('./') ? trimmed.slice(2) : trimmed
  }
  return null
}

/**
 * @param {readonly SessionEvent[]} events
 * @param {readonly ToolCall[]} calls
 */
function rejectedMetric(events, calls) {
  const byCallId = new Map(calls.map((call) => [call.id, call]))
  /** @type {{ seq: number, tool: string, toolCallId: string }[]} */
  const rows = []
  for (const event of events) {
    if (event.type !== 'tool/result' || !isRecord(event.data) || !isRecord(event.data.message)) continue
    if (event.data.message.isError !== true) continue
    const callId = event.data.message.toolCallId
    if (typeof callId !== 'string') continue
    const call = byCallId.get(callId)
    if (!call || !OUR_TOOLS.has(call.name)) continue
    rows.push({ seq: event.seq, tool: call.name, toolCallId: callId })
  }
  return { count: rows.length, rows, source: SOURCE.rejected }
}

// ---------------------------------------------------------------------------
// Steps, turns, wall clock

/** @param {readonly SessionEvent[]} events */
function stepsMetric(events) {
  const count = events.filter((event) => event.type === 'step/start').length
  return count === 0 ? null : { count, source: SOURCE.steps }
}

/** @param {readonly SessionEvent[]} events */
function turnsMetric(events) {
  const count = events.filter((event) => event.type === 'turn/start').length
  return count === 0 ? null : { count, source: SOURCE.turns }
}

/** @param {readonly SessionEvent[]} events */
function wallClockMetric(events) {
  const times = events
    .map((event) => finite(/** @type {{ time?: unknown }} */ (event).time))
    .filter(isNotNull)
  if (times.length < 2) return null
  return { ms: Math.max(...times) - Math.min(...times), source: SOURCE.wallClock }
}

/**
 * One additive count per session: total and median. Used for steps, turns and wall clock.
 *
 * @param {readonly (number | null)[]} values
 * @param {string} source
 */
function countAggregate(values, source) {
  const present = values.filter(isNotNull)
  if (present.length === 0) return null
  return {
    total: sum(present),
    median: median(present),
    sessionCount: present.length,
    source: `${source}. Total and median per session over the configuration.`,
  }
}

// ---------------------------------------------------------------------------
// Markdown report

/**
 * Render the suite as markdown: one table per configuration, its fold rows, then one aggregate
 * table with a row per configuration, prefixed by the method the numbers come from.
 *
 * @param {ReturnType<typeof analyzeSuite>} suite
 * @returns {string}
 */
export function formatSuite(suite) {
  const configurations = suite.aggregate.perConfiguration
  /** @type {string[]} */
  const lines = ['# Evaluation report', '']
  const names = configurations.map((entry) => entry.configuration).join(', ')
  lines.push(`Sessions: ${suite.sessions.length} · configurations: ${names === '' ? '—' : names}`)
  lines.push('')
  lines.push(...methodLines())
  lines.push('')
  for (const entry of configurations) {
    lines.push(...configurationLines(entry, suite))
    lines.push('')
  }
  lines.push(...aggregateLines(configurations))
  return lines.join('\n')
}

/** @returns {string[]} */
function methodLines() {
  return [
    '## Method',
    '',
    '- **Billed tokens** are sums over `assistant/message.data.usage` (main requests) and `compaction/summary.data.usage` (fold requests). The host counts are disjoint, so the cache-hit share is `cacheReadTokens / (cacheReadTokens + inputTokens)`.',
    '- **Context size** is `cacheReadTokens + inputTokens` per main request. `request/header` in this host carries `config`, `adapterDefaults` and `tools` only, no token count; if a log did carry one it would win over the usage-derived size.',
    '- **Folds, verdicts and task ids** come from replaying the log through `host/domain/projection.js` (`apply` from `initialState`); a task verdict is its final `status`.',
    '- A fold is **`self`** when its `compaction/summary` has no `data.usage` and **`delegate`** when it has one, the rule of `scripts/verify-cache.js`.',
    '- **Span size** is `compaction/summary.data.shadowedTokenCount`, the host token meter. The **summary node size is an estimate**: the character count of the summary text divided by 4, because the token meter is unavailable offline.',
    '- **Recall calls** are `tool/call` events named `fold_recall` (`grep` → grep, `from`/`to` → range), `fold_range` or `fold_grep`.',
    '- A **reread** is a `read` tool result after the first fold whose path was read before that fold; paths are compared after trimming and dropping a leading `./`.',
    '- **Rejected calls** are `tool/result` rows with `data.message.isError === true` for `task_begin`, `task_end` or `fold_recall`.',
    '- **Steps and turns** count `step/start` and `turn/start`; **wall clock** is the latest minus the earliest `event.time`.',
    "- The **first-request prompt** is the first main request's `cacheReadTokens + inputTokens`, because `request/header` has no token count.",
    '- `n/a (why)` marks a metric the journal cannot support: no number is invented and no zero stands in for one.',
  ]
}

/**
 * @param {ReturnType<typeof analyzeSuite>['aggregate']['perConfiguration'][number]} entry
 * @param {ReturnType<typeof analyzeSuite>} suite
 * @returns {string[]}
 */
function configurationLines(entry, suite) {
  const heading = `## Configuration ${entry.configuration} — ${entry.sessionCount} session${entry.sessionCount === 1 ? '' : 's'}`
  /** @type {string[]} */
  const lines = [heading, '', `Sessions: ${entry.labels.join(', ')}`, '']
  const billedMain =
    entry.billed === null
      ? unavailable(entry.why.billed ?? 'no usage')
      : entry.billed.main === null
        ? unavailable(entry.billed.why.main ?? 'no main-request usage')
        : formatBilledSide(entry.billed.main)
  const billedFold =
    entry.billed === null
      ? unavailable(entry.why.billed ?? 'no usage')
      : entry.billed.fold === null
        ? unavailable(entry.billed.why.fold ?? 'no fold-request usage')
        : formatBilledSide(entry.billed.fold)
  const context =
    entry.context === null ? unavailable(entry.why.context ?? 'no usage') : formatContext(entry.context)
  const folds = `${entry.folds.count} (self ${entry.folds.self} · delegate ${entry.folds.delegate})`
  const verdicts = formatVerdicts(entry.folds.verdicts)
  const recall =
    `${entry.recall.calls} (recall ${entry.recall.byKind.recall} · range ${entry.recall.byKind.range} · ` +
    `grep ${entry.recall.byKind.grep}) · ` +
    (entry.recall.perFold === null
      ? unavailable(entry.recall.why.perFold ?? 'no fold')
      : `${number(entry.recall.perFold)} per fold`)
  const rereads =
    entry.rereads === null
      ? unavailable(entry.why.rereads ?? 'no fold')
      : `${number(entry.rereads.count)} read result${entry.rereads.count === 1 ? '' : 's'} after the first fold`
  const steps =
    entry.steps === null
      ? unavailable(entry.why.steps ?? 'no step/start')
      : entry.steps.sessionCount === 1
        ? number(entry.steps.total)
        : `${number(entry.steps.total)} total · ${number(entry.steps.median)} median per session`
  const turns =
    entry.turns === null
      ? unavailable(entry.why.turns ?? 'no turn/start')
      : entry.turns.sessionCount === 1
        ? number(entry.turns.total)
        : `${number(entry.turns.total)} total · ${number(entry.turns.median)} median per session`
  const wallClock =
    entry.wallClockMs === null
      ? unavailable(entry.why.wallClockMs ?? 'no timestamps')
      : entry.wallClockMs.sessionCount === 1
        ? formatDuration(entry.wallClockMs.total)
        : `${formatDuration(entry.wallClockMs.total)} total · ${formatDuration(entry.wallClockMs.median)} median`
  const prompt =
    entry.prompt === null
      ? unavailable(entry.why.prompt ?? 'no prompt count')
      : entry.prompt.sessionCount === 1
        ? `${number(entry.prompt.tokens)} tokens`
        : `${number(entry.prompt.tokens)} tokens · median over ${entry.prompt.sessionCount} sessions`

  lines.push(
    ...markdownTable(
      ['Metric', 'Value', 'Source'],
      [
        ['Billed · main requests', billedMain, entry.billed === null ? SOURCE.billed : entry.billed.source],
        ['Billed · fold requests', billedFold, entry.billed === null ? SOURCE.billed : entry.billed.source],
        ['Context (main requests)', context, entry.context === null ? SOURCE.context : entry.context.source],
        ['Folds', folds, entry.folds.source],
        ['Verdicts', verdicts, SOURCE.verdicts],
        [
          'Summary / span',
          formatFoldRatio(entry.configuration, entry.folds, suite),
          `${SOURCE.summaryRatio}; ${SOURCE.summaryEstimate}`,
        ],
        ['Recall calls', recall, `${SOURCE.recall}; ${SOURCE.recallKind}; per fold: ${SOURCE.recallPerFold}`],
        ['Rereads after first fold', rereads, entry.rereads === null ? SOURCE.rereads : entry.rereads.source],
        ['Rejected task-tool calls', `${entry.rejectedCalls.count}`, SOURCE.rejected],
        ['Steps', steps, SOURCE.steps],
        ['Turns', turns, SOURCE.turns],
        ['Wall clock', wallClock, SOURCE.wallClock],
        ['First-request prompt', prompt, entry.prompt === null ? SOURCE.prompt : entry.prompt.source],
      ],
    ),
  )
  const foldRows = foldTableRows(entry.configuration, suite)
  lines.push('')
  if (foldRows.length === 0) lines.push('No folds in this configuration.')
  else {
    lines.push('### Folds', '')
    lines.push(
      ...markdownTable(
        ['Session', 'Fold seq', 'Kind', 'Task', 'Span tokens', 'Summary est. tokens', 'Ratio'],
        foldRows,
      ),
    )
  }
  return lines
}

/**
 * @param {string} configuration
 * @param {ReturnType<typeof analyzeSuite>} suite
 * @returns {string[][]}
 */
function foldTableRows(configuration, suite) {
  /** @type {string[][]} */
  const rows = []
  for (const session of suite.sessions) {
    if (session.configuration !== configuration) continue
    for (const fold of session.folds.rows) {
      rows.push([
        session.label,
        String(fold.seq),
        fold.kind,
        fold.taskId ?? '—',
        number(fold.shadowedTokens),
        number(fold.summaryEstimateTokens),
        fold.summaryToSpanRatio === null ? 'n/a' : percent(fold.summaryToSpanRatio),
      ])
    }
  }
  return rows
}

/**
 * Mean of the configuration's per-fold summary-to-span ratios. Each fold row's ratio is already
 * the audited number; the mean only condenses the table.
 *
 * @param {string} configuration
 * @param {ReturnType<typeof analyzeSuite>['aggregate']['perConfiguration'][number]['folds']} folds
 * @param {ReturnType<typeof analyzeSuite>} suite
 */
function formatFoldRatio(configuration, folds, suite) {
  const ratios = suite.sessions
    .filter((session) => session.configuration === configuration)
    .flatMap((session) => session.folds.rows.map((row) => row.summaryToSpanRatio))
    .filter(isNotNull)
  if (ratios.length === 0 || folds.count === 0) return 'n/a (no fold with a measurable span)'
  return `${percent(sum(ratios) / ratios.length)} mean over ${ratios.length} fold${ratios.length === 1 ? '' : 's'}`
}

/**
 * @param {ReturnType<typeof analyzeSuite>['aggregate']['perConfiguration'][number][]} configurations
 * @returns {string[]}
 */
function aggregateLines(configurations) {
  /** @type {string[][]} */
  const rows = configurations.map((entry) => [
    entry.configuration,
    String(entry.sessionCount),
    number(entry.billed?.main?.requests ?? null),
    number(entry.billed?.main?.totalTokens ?? null),
    percent(entry.billed?.main?.cacheHitShare ?? null),
    number(entry.billed?.fold?.requests ?? null),
    number(entry.billed?.fold?.totalTokens ?? null),
    entry.folds.count === 0
      ? '0 (0/0)'
      : `${number(entry.folds.count)} (${number(entry.folds.self)}/${number(entry.folds.delegate)})`,
    number(entry.recall.calls),
    entry.rereads === null ? 'n/a' : number(entry.rereads.count),
    number(entry.rejectedCalls.count),
    entry.steps === null ? 'n/a' : number(entry.steps.total),
    entry.wallClockMs === null ? 'n/a' : formatDuration(entry.wallClockMs.total),
  ])
  return [
    '## Aggregate',
    '',
    ...markdownTable(
      [
        'Configuration',
        'Sessions',
        'Main requests',
        'Main total tokens',
        'Main cache-hit',
        'Fold requests',
        'Fold total tokens',
        'Folds (self/delegate)',
        'Recall calls',
        'Rereads',
        'Rejected',
        'Steps',
        'Wall clock',
      ],
      rows,
    ),
  ]
}

/**
 * @param {BilledSide | null} side
 * @returns {string}
 */
function formatBilledSide(side) {
  if (side === null) return 'n/a'
  return [
    `${number(side.requests)} request${side.requests === 1 ? '' : 's'}`,
    `cache-read ${number(side.cacheReadTokens)}`,
    `fresh input ${number(side.inputTokens)}`,
    `output ${number(side.outputTokens)}`,
    `total ${number(side.totalTokens)}`,
    `cache-hit ${percent(side.cacheHitShare)}`,
  ].join(' · ')
}

/**
 * @param {{ peakTokens: number, meanTokens: number | null, requests: number }} context
 * @returns {string}
 */
function formatContext(context) {
  return `${number(context.peakTokens)} peak · ${number(context.meanTokens)} mean over ${number(context.requests)} main request${context.requests === 1 ? '' : 's'}`
}

/**
 * @param {Record<string, number>} verdicts
 * @returns {string}
 */
function formatVerdicts(verdicts) {
  const entries = Object.entries(verdicts)
  if (entries.length === 0) return 'no tasks'
  return entries.map(([status, count]) => `${status} ${number(count)}`).join(' · ')
}

/**
 * @param {number | null} value
 */
function formatDuration(value) {
  if (value === null) return 'n/a'
  if (value < 1000) return `${number(value)} ms`
  const seconds = value / 1000
  return seconds < 60 ? `${seconds.toFixed(1)} s` : `${(seconds / 60).toFixed(1)} min`
}

/** @param {string} why */
function unavailable(why) {
  return `n/a (${why})`
}

/**
 * @param {readonly string[]} headers
 * @param {readonly (readonly (string | number)[])[]} rows
 * @returns {string[]}
 */
function markdownTable(headers, rows) {
  const lines = [`| ${headers.map(cell).join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`]
  for (const row of rows) lines.push(`| ${row.map(cell).join(' | ')} |`)
  return lines
}

/** @param {string | number} value */
function cell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

// ---------------------------------------------------------------------------
// Small helpers

/**
 * @param {number | null} value
 * @returns {string}
 */
function number(value) {
  if (value === null) return 'n/a'
  const fixed = Number.isInteger(value) ? String(value) : value.toFixed(1)
  return fixed.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * @param {number | null} value
 * @returns {string}
 */
function percent(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`
}

/**
 * @param {readonly number[]} values
 */
function sum(values) {
  let total = 0
  for (const value of values) total += value
  return total
}

/**
 * @param {readonly number[]} values
 * @returns {number | null}
 */
function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] ?? null
  const lower = sorted[middle - 1]
  const upper = sorted[middle]
  return lower === undefined || upper === undefined ? null : (lower + upper) / 2
}

/**
 * @param {Record<string, number>} target
 * @param {Record<string, number>} source
 */
function mergeCounts(target, source) {
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + value
  return target
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @template T
 * @param {T | null} value
 * @returns {value is T}
 */
function isNotNull(value) {
  return value !== null
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// CLI

const USAGE = `usage: node scripts/eval-report.js [--json] [label=]<journal>...

Turns DeepSeek Harness session journals into the evaluation metrics table of docs/06 §5.3:
billed tokens (main and fold requests), context size, folds and verdicts, the summary-to-span
ratio, recall calls, rereads, rejected task-tool calls, steps, turns, wall clock and the
first-request prompt.

A journal may be written label=path: the label names the configuration the session belongs to, so
the journals of one configuration aggregate together. Without a label a journal is its own
configuration, named after its file. --json prints the analyzeSuite result instead of markdown.

Read-only: nothing is written and no network is touched. Exit 0, or 2 when a journal cannot be
read or the arguments are unusable.`

class UsageError extends Error {}

/**
 * @param {readonly string[]} argv
 * @returns {{ journals: { configuration: string, path: string, label: string }[], json: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  /** @type {{ configuration: string, path: string, label: string }[]} */
  const journals = []
  let json = false
  let help = false
  for (const arg of argv) {
    if (arg === '--json') json = true
    else if (arg === '--help' || arg === '-h') help = true
    else if (arg.startsWith('-')) throw new UsageError(`unknown option ${arg}`)
    else journals.push(journalArg(arg))
  }
  if (!help && journals.length === 0) throw new UsageError('give at least one journal path')
  return { journals, json, help }
}

/**
 * Split `label=path`. A label may not contain a path separator, so a path whose left side holds
 * a slash stays whole: `dir/a=b.jsonl` is a path, while `label=a.jsonl` names a configuration.
 *
 * @param {string} arg
 */
function journalArg(arg) {
  const at = arg.indexOf('=')
  const prefix = at > 0 ? arg.slice(0, at) : ''
  const rest = at > 0 ? arg.slice(at + 1) : ''
  const named = rest !== '' && prefix !== '' && !prefix.includes('/') && !prefix.includes('\\')
  const path = named ? rest : arg
  const label = basename(path)
  return { configuration: named ? prefix : label, path, label }
}

/**
 * The file name without a journal extension, used as the default configuration and session name.
 *
 * @param {string} path
 */
function basename(path) {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const name = cut === -1 ? path : path.slice(cut + 1)
  return name.replace(/\.(jsonl|zstd)$/i, '') || path
}

/**
 * Run the CLI and return the exit code. No host module is imported and nothing is written.
 *
 * @param {readonly string[]} argv
 * @returns {number}
 */
export function main(argv) {
  const options = parseArgs(argv)
  if (options.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const sessions = options.journals.map((journal) => {
    let text
    try {
      text = readJournalText(journal.path)
    } catch (error) {
      throw new UsageError(`cannot read ${journal.path}: ${messageOf(error)}`)
    }
    return { events: journalEvents(text), label: journal.label, configuration: journal.configuration }
  })
  const suite = analyzeSuite(sessions)
  process.stdout.write(options.json ? `${JSON.stringify(suite, null, 2)}\n` : `${formatSuite(suite)}\n`)
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    process.stderr.write(`eval-report: ${error.message}\n\n${USAGE}\n`)
    process.exitCode = 2
  }
}
