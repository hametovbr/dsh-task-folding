// Every model-facing string of the plugin (docs/04-tools-and-prompt.md). Nothing else in the
// plugin may build text the model reads; test/prompt-budget.test.js keeps the total small.

/** @typedef {import('./types.js').EndVerdict} EndVerdict */

export const PROMPT_SECTION =
  'Task folding. Wrap each unit of work that has a verifiable outcome in task_begin … task_end. ' +
  'A single lookup is a step, not a task. When a unit has distinct parts, open a subtask for each part. ' +
  "task_end replaces the task's messages with your summary, so close a task as soon as its outcome is " +
  'clear and put in the summary everything you will still need: decisions, changed paths and values, ' +
  'failures and their causes. Report to the user as usual; the report may come before or after task_end. ' +
  'When a summary does not answer a concrete question, read the originals with fold_recall instead of guessing.'

export const TASK_BEGIN_DESCRIPTION =
  'Open a task: a unit of work with a verifiable outcome (a fix, a feature, an investigation, a review). ' +
  'When it ends, task_end replaces its messages with your summary. Tasks nest: a task_begin while a task ' +
  'is open opens a subtask. Returns the task id.'

export const TASK_BEGIN_PARAMS = Object.freeze({
  title: 'Short title, one line, at most 80 characters.',
})

export const TASK_END_DESCRIPTION =
  'Close a task. Its messages since task_begin are replaced by your summary, so write the summary for ' +
  'yourself later: someone continuing this work with only the summary in view. The originals stay ' +
  'retrievable with fold_recall. Closing a task also closes its open subtasks.'

export const TASK_END_PARAMS = Object.freeze({
  summary:
    'Markdown about the work itself, not about opening or closing tasks. Use only sections that have ' +
    'content, never "None": ## Done (what was done and why this way), ## Decisions (user requests and ' +
    'corrections, verbatim when wording matters), ## Changed (exact file paths, identifiers, values), ' +
    '## Pitfalls (what failed and why), ## Outcome. Size it to the work: a line or two for a small task, ' +
    'about a tenth of the work for a large one.',
  id: 'Task id to close. Default: the innermost open task.',
  outcome: 'Default: done.',
})

export const FOLD_RECALL_DESCRIPTION =
  'Read folded work back from the session log. Without arguments: the list of folds. With task or fold: ' +
  "that fold's message index (one line per message). Add from/to for the exact original messages, or " +
  'grep to search them.'

export const FOLD_RECALL_PARAMS = Object.freeze({
  task: 'Task id, e.g. T7.',
  fold: 'Fold number from the list; also covers automatic compactions.',
  from: 'First message line, 1-based. With to: at most 20 lines.',
  to: 'Last message line, inclusive.',
  grep: "Case-insensitive text, or /regex/, to find in the fold's messages.",
  page: 'Index page, 1-based, 200 lines each. Default 1.',
})

// ---------------------------------------------------------------------------
// Rendered results

/**
 * @param {string} id
 * @param {string | null} parent
 */
export function renderBegin(id, parent) {
  return parent === null ? `Task ${id} opened.` : `Task ${id} opened (inside ${parent}).`
}

/** @type {Readonly<Record<EndVerdict, string>>} */
const END_CLAUSE = Object.freeze({
  queued: 'it will be folded into your summary.',
  delegate: 'the summary was too short or too long for this span, so it will be summarized automatically.',
  'below-floor': 'it is small, so its messages stay as they are.',
  absorbed: 'its beginning was already compacted, so it gets no separate fold.',
})

/**
 * @param {string} id
 * @param {EndVerdict} verdict
 * @param {readonly string[]} merged
 * @param {readonly string[]} remaining
 */
export function renderEnd(id, verdict, merged, remaining) {
  const open = remaining.length === 0 ? 'No open tasks.' : `Open: ${remaining.join(', ')}.`
  const sub = merged.length === 0 ? '' : ` Subtasks closed with it: ${merged.join(', ')}.`
  return `Task ${id} closed; ${END_CLAUSE[verdict]} ${open}${sub}`
}

/**
 * @param {{ index: number, taskId: string | null, title: string | null, count: number, tokens: number }[]} rows
 */
export function renderFoldList(rows) {
  if (rows.length === 0) return 'No folds yet.'
  const lines = rows.map((row) => {
    const what = row.taskId === null ? 'auto compaction' : `${row.taskId} · ${row.title ?? ''}`
    return `#${row.index} ${what} · ${row.count} msgs · ~${formatTokens(row.tokens)} tokens`
  })
  return [`Folds (${rows.length}):`, ...lines].join('\n')
}

export const RECALL_NOT_AVAILABLE =
  'Reading a fold back by task, fold, range or grep is not available in this version; only the list of folds is.'

/**
 * The node a whole task collapses into (docs/04 §6). The host frames it with its own checkpoint
 * preamble and `<compacted-summary>` tags; the projection recognises the fold structurally, never
 * from this text, so the wording here is for the model alone.
 *
 * @param {{ id: string, title: string, outcome: string | null }} task
 * @param {string} summary the model's own summary
 * @param {{ messages: number, tokens: number }} stats
 */
export function renderFoldNode(task, summary, stats) {
  const outcome = task.outcome === null ? 'done' : task.outcome
  return [
    `# ${task.id} · ${task.title}`,
    summary.trim(),
    '',
    `— fold of ${task.id} · ${stats.messages} messages · ~${formatTokens(stats.tokens)} tokens · outcome: ${outcome} · originals: fold_recall({ task: "${task.id}" })`,
  ].join('\n')
}

/** @param {number} tokens */
export function formatTokens(tokens) {
  if (tokens < 1000) return String(Math.max(0, Math.round(tokens)))
  return `${(tokens / 1000).toFixed(1)}k`
}

// ---------------------------------------------------------------------------
// Errors (the host renders a thrown error as `Error: <message>` and records no meta)

/** @param {string} tool @param {string} reason */
export const failure = (tool, reason) => `${tool} failed: ${reason}`
export const ERR_NESTED = (/** @type {string} */ tool) => `call ${tool} directly, not from run_code.`
export const ERR_EMPTY_TITLE = 'the title is empty.'
export const ERR_NO_OPEN_TASK = 'no task is open.'
/** @param {string} id @param {readonly string[]} open */
export const ERR_UNKNOWN_TASK = (id, open) =>
  `task ${id} is not open. Open tasks: ${open.length === 0 ? 'none' : open.join(', ')}.`
export const ERR_BAD_OUTCOME = 'outcome must be done, failed or abandoned.'
export const ERR_UNAVAILABLE = 'task folding is not ready yet; try again.'
export const ERR_NO_EXEC = 'the call arrived without a host execution context.'
