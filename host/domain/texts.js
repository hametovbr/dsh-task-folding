// Every model-facing string of the plugin (docs/04-tools-and-prompt.md). Nothing else in the
// plugin may build text the model reads; test/prompt-budget.test.js keeps the total small.

/** @typedef {import('./types.js').EndVerdict} EndVerdict */
/** @typedef {import('./types.js').TaskStatus} TaskStatus */

export const PROMPT_SECTION =
  'Task folding. Wrap each unit of work that has a verifiable outcome in task_begin … task_end. ' +
  'Call task_begin in its own message, before the work it covers. ' +
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
 * The fold list (docs/04 §1): one line per row, in the order recall hands them over — roots in log
 * order, each followed by the folds it shadowed — indented two spaces per nesting level.
 *
 * @param {{ index: number, taskId: string | null, title: string | null, count: number, tokens: number, depth?: number }[]} rows
 */
export function renderFoldList(rows) {
  if (rows.length === 0) return 'No folds yet.'
  const lines = rows.map((row) => {
    const what = row.taskId === null ? 'auto compaction' : `${row.taskId} · ${row.title ?? ''}`
    const indent = '  '.repeat(row.depth ?? 0)
    return `${indent}#${row.index} ${what} · ${row.count} msgs · ~${formatTokens(row.tokens)} tokens`
  })
  return [`Folds (${rows.length}):`, ...lines].join('\n')
}

// ---------------------------------------------------------------------------
// Stale-task hint (docs/03 §8, docs/04 §5)

/**
 * The hint for a task that has been open for `bucket` assistant messages or more. The wording is
 * fixed by docs/04 §5, so the bytes do not move while the age stays inside a bucket and the
 * projection's latch key stays valid. The title is quoted with JSON escaping: it stays one line
 * and cannot end the quoted title early.
 *
 * @param {string} id
 * @param {string} title
 * @param {number} bucket
 */
export function renderStaleTaskHint(id, title, bucket) {
  return (
    `Task ${id} ${JSON.stringify(title)} has been open for ${bucket}+ steps. ` +
    'If it is finished, call task_end with a summary; ' +
    'if it has distinct parts, wrap the remaining parts in nested tasks.'
  )
}

/**
 * The hint for a task that closed below the floor because its whole span was the closing message:
 * `task_begin` shared the assistant message with the first work calls (docs/07 Q15, docs/10 §10).
 * One sentence, in the voice of the stale hint; the title is JSON-escaped like there, so the text
 * stays one line and the quoted title cannot end early.
 *
 * @param {string} id
 * @param {string} title
 */
export function renderEmptySpanHint(id, title) {
  return (
    `Task ${id} ${JSON.stringify(title)} closed below the fold floor because task_begin shared its ` +
    'message with the work it covers; call task_begin in its own message next time.'
  )
}

// ---------------------------------------------------------------------------
// fold_recall reads (docs/03 §6.3): the span index, the exact range and grep

/** `Fold #3 · T6 · Review PR #98 · 18 messages`, plus the page when the index has several. */
export function renderIndexHeader(
  /** @type {number} */ index,
  /** @type {string | null} */ taskId,
  /** @type {string | null} */ title,
  /** @type {number} */ count,
  /** @type {number} */ page,
  /** @type {number} */ pages,
) {
  const what = taskId === null ? 'auto compaction' : `${taskId} · ${title ?? ''}`
  const paging = pages > 1 ? ` (page ${page} of ${pages})` : ''
  return `Fold #${index} · ${what} · ${count} messages${paging}`
}

/** `L12` followed by the message's one-line brief. */
export function renderIndexLine(/** @type {number} */ line, /** @type {string} */ brief) {
  return `L${line} ${brief}`
}

/** A shadowed fold node: `[fold #2 T5 "Reproduce the loop"]` or `[fold #2 auto compaction]`. */
export function renderFoldNodeRef(
  /** @type {number} */ index,
  /** @type {string | null} */ taskId,
  /** @type {string | null} */ title,
) {
  return taskId === null
    ? `[fold #${index} auto compaction]`
    : `[fold #${index} ${taskId} ${JSON.stringify(title ?? '')}]`
}

/** One line of the span index for a message: `assistant: read src/auth/redirect.ts`, `tool read: 214 lines`. */
export function renderBrief(
  /** @type {string} */ role,
  /** @type {any} */ message,
  /** @type {string | null} */ toolName,
) {
  const blocks = message && Array.isArray(message.content) ? message.content : []
  if (role === 'tool') {
    const name = toolName === null || toolName === '' ? null : toolName
    return name === null
      ? `tool: ${toolBrief(message, blocks)}`
      : `tool ${name}: ${toolBrief(message, blocks)}`
  }
  const text = firstText(blocks)
  if (text !== null) return `${role}: ${snippet(text)}`
  if (role === 'assistant') {
    const names = toolCallNames(blocks)
    if (names.length > 0) return `${role}: ${names.join(', ')}`
  }
  return `${role}: (empty)`
}

/** Longest brief text; the index line stays one line (docs/04 §1). */
const BRIEF_MAX = 100

/** @param {any[]} blocks */
function firstText(blocks) {
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      return block.text
    }
  }
  return null
}

/** @param {any[]} blocks */
function toolCallNames(blocks) {
  /** @type {string[]} */
  const names = []
  for (const block of blocks) {
    if (block && block.type === 'tool-call' && typeof block.name === 'string') names.push(block.name)
  }
  return names
}

/** @param {any} message @param {any[]} blocks */
function toolBrief(message, blocks) {
  const text = firstText(blocks) ?? ''
  if (message && message.isError === true) return text === '' ? 'error' : `error: ${snippet(text)}`
  const lines = text.trim() === '' ? 0 : text.replace(/\s+$/, '').split('\n').length
  if (lines > 1) return `${lines} lines`
  return lines === 0 ? '(empty)' : snippet(text)
}

/** One line, whitespace collapsed, capped. */
function snippet(/** @type {string} */ text) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= BRIEF_MAX ? flat : `${flat.slice(0, BRIEF_MAX - 1).trimEnd()}…`
}

/** `Fold #3 lines 2-3:` */
export function renderRangeHeader(
  /** @type {number} */ index,
  /** @type {number} */ from,
  /** @type {number} */ to,
) {
  return `Fold #${index} lines ${from}-${to}:`
}

/** `L2 {"role":"tool", …}` */
export function renderRangeLine(/** @type {number} */ line, /** @type {any} */ message) {
  return `L${line} ${JSON.stringify(message)}`
}

export const RANGE_TRUNCATED = '[truncated: narrow from/to]'

/** `Fold #3 grep "redirect_uri" (4 hits):` */
export function renderGrepHeader(
  /** @type {number} */ index,
  /** @type {string} */ pattern,
  /** @type {number} */ hits,
) {
  return `Fold #${index} grep ${JSON.stringify(pattern)} (${hits} hit${hits === 1 ? '' : 's'}):`
}

/** `Fold #3 grep "redirect_uri": no hits.` */
export function renderGrepEmpty(/** @type {number} */ index, /** @type {string} */ pattern) {
  return `Fold #${index} grep ${JSON.stringify(pattern)}: no hits.`
}

/** `L2: …const redirect_uri = buildRedirect(…` */
export function renderGrepHit(
  /** @type {number} */ line,
  /** @type {string} */ context,
  /** @type {boolean} */ leading,
  /** @type {boolean} */ trailing,
) {
  return `L${line}: ${leading ? '…' : ''}${context}${trailing ? '…' : ''}`
}

/** @param {number} shown @param {number} total */
export const GREP_TRUNCATED = (shown, total) => `[truncated: ${shown} of ${total} hits]`

// ---------------------------------------------------------------------------
// fold_recall errors (returned as text: the tool is read-only, so nothing throws)

/** @param {unknown} value */
const quoted = (value) => JSON.stringify(value) ?? String(value)
/** `no fold has task T9; call fold_recall without arguments to list the folds.` */
export const NOT_FOUND_TASK = (/** @type {string} */ task) =>
  `no fold has task ${task}; call fold_recall without arguments to list the folds.`
/** @param {number} fold @param {number} total */
export const NOT_FOUND_FOLD = (fold, total) =>
  total === 0
    ? 'no folds yet.'
    : `fold #${fold} does not exist; this session has ${total} fold${total === 1 ? '' : 's'}.`
/** @param {unknown} page */
export const PAGE_INVALID = (page) => `page must be a number of 1 or more, not ${quoted(page)}.`
/** @param {number} page @param {number} total @param {number} pages */
export const PAGE_NOT_FOUND = (page, total, pages) =>
  `this fold has ${total} messages in ${pages} page${pages === 1 ? '' : 's'}; page ${page} does not exist.`
/** @param {number} from @param {number} to @param {number} total */
export const RANGE_OUT_OF_BOUNDS = (from, to, total) =>
  `lines ${from}-${to} are outside this fold: it has ${total} messages.`
/** @param {number} from @param {number} to */
export const RANGE_BACKWARDS = (from, to) => `from (${from}) is after to (${to}).`
export const RANGE_NEEDS_BOTH = 'give both from and to as message line numbers, or neither.'
export const RANGE_OR_GREP = 'use either from/to or grep, not both.'
export const NEED_FOLD = 'name the fold with fold or task, then add from/to or grep.'
/** @param {unknown} value */
export const BAD_FOLD_ARG = (value) => `fold must be a fold number from the list, not ${quoted(value)}.`
/** @param {unknown} value */
export const BAD_TASK_ARG = (value) => `task must be a task id such as T7, not ${quoted(value)}.`
/** @param {unknown} value */
export const BAD_GREP_ARG = (value) => `grep must be text or /regex/, not ${quoted(value)}.`
export const GREP_EMPTY = 'grep needs a non-empty pattern.'
export const ERR_EMPTY_REGEX = 'the regex is empty'
/** Role label for a shadowed event that derives no message. */
export const UNKNOWN_ROLE = 'message'
/** @param {string} pattern @param {string} reason */
export const BAD_REGEX = (pattern, reason) => `bad regex ${JSON.stringify(pattern)}: ${reason}.`

/**
 * The node a whole task collapses into (docs/04 §6, docs/03 §7.3). The host frames it with its own
 * checkpoint preamble and `<compacted-summary>` tags; the projection recognises the fold
 * structurally, never from this text, so the wording here is for the model alone.
 *
 * The pinned sections (ADR 0009) sit between the summary and the trailer, each already rendered as
 * one block. A section is a heading plus one line per pinned node; the node text is the blocks
 * joined by a blank line, exactly as the previous heading + summary + trailer form was.
 *
 * @param {{ id: string, title: string, outcome: string | null }} task
 * @param {string} summary the model's own summary, already sanitised
 * @param {{ messages: number, tokens: number }} stats
 * @param {readonly string[]} [sections]
 */
export function renderFoldNode(task, summary, stats, sections = []) {
  const outcome = task.outcome === null ? 'done' : task.outcome
  /** @type {string[]} */
  const blocks = []
  const heading = `# ${task.id} · ${task.title}`
  blocks.push(summary.trim() === '' ? heading : `${heading}\n${summary.trim()}`)
  blocks.push(...sections.filter((section) => section !== ''))
  blocks.push(
    `— fold of ${task.id} · ${stats.messages} messages · ~${formatTokens(stats.tokens)} tokens · outcome: ${outcome} · originals: fold_recall({ task: "${task.id}" })`,
  )
  return blocks.join('\n\n')
}

/**
 * The node an implicit turn fold commits (docs/03 §5.6, ADR 0009). It has no task, so it has no
 * `# T<n>` heading; the trailer names the fold number the fold list will give it.
 *
 * @param {string} summary the model's own summary, already sanitised
 * @param {{ messages: number, tokens: number }} stats
 * @param {number | null} fold the 1-based fold number the commit becomes
 * @param {readonly string[]} [sections]
 */
export function renderTurnFoldNode(summary, stats, fold, sections = []) {
  /** @type {string[]} */
  const blocks = []
  if (summary.trim() !== '') blocks.push(summary.trim())
  blocks.push(...sections.filter((section) => section !== ''))
  blocks.push(
    `— fold of ${stats.messages} messages · ~${formatTokens(stats.tokens)} tokens · originals: ${foldRecallPointer(null, fold)}`,
  )
  return blocks.join('\n\n')
}

/** @param {number} tokens */
export function formatTokens(tokens) {
  if (tokens < 1000) return String(Math.max(0, Math.round(tokens)))
  return `${(tokens / 1000).toFixed(1)}k`
}

// ---------------------------------------------------------------------------
// The pinned inbound sections of a fold node (ADR 0009)

/** The human's own messages, quoted: the only text a fold cannot regenerate. */
export const FOLD_VERBATIM_HEADING = '## User messages, verbatim (folded)'
/** Plugin-authored and unknown inbound nodes, named but never quoted: a fold is a rewrite. */
export const FOLD_REFERENCE_HEADING = '## Folded inbound messages (references)'
/** A nested `<compacted-summary>` is elided, never silently truncated. */
export const FOLD_ELIDED_SUMMARY = '[…folded summary elided…]'
/** The kind named for an inbound node whose source carries none this plugin can read. */
export const FOLD_UNKNOWN_KIND = 'unknown'

/**
 * The `fold_recall` call that reads a folded node's originals back (docs/04 §1).
 *
 * @param {string | null} taskId
 * @param {number | null} fold
 */
export function foldRecallPointer(taskId, fold) {
  return taskId === null
    ? `fold_recall({ fold: ${fold} })`
    : `fold_recall({ task: ${JSON.stringify(taskId)} })`
}

/** A verbatim pin: every line of the principal's text as a blockquote line. @param {readonly string[]} lines */
export function renderVerbatimPin(lines) {
  return lines.map((line) => (line === '' ? '>' : `> ${line}`)).join('\n')
}

/**
 * One reference line for a plugin-authored node: its kind and seq, and where the wording still is.
 * The text itself is never quoted (ADR 0009 § Why plugin text is referenced, not quoted).
 *
 * @param {string} kind
 * @param {number} seq
 * @param {string} recall
 */
export function renderFoldReference(kind, seq, recall) {
  return `> [${kind} · seq ${seq}] folded into this node; the text is in ${recall}`
}

/**
 * The line a pin degrades to when the caps or the adaptive budget leave no room: it names the kind
 * and the length, so nothing is silently truncated.
 *
 * @param {string} kind
 * @param {number} seq
 * @param {number} chars
 * @param {string} recall
 */
export function renderFoldPinMarker(kind, seq, chars, recall) {
  return `> [${kind} · seq ${seq}] ${chars} characters not pinned; the text is in ${recall}`
}

/**
 * The line that closes a section the 4,000-character cap cut: the dropped nodes are counted, not
 * forgotten.
 *
 * @param {number} count
 * @param {string} recall
 */
export function renderFoldElision(count, recall) {
  return `> […${count} folded messages not pinned; the text is in ${recall}]`
}

// ---------------------------------------------------------------------------
// Delegate summarizer (docs/03 §5.4, §7.2): the instruction and its validation messages

/**
 * The instruction of the delegate summarizer (docs/03 §7.2), appended as the final user message
 * after the replayed prefix and the task span. `index` holds one already-rendered line per span
 * message, in order; `budgetTokens` is the summary's size cap, already resolved by the caller
 * (about 5-10 % of the span, capped at ~1,500 tokens).
 *
 * @param {{ index: readonly string[], budgetTokens: number }} input
 * @returns {string}
 */
export function renderDelegateInstruction({ index, budgetTokens }) {
  /** @type {string[]} */
  const parts = [
    'You are acting as the summarizer for one finished task of this session. The messages above are that task: condense them into a Markdown summary that lets another model continue the work with only the summary in view.',
    '',
    'Write about the work itself, not about opening or closing tasks:',
    '- ## Done: what was done and what it produced.',
    '- ## Decisions: user requests and corrections, quoted verbatim when the exact wording matters.',
    '- ## Changed: exact file paths, identifiers, values and commands.',
    '- ## Pitfalls: what failed and why.',
    '',
    'Messages wrapped in <compacted-summary> are earlier folds of subtasks: keep their conclusions and do not re-narrate them. Preserve exact paths, identifiers, values, commands and error strings; they cannot be guessed later.',
    '',
    `Open with a ## section heading. Size budget: aim for 5-10% of the summarized messages and at most about ${formatBudget(budgetTokens)} tokens. Use short bullets rather than prose paragraphs, skip an empty section instead of writing "None", and do not add a rationale to every bullet.`,
    '',
  ]
  if (index.length > 0)
    parts.push('The numbered index below lists the summarized messages, in order:', ...index, '')
  parts.push(
    'Output only the summary Markdown: no preamble, no code fence around it, no question, and never call a tool.',
  )
  return parts.join('\n')
}

/** Thousands separated, so a budget reads as prose: `1,500`. @param {number} tokens */
function formatBudget(tokens) {
  return String(Math.max(0, Math.round(tokens))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Empty summary text is never a usable fold (docs/03 §5.4). */
export const DELEGATE_EMPTY = 'the delegate summary is empty'
/** The text must open with a `## ` section after at most 3 short preamble lines (docs/03 §5.4). */
export const DELEGATE_NO_SECTION = 'the delegate summary does not open with a "## " section'
/** A summary over the allowed share of the span is rejected before it can be committed. */
export const DELEGATE_TOO_LARGE = (/** @type {number} */ tokens, /** @type {number} */ limit) =>
  `the delegate summary is too large: ~${formatBudget(tokens)} tokens, limit ~${formatBudget(limit)} tokens`
/** The call finished without any text to commit. */
export const DELEGATE_EMPTY_OUTPUT = 'the delegate call produced no summary text'
/** A summary cut off at the token cap is incomplete, exactly as in the host's own summarizer. */
export const DELEGATE_MAX_TOKENS = 'the delegate summary was truncated at the token cap'
/** A terminal finish with no provider message of its own. */
export const DELEGATE_ABORTED = 'the delegate call was aborted before producing a summary'
export const DELEGATE_FAILED = 'the delegate call failed before producing a summary'
/** The host LLM package resolved but did not carry the assembler. */
export const DELEGATE_NO_ASSEMBLER = 'the host LLM package did not expose BlockAssembler'

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
/**
 * The refusal for a task_end that names a task the projection already closed (docs/07 Q17). The
 * answer names the state the log actually holds, because "no task is open" hid it and left the
 * model with no next step. `fold` is the 1-based fold number `fold_recall` lists: the fold row
 * index plus one.
 *
 * @param {string} id
 * @param {TaskStatus} status
 * @param {number} fold
 */
export const ERR_TASK_TERMINAL = (id, status, fold) => {
  switch (status) {
    case 'folded':
      return `${id} is already folded (fold ${fold}); read its summary with fold_recall({ task: "${id}" }).`
    case 'below-floor':
      return `${id} is already closed below the fold floor; its messages stay in the conversation.`
    case 'merged':
    case 'absorbed':
      return `${id} was merged into an earlier task's summary; list folds with fold_recall().`
    case 'failed':
      return `${id} is already closed as failed: its automatic summary failed too often, so its messages stay in the conversation.`
    default:
      // Unreachable: the caller answers by status only for a TERMINAL status (domain/projection.js).
      return `${id} is already closed.`
  }
}
/** The refusal for a task_end that names a task that is closed but still waiting for its fold. */
export const ERR_TASK_WAITING = (/** @type {string} */ id) =>
  `${id} is already closed; it is waiting for its fold.`
export const ERR_BAD_OUTCOME = 'outcome must be done, failed or abandoned.'
export const ERR_UNAVAILABLE = 'task folding is not ready yet; try again.'
export const ERR_NO_EXEC = 'the call arrived without a host execution context.'
