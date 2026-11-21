#!/usr/bin/env node
// Measure the provider cache-hit ratio of compaction summaries against the session's own main
// requests, from DeepSeek Harness session journals (docs/07 Q12).
//
// A summary produced through the host's LLM seam carries `data.llmStreamCall: true` and
// `data.usage`. A self fold hands the host prepared blocks, so its summary is unmarked and has
// no usage by design: it is reported but never counted against the ratio.
//
//   node scripts/verify-cache.js <journal...> [--min-ratio 0.8] [--json]
//
// Exit codes: 0 the check passed, 1 an LLM-backed summary is below the line, 2 usage or read
// error. Read-only: nothing is written and no network is touched.

import { pathToFileURL } from 'node:url'

import { journalEvents, readJournalText } from './journal.js'

/** Allowed gap below the session's median main-request ratio, as a share of prompt input. */
export const MEDIAN_TOLERANCE = 0.1

const DEFAULT_MIN_RATIO = 0.8

const USAGE = `usage: node scripts/verify-cache.js <journal...> [--min-ratio 0.8] [--json]

Compares the cache-hit ratio of every compaction/summary with the session's main requests:

  ratio = cacheReadTokens / (cacheReadTokens + inputTokens)

A summary with data.usage came from an LLM call and is checked: the host's own checkpoint marks it
with data.llmStreamCall === true, this plugin's delegate fold is unmarked but reports usage. An
unmarked summary without usage is a self fold and is never counted. The check fails
(exit 1) when an LLM-backed summary is below --min-ratio (default 0.8) or more than
${MEDIAN_TOLERANCE * 100} percentage points below the median cache-hit ratio of the session's
main requests, so a summary that is merely worse than the session it replays is caught too.

--json prints one object with a block per journal (summaries, mainRequests, verdict) instead of a
table.`

/**
 * @typedef {{ type: string, seq: number, data?: any }} JournalEvent
 * @typedef {object} UsageRow
 * @property {number | null} inputTokens uncached input only (the host's counts are disjoint)
 * @property {number | null} outputTokens
 * @property {number | null} cacheReadTokens
 * @property {number | null} cacheWriteTokens
 * @property {number | null} totalTokens
 * @property {number | null} cacheHitRatio
 * @typedef {'delegate' | 'self'} SummarySource
 * @typedef {object} SummaryRow
 * @property {number} seq
 * @property {SummarySource} source
 * @property {boolean} llmStreamCall
 * @property {string | null} provider
 * @property {string | null} model
 * @property {number | null} shadowedTokenCount
 * @property {UsageRow | null} usage
 * @typedef {object} MainRequestStats
 * @property {number} count main requests that reported usage
 * @property {number | null} minRatio
 * @property {number | null} medianRatio
 * @typedef {object} JournalAnalysis
 * @property {string} journal
 * @property {SummaryRow[]} summaries
 * @property {MainRequestStats} mainRequests
 * @typedef {object} VerdictFailure
 * @property {number} seq
 * @property {number} ratio
 * @property {boolean} belowFloor
 * @property {boolean} belowMedian
 * @property {number | null} medianRatio the session's main-request median, when there was one
 * @property {number | null} deltaPoints ratio minus the median, in percentage points
 * @typedef {object} JournalVerdict
 * @property {boolean} ok
 * @property {number} checked LLM-backed summaries with a measurable ratio
 * @property {number} missingUsage LLM-backed summaries without usage
 * @property {number | null} worstRatio
 * @property {number | null} medianRatio the session's main-request median, when there was one
 * @property {VerdictFailure[]} failures
 */

/**
 * The cache-hit share of the prompt input. The host's `TokenUsage` counts are disjoint:
 * `inputTokens` is uncached input only, so the denominator is the whole prompt. A missing
 * `cacheReadTokens` means the adapter reported no cache use; a missing or zero prompt leaves
 * nothing to measure.
 *
 * @param {unknown} usage
 * @returns {number | null}
 */
export function cacheHitRatio(usage) {
  if (!isRecord(usage)) return null
  const inputTokens = finite(usage.inputTokens)
  const cacheReadTokens = finite(usage.cacheReadTokens) ?? 0
  if (inputTokens === null) return null
  const promptTokens = cacheReadTokens + inputTokens
  return promptTokens === 0 ? null : cacheReadTokens / promptTokens
}

/**
 * Analyze one journal: one row per `compaction/summary`, plus the cache-hit ratios of the
 * session's own main requests (`assistant/message.data.usage`).
 *
 * @param {readonly JournalEvent[]} events
 * @param {string} journal label for the report
 * @returns {JournalAnalysis}
 */
export function analyzeJournal(events, journal) {
  /** @type {SummaryRow[]} */
  const summaries = []
  /** @type {number[]} */
  const mainRatios = []
  for (const event of events) {
    if (event.type === 'compaction/summary') {
      summaries.push(summaryRow(event))
    } else if (event.type === 'assistant/message' && isRecord(event.data)) {
      const ratio = cacheHitRatio(event.data.usage)
      if (ratio !== null) mainRatios.push(ratio)
    }
  }
  return { journal, summaries, mainRequests: mainRequestStats(mainRatios) }
}

/**
 * Judge the LLM-backed summaries of one journal against the floor and the session's own main
 * requests. Self folds are never judged.
 *
 * @param {JournalAnalysis} analysis
 * @param {number} minRatio
 * @returns {JournalVerdict}
 */
export function judgeJournal(analysis, minRatio) {
  const medianRatio = analysis.mainRequests.medianRatio
  /** @type {VerdictFailure[]} */
  const failures = []
  /** @type {number[]} */
  const measured = []
  let missingUsage = 0
  for (const row of analysis.summaries) {
    if (row.source !== 'delegate') continue
    const ratio = row.usage === null ? null : row.usage.cacheHitRatio
    if (ratio === null) {
      // The event claims the LLM seam but recorded no usage: nothing to check, but say so.
      missingUsage += 1
      continue
    }
    measured.push(ratio)
    const belowFloor = ratio < minRatio
    const belowMedian = medianRatio !== null && ratio < medianRatio - MEDIAN_TOLERANCE
    if (!belowFloor && !belowMedian) continue
    failures.push({
      seq: row.seq,
      ratio,
      belowFloor,
      belowMedian,
      medianRatio,
      deltaPoints: medianRatio === null ? null : (ratio - medianRatio) * 100,
    })
  }
  let worstRatio = null
  for (const ratio of measured) worstRatio = worstRatio === null ? ratio : Math.min(worstRatio, ratio)
  return {
    ok: failures.length === 0,
    checked: measured.length,
    missingUsage,
    worstRatio,
    medianRatio,
    failures,
  }
}

/**
 * Render one journal block for the table output.
 *
 * @param {JournalAnalysis} analysis
 * @param {JournalVerdict} verdict
 * @param {number} minRatio
 * @returns {string}
 */
export function formatJournal(analysis, verdict, minRatio) {
  const lines = [analysis.journal]
  if (analysis.summaries.length === 0) lines.push('  no compaction/summary events')
  else lines.push(...tableLines(analysis.summaries))
  lines.push(`  ${formatMainRequests(analysis.mainRequests)}`)
  lines.push(`  ${formatVerdict(verdict, minRatio)}`)
  for (const failure of verdict.failures) lines.push(`    FAIL ${failureText(failure, minRatio)}`)
  return lines.join('\n')
}

/**
 * @param {readonly string[]} argv
 * @returns {{ files: string[], minRatio: number, json: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  /** @type {string[]} */
  const files = []
  let minRatio = DEFAULT_MIN_RATIO
  let json = false
  let help = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) continue
    if (arg === '--json') {
      json = true
    } else if (arg === '--help' || arg === '-h') {
      help = true
    } else if (arg === '--min-ratio') {
      const raw = argv[index + 1]
      if (raw === undefined) throw new UsageError('--min-ratio needs a value')
      minRatio = parseRatio(raw)
      index += 1
    } else if (arg.startsWith('--min-ratio=')) {
      minRatio = parseRatio(arg.slice('--min-ratio='.length))
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown option ${arg}`)
    } else {
      files.push(arg)
    }
  }
  if (!help && files.length === 0) throw new UsageError('give at least one journal path')
  return { files, minRatio, json, help }
}

/**
 * Run the CLI and return the exit code (docs/02: no host module is imported, no write happens).
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
  const judged = options.files.map((file) => {
    let text
    try {
      text = readJournalText(file)
    } catch (error) {
      throw new UsageError(`cannot read ${file}: ${messageOf(error)}`)
    }
    const analysis = analyzeJournal(journalEvents(text), file)
    return { analysis, verdict: judgeJournal(analysis, options.minRatio) }
  })
  if (options.json) {
    process.stdout.write(`${JSON.stringify(jsonReport(judged, options.minRatio), null, 2)}\n`)
  } else {
    const blocks = judged.map(({ analysis, verdict }) => formatJournal(analysis, verdict, options.minRatio))
    process.stdout.write(`${blocks.join('\n\n')}\n`)
  }
  writeDiagnostics(judged, options.minRatio)
  return judged.every(({ verdict }) => verdict.ok) ? 0 : 1
}

class UsageError extends Error {}

/**
 * @typedef {{ analysis: JournalAnalysis, verdict: JournalVerdict }} JudgedJournal
 */

/**
 * @param {readonly JudgedJournal[]} judged
 * @param {number} minRatio
 */
function writeDiagnostics(judged, minRatio) {
  let missingUsage = 0
  let failures = 0
  for (const { analysis, verdict } of judged) {
    missingUsage += verdict.missingUsage
    for (const failure of verdict.failures) {
      failures += 1
      process.stderr.write(`verify-cache: ${analysis.journal}: ${failureText(failure, minRatio)}\n`)
    }
  }
  if (missingUsage > 0) {
    process.stderr.write(
      `verify-cache: warning: ${missingUsage} LLM-backed summary(s) carry no usage; no cache-hit ratio to check\n`,
    )
  }
  if (failures > 0) {
    process.stderr.write(
      `verify-cache: cache check failed: ${failures} LLM-backed summary(s) below the line\n`,
    )
  }
}

/**
 * @param {readonly JudgedJournal[]} judged
 * @param {number} minRatio
 */
function jsonReport(judged, minRatio) {
  return {
    minRatio,
    medianTolerance: MEDIAN_TOLERANCE,
    ok: judged.every(({ verdict }) => verdict.ok),
    journals: judged.map(({ analysis, verdict }) => ({
      journal: analysis.journal,
      summaries: analysis.summaries,
      mainRequests: analysis.mainRequests,
      verdict,
    })),
  }
}

/**
 * @param {JournalEvent} event
 * @returns {SummaryRow}
 */
function summaryRow(event) {
  const data = isRecord(event.data) ? event.data : {}
  const llmStreamCall = data.llmStreamCall === true
  const usage = isRecord(data.usage) ? usageRow(data.usage) : null
  return {
    seq: event.seq,
    // `usage` is the reliable signal: this plugin's delegate fold is unmarked by design (it hands
    // prepared blocks to the host, docs/adr/0004) yet still reports what the provider charged,
    // while a self fold has neither the marker nor usage.
    source: llmStreamCall || usage !== null ? 'delegate' : 'self',
    llmStreamCall,
    provider: typeof data.provider === 'string' ? data.provider : null,
    model: typeof data.model === 'string' ? data.model : null,
    shadowedTokenCount: finite(data.shadowedTokenCount),
    usage,
  }
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {UsageRow}
 */
function usageRow(raw) {
  return {
    inputTokens: finite(raw.inputTokens),
    outputTokens: finite(raw.outputTokens),
    cacheReadTokens: finite(raw.cacheReadTokens),
    cacheWriteTokens: finite(raw.cacheWriteTokens),
    totalTokens: finite(raw.totalTokens),
    cacheHitRatio: cacheHitRatio(raw),
  }
}

/**
 * @param {readonly number[]} ratios
 * @returns {MainRequestStats}
 */
function mainRequestStats(ratios) {
  if (ratios.length === 0) return { count: 0, minRatio: null, medianRatio: null }
  let minRatio = null
  for (const ratio of ratios) minRatio = minRatio === null ? ratio : Math.min(minRatio, ratio)
  return { count: ratios.length, minRatio, medianRatio: median(ratios) }
}

/**
 * @param {readonly number[]} values
 * @returns {number | null}
 */
function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] ?? null
  const lower = sorted[middle - 1]
  const upper = sorted[middle]
  return lower === undefined || upper === undefined ? null : (lower + upper) / 2
}

/**
 * @param {MainRequestStats} stats
 * @returns {string}
 */
function formatMainRequests(stats) {
  if (stats.count === 0) return 'main requests: none with usage (no cache benchmark)'
  return `main requests: ${stats.count} with usage (min ${percent(stats.minRatio)}, median ${percent(
    stats.medianRatio,
  )})`
}

/**
 * @param {JournalVerdict} verdict
 * @param {number} minRatio
 * @returns {string}
 */
function formatVerdict(verdict, minRatio) {
  const floor = `floor ${percent(minRatio)}`
  const median = verdict.medianRatio
  if (verdict.checked === 0) {
    const benchmark =
      median === null ? 'no main-request usage to compare' : `median main request ${percent(median)}`
    return `verdict: no LLM-backed summary to check (self folds carry no usage by design; ${benchmark}) — ok`
  }
  const count = `${verdict.checked} LLM-backed summar${verdict.checked === 1 ? 'y' : 'ies'}`
  const worst = `worst ${percent(verdict.worstRatio)}`
  const comparison =
    median === null
      ? 'no main-request usage to compare'
      : `vs median main request ${percent(median)} (delta ${signedPoints(
          ((verdict.worstRatio ?? 0) - median) * 100,
        )} pp, tolerance -${(MEDIAN_TOLERANCE * 100).toFixed(1)} pp)`
  return `verdict: ${count}, ${worst}; ${comparison}; ${floor} — ${verdict.ok ? 'ok' : 'FAIL'}`
}

/**
 * @param {VerdictFailure} failure
 * @param {number} minRatio
 * @returns {string}
 */
function failureText(failure, minRatio) {
  /** @type {string[]} */
  const reasons = []
  if (failure.belowFloor) reasons.push(`below the ${percent(minRatio)} floor`)
  if (failure.belowMedian) {
    const delta = failure.deltaPoints === null ? 0 : Math.abs(failure.deltaPoints)
    reasons.push(`${delta.toFixed(1)} pp below the median main request ${percent(failure.medianRatio)}`)
  }
  return `seq ${failure.seq}: ${percent(failure.ratio)} is ${reasons.join(' and ')}`
}

/**
 * @param {readonly SummaryRow[]} summaries
 * @returns {string[]}
 */
function tableLines(summaries) {
  const headers = ['seq', 'kind', 'provider', 'model', 'shadowed', 'cacheRead', 'input', 'ratio']
  const rightAligned = new Set([0, 4, 5, 6, 7])
  const rows = summaries.map((row) => [
    String(row.seq),
    row.source === 'delegate' ? 'delegate' : 'self fold (no LLM call)',
    row.provider ?? '-',
    row.model ?? '-',
    row.shadowedTokenCount === null ? '-' : String(row.shadowedTokenCount),
    row.usage === null ? '-' : String(row.usage.cacheReadTokens ?? 0),
    row.usage === null ? '-' : String(row.usage.inputTokens ?? '-'),
    row.usage === null ? '-' : percent(row.usage.cacheHitRatio),
  ])
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  )
  const line = (/** @type {readonly string[]} */ cells) =>
    cells
      .map((cell, column) =>
        rightAligned.has(column) ? cell.padStart(widths[column] ?? 0) : cell.padEnd(widths[column] ?? 0),
      )
      .join('  ')
      .trimEnd()
  const separator = widths.map((width) => '-'.repeat(width)).join('  ')
  return [`  ${line(headers)}`, `  ${separator}`, ...rows.map((row) => `  ${line(row)}`)]
}

/**
 * @param {number | null} ratio
 * @returns {string}
 */
function percent(ratio) {
  return ratio === null ? 'n/a' : `${(ratio * 100).toFixed(1)}%`
}

/**
 * @param {number} points
 * @returns {string}
 */
function signedPoints(points) {
  return `${points >= 0 ? '+' : ''}${points.toFixed(1)}`
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
  return typeof value === 'object' && value !== null
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {string} raw
 * @returns {number}
 */
function parseRatio(raw) {
  const value = Number(raw)
  if (raw.trim() === '' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new UsageError(`--min-ratio must be a number between 0 and 1, got ${raw}`)
  }
  return value
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    process.stderr.write(`verify-cache: ${error.message}\n\n${USAGE}\n`)
    process.exitCode = 2
  }
}
