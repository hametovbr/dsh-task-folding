// The economy rule and the terminal verdicts (docs/03 §6.2, docs/10 §3): whether a closed task is
// worth folding, and what its `task_end` records. Pure and total: no ctx, no I/O, no clock.

import { isAbsorbed } from './cuts.js'

/** @typedef {import('./types.js').Task} Task */
/** @typedef {import('./types.js').EndVerdict} EndVerdict */
/** @typedef {import('./settings.js').Settings} Settings */

/** Titles are capped here; docs/04 asks the model for at most 80. */
export const TITLE_MAX = 120

/**
 * The verdict of a closed task (docs/03 §6.2), in this order: absorbed; still opening; span
 * below the fold floor; unusable summary (delegate, or queued when delegation is off); a
 * usable summary whose fold would save less than the floor; otherwise queued.
 *
 * The span includes the task_end message, whose arguments carry the summary itself, so the
 * saving of a self-summary fold is `estTokens - summaryTokens`, not `estTokens`.
 *
 * @param {Task} task
 * @param {string} summary
 * @param {number} summaryTokens
 * @param {number} estTokens
 * @param {Settings} settings
 * @returns {EndVerdict}
 */
export function decideVerdict(task, summary, summaryTokens, estTokens, settings) {
  if (isAbsorbed(task)) return 'absorbed'
  if (task.status === 'opening') return 'below-floor'
  if (estTokens < settings.minSpanTokens) return 'below-floor'
  const unusable =
    summary.length < settings.minSummaryChars ||
    (estTokens > 0 && summaryTokens > settings.maxSummaryRatio * estTokens)
  if (unusable) return settings.delegateEnabled ? 'delegate' : 'queued'
  return estTokens - summaryTokens < settings.minSpanTokens ? 'below-floor' : 'queued'
}

/**
 * Whitespace collapsed, newlines removed, trimmed, capped.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeTitle(raw) {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX).trim()
}
