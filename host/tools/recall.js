// Reading folds back from the log (docs/03 §6.3, docs/04 §1). Pure: no ctx, no I/O, and never a
// full event-log snapshot. Every read resolves a fold row to its summary event's `shadowedSeqs`
// and then to `session.deriveEventMessage`, which costs O(span) and never grows with the log.

import * as texts from '../domain/texts.js'

/** @typedef {import('../domain/types.js').State} State */
/** @typedef {import('../domain/types.js').FoldRow} FoldRow */

/**
 * The part of the host session recall reads (docs/02 §2). `eventAt` returns undefined for a seq
 * that is not in the log; `deriveEventMessage` rebuilds the model-facing message of any event.
 *
 * @typedef {object} RecallSession
 * @property {(seq: number) => any} eventAt
 * @property {(event: any) => any} deriveEventMessage
 */

/** @typedef {{ index: number, row: FoldRow, shadowed: number[] }} ResolvedFold */

/** Index lines per page (docs/04 §1). */
export const INDEX_PAGE_LINES = 200
/** Range cap: messages per call. */
export const RANGE_MAX_MESSAGES = 20
/** Range cap: characters of rendered JSON per call. */
export const RANGE_MAX_CHARS = 40_000
/** Grep cap: hit lines per call. */
export const GREP_MAX_HITS = 50
/** Grep cap: characters of context per hit. */
export const GREP_CONTEXT_CHARS = 200

/**
 * The fold list: one line per row in tree order — roots in log order, each followed by the folds
 * it shadowed, indented two spaces per level (docs/04 §1).
 *
 * @param {State} state
 * @param {RecallSession} session
 * @returns {string}
 */
export function listFolds(state, session) {
  return texts.renderFoldList(foldRows(state, session))
}

/**
 * The span index: one line per shadowed message, `INDEX_PAGE_LINES` per page.
 *
 * @param {State} state
 * @param {RecallSession} session
 * @param {number} ordinal 1-based fold number from the list
 * @param {number} page 1-based index page
 * @returns {string}
 */
export function foldIndex(state, session, ordinal, page = 1) {
  const resolved = resolveFold(state, session, ordinal)
  if (resolved === null) return texts.NOT_FOUND_FOLD(ordinal, state.folds.length)
  const { row, shadowed } = resolved
  const total = shadowed.length
  const pages = Math.max(1, Math.ceil(total / INDEX_PAGE_LINES))
  if (!Number.isInteger(page) || page < 1) return texts.PAGE_INVALID(page)
  if (page > pages) return texts.PAGE_NOT_FOUND(page, total, pages)

  const foldNodes = foldNodeIndex(state)
  const names = toolCallNames(session, shadowed)
  const start = (page - 1) * INDEX_PAGE_LINES
  const end = Math.min(start + INDEX_PAGE_LINES, total)
  /** @type {string[]} */
  const lines = []
  for (let i = start; i < end; i++) {
    const seq = shadowed[i]
    if (seq === undefined) break
    const shadowedFold = foldNodes.get(seq)
    if (shadowedFold !== undefined) {
      const inner = state.folds[shadowedFold]
      lines.push(
        texts.renderIndexLine(
          i + 1,
          texts.renderFoldNodeRef(
            shadowedFold + 1,
            inner ? inner.taskId : null,
            inner && inner.taskId !== null ? titleOf(state, inner.taskId) : null,
          ),
        ),
      )
      continue
    }
    const message = messageAt(session, seq)
    const role = roleOf(session, seq, message)
    lines.push(
      texts.renderIndexLine(
        i + 1,
        texts.renderBrief(role, message, role === 'tool' ? toolNameOf(session, seq, message, names) : null),
      ),
    )
  }
  return [
    texts.renderIndexHeader(resolved.index, row.taskId, titleOf(state, row.taskId), total, page, pages),
    ...lines,
  ].join('\n')
}

/**
 * The exact original messages as JSON lines, at most `RANGE_MAX_MESSAGES` of them and about
 * `RANGE_MAX_CHARS` characters in total. The first requested message is always returned in full:
 * a single message is indivisible, and recall is lossless.
 *
 * @param {State} state
 * @param {RecallSession} session
 * @param {number} ordinal
 * @param {number} from 1-based first line
 * @param {number} to 1-based last line, inclusive
 * @returns {string}
 */
export function foldRange(state, session, ordinal, from, to) {
  const resolved = resolveFold(state, session, ordinal)
  if (resolved === null) return texts.NOT_FOUND_FOLD(ordinal, state.folds.length)
  const { index, shadowed } = resolved
  const total = shadowed.length
  if (!Number.isInteger(from) || !Number.isInteger(to)) return texts.RANGE_NEEDS_BOTH
  if (from > to) return texts.RANGE_BACKWARDS(from, to)
  if (from < 1 || to < 1 || from > total) return texts.RANGE_OUT_OF_BOUNDS(from, to, total)

  const last = Math.min(to, total)
  /** @type {string[]} */
  const lines = []
  let used = 0
  let count = 0
  let truncated = false
  while (from + count <= last) {
    if (count >= RANGE_MAX_MESSAGES) {
      truncated = true
      break
    }
    const seq = shadowed[from + count - 1]
    if (seq === undefined) break
    const line = texts.renderRangeLine(from + count, messageAt(session, seq))
    if (count > 0 && used + line.length + 1 > RANGE_MAX_CHARS) {
      truncated = true
      break
    }
    lines.push(line)
    used += line.length + 1
    count++
  }
  const head = texts.renderRangeHeader(index, from, from + count - 1)
  return truncated ? [head, ...lines, texts.RANGE_TRUNCATED].join('\n') : [head, ...lines].join('\n')
}

/**
 * Matching messages, one hit per message: `L<N>: …context…`, case-insensitive text or `/regex/`.
 *
 * @param {State} state
 * @param {RecallSession} session
 * @param {number} ordinal
 * @param {string} pattern
 * @returns {string}
 */
export function foldGrep(state, session, ordinal, pattern) {
  const resolved = resolveFold(state, session, ordinal)
  if (resolved === null) return texts.NOT_FOUND_FOLD(ordinal, state.folds.length)
  if (pattern.trim() === '') return texts.GREP_EMPTY
  const compiled = compileMatcher(pattern)
  if (!compiled.ok) return texts.BAD_REGEX(pattern, compiled.reason)
  const { index, shadowed } = resolved
  /** @type {{ line: number, text: string, at: number, length: number }[]} */
  const hits = []
  let total = 0
  shadowed.forEach((seq, i) => {
    const text = messageText(messageAt(session, seq))
    if (text === '') return
    const found = compiled.match(text)
    if (found === null) return
    total += 1
    if (hits.length < GREP_MAX_HITS) hits.push({ line: i + 1, text, at: found.index, length: found.length })
  })
  if (total === 0) return texts.renderGrepEmpty(index, pattern)
  const lines = hits.map((hit) => {
    const window = contextAround(hit.text, hit.at, hit.length)
    return texts.renderGrepHit(hit.line, window.context, window.leading, window.trailing)
  })
  const head = texts.renderGrepHeader(index, pattern, total)
  return total > GREP_MAX_HITS
    ? [head, ...lines, texts.GREP_TRUNCATED(hits.length, total)].join('\n')
    : [head, ...lines].join('\n')
}

// ---------------------------------------------------------------------------
// Resolution

/**
 * The fold a 1-based number names, with the seqs it shadowed.
 *
 * @param {State} state
 * @param {RecallSession} session
 * @param {number} ordinal
 * @returns {ResolvedFold | null}
 */
export function resolveFold(state, session, ordinal) {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > state.folds.length) return null
  const row = state.folds[ordinal - 1]
  if (!row) return null
  return { index: ordinal, row, shadowed: shadowedSeqs(session, row) }
}

/**
 * The seqs a fold replaced, in surface order. One `eventAt` read of the summary event costs
 * O(span) and needs no log scan.
 *
 * @param {RecallSession} session
 * @param {FoldRow} row
 * @returns {number[]}
 */
export function shadowedSeqs(session, row) {
  const event = session.eventAt(row.summarySeq)
  const seqs = event && event.data ? event.data.shadowedSeqs : undefined
  if (!Array.isArray(seqs)) return []
  return seqs.filter((seq) => typeof seq === 'number')
}

/**
 * The fold a task id names: the last fold whose row carries that task.
 *
 * @param {State} state
 * @param {string} taskId
 * @returns {number | null} 1-based fold number
 */
export function foldOrdinalForTask(state, taskId) {
  for (let i = state.folds.length - 1; i >= 0; i--) {
    const row = state.folds[i]
    if (row && row.taskId === taskId) return i + 1
  }
  return null
}

// ---------------------------------------------------------------------------
// Tree

/**
 * Parents and depths of the fold tree (docs/03 §6.3). A fold nests under the fold whose shadowed
 * range contains its replacement node; that fold is always later in the log, because the node did
 * not exist when the earlier fold committed, so depths are computed back to front.
 *
 * @param {State} state
 * @param {RecallSession} session
 * @returns {{ parents: (number | null)[], depths: number[] }}
 */
function foldTree(state, session) {
  /** @type {Set<number>} */
  const replacements = new Set()
  for (const row of state.folds) if (row.nodeSeq !== null) replacements.add(row.nodeSeq)
  /** @type {Map<number, number>} replacement seq -> 0-based index of the fold that shadowed it */
  const shadowedBy = new Map()
  state.folds.forEach((row, i) => {
    for (const seq of shadowedSeqs(session, row)) {
      if (replacements.has(seq) && !shadowedBy.has(seq)) shadowedBy.set(seq, i)
    }
  })
  /** @type {(number | null)[]} */
  const parents = state.folds.map(() => null)
  /** @type {number[]} */
  const depths = state.folds.map(() => 0)
  for (let i = state.folds.length - 1; i >= 0; i--) {
    const row = state.folds[i]
    if (!row || row.nodeSeq === null) continue
    const parent = shadowedBy.get(row.nodeSeq)
    if (parent === undefined || parent === i) continue
    parents[i] = parent
    depths[i] = (depths[parent] ?? 0) + 1
  }
  return { parents, depths }
}

/**
 * @param {State} state
 * @param {RecallSession} session
 * @returns {{ index: number, taskId: string | null, title: string | null, count: number, tokens: number, depth: number }[]}
 */
function foldRows(state, session) {
  const { parents, depths } = foldTree(state, session)
  /** @type {number[][]} */
  const children = state.folds.map(() => [])
  /** @type {number[]} */
  const roots = []
  parents.forEach((parent, i) => {
    const siblings = parent === null ? null : children[parent]
    if (siblings === null || siblings === undefined) roots.push(i)
    else siblings.push(i)
  })
  /** @type {number[]} */
  const order = []
  /** @param {number} i */
  const walk = (i) => {
    order.push(i)
    for (const child of children[i] ?? []) walk(child)
  }
  for (const root of roots) walk(root)
  /** @type {{ index: number, taskId: string | null, title: string | null, count: number, tokens: number, depth: number }[]} */
  const rows = []
  for (const i of order) {
    const row = state.folds[i]
    if (!row) continue
    rows.push({
      index: i + 1,
      taskId: row.taskId,
      title: titleOf(state, row.taskId),
      count: row.shadowedCount,
      tokens: row.shadowedTokens,
      depth: depths[i] ?? 0,
    })
  }
  return rows
}

/**
 * @param {State} state
 * @param {string | null} taskId
 * @returns {string | null}
 */
function titleOf(state, taskId) {
  if (taskId === null) return null
  return state.tasks[taskId]?.title ?? null
}

/**
 * Replacement seq -> 0-based index of the fold it belongs to.
 *
 * @param {State} state
 * @returns {Map<number, number>}
 */
function foldNodeIndex(state) {
  /** @type {Map<number, number>} */
  const index = new Map()
  state.folds.forEach((row, i) => {
    if (row.nodeSeq !== null && !index.has(row.nodeSeq)) index.set(row.nodeSeq, i)
  })
  return index
}

// ---------------------------------------------------------------------------
// Messages

/**
 * @param {RecallSession} session
 * @param {number} seq
 * @returns {any}
 */
function messageAt(session, seq) {
  const event = session.eventAt(seq)
  if (!event) return null
  return session.deriveEventMessage(event)
}

/**
 * A result carries no tool name, only the call id of the assistant's tool-call block, so map the
 * calls made inside the fold once (O(span)). Fall back to the result's `tool/call` source event
 * for a result whose assistant message is outside the fold.
 *
 * @param {RecallSession} session
 * @param {readonly number[]} shadowed
 * @returns {Map<string, string>}
 */
export function toolCallNames(session, shadowed) {
  /** @type {Map<string, string>} */
  const names = new Map()
  for (const seq of shadowed) {
    const event = session.eventAt(seq)
    const content = event && event.type === 'assistant/message' ? event.data?.message?.content : undefined
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (
        block &&
        block.type === 'tool-call' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string'
      ) {
        names.set(block.id, block.name)
      }
    }
  }
  return names
}

/**
 * @param {RecallSession} session
 * @param {number} seq
 * @param {any} message
 * @param {Map<string, string>} names
 * @returns {string | null}
 */
function toolNameOf(session, seq, message, names) {
  const callId = message && message.toolCallId
  if (typeof callId === 'string') {
    const known = names.get(callId)
    if (known !== undefined) return known
  }
  const event = session.eventAt(seq)
  const sources = event && Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []
  for (const source of sources) {
    const call = session.eventAt(source)
    if (call && call.type === 'tool/call' && typeof call.data?.name === 'string') return call.data.name
  }
  return null
}

/**
 * The one-line brief of one surface seq, exactly as the fold index renders it (docs/04 §1):
 * `assistant: read src/auth/redirect.ts`, `tool read: 214 lines`.
 *
 * @param {RecallSession} session
 * @param {number} seq
 * @param {Map<string, string>} [names] tool-call id -> name, resolved once with
 *   {@link toolCallNames} over the seqs being rendered
 * @returns {string}
 */
export function briefOfSeq(session, seq, names = new Map()) {
  const message = messageAt(session, seq)
  const role = roleOf(session, seq, message)
  return texts.renderBrief(role, message, role === 'tool' ? toolNameOf(session, seq, message, names) : null)
}

/**
 * @param {RecallSession} session
 * @param {number} seq
 * @param {any} message
 * @returns {string}
 */
function roleOf(session, seq, message) {
  if (message && typeof message.role === 'string') return message.role
  const event = session.eventAt(seq)
  switch (event ? event.type : '') {
    case 'user/message':
      return 'user'
    case 'system/message':
      return 'system'
    case 'assistant/message':
      return 'assistant'
    case 'tool/result':
      return 'tool'
    default:
      return texts.UNKNOWN_ROLE
  }
}

/**
 * The text a grep searches: the textual parts of a derived message, not its JSON framing.
 *
 * @param {any} message
 * @returns {string}
 */
function messageText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  /** @type {string[]} */
  const parts = []
  for (const block of message.content) {
    if (!block || typeof block !== 'object') continue
    if (typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'tool-call') {
      const name = typeof block.name === 'string' ? block.name : ''
      const args = typeof block.arguments === 'string' ? block.arguments : ''
      parts.push(`${name} ${args}`.trim())
    }
  }
  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Grep

/**
 * @typedef {{ ok: true, match: (text: string) => { index: number, length: number } | null }
 *   | { ok: false, reason: string }} Matcher
 */

/**
 * A substring match is case-insensitive; a pattern wrapped in slashes is a JS regex, as written.
 *
 * @param {string} pattern
 * @returns {Matcher}
 */
function compileMatcher(pattern) {
  /** @type {RegExp} */
  let re
  try {
    if (pattern.startsWith('/')) {
      const wrapped = /^\/([\s\S]*)\/([a-z]*)$/.exec(pattern)
      if (wrapped !== null) {
        const source = wrapped[1] ?? ''
        if (source === '') return { ok: false, reason: texts.ERR_EMPTY_REGEX }
        const flags = (wrapped[2] ?? '').replace(/[gy]/g, '')
        re = new RegExp(source, flags)
      } else {
        re = new RegExp(escapeRegExp(pattern), 'i')
      }
    } else {
      re = new RegExp(escapeRegExp(pattern), 'i')
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  const regexp = re
  return {
    ok: true,
    match(text) {
      const found = regexp.exec(text)
      return found === null ? null : { index: found.index, length: found[0].length }
    },
  }
}

/** @param {string} text */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * About `GREP_CONTEXT_CHARS` characters around a match, never more.
 *
 * @param {string} text
 * @param {number} at
 * @param {number} length
 * @returns {{ context: string, leading: boolean, trailing: boolean }}
 */
function contextAround(text, at, length) {
  if (length >= GREP_CONTEXT_CHARS) {
    return {
      context: collapse(text.slice(at, at + GREP_CONTEXT_CHARS)),
      leading: at > 0,
      trailing: true,
    }
  }
  const spare = GREP_CONTEXT_CHARS - length
  const before = Math.floor(spare / 2)
  const start = Math.max(0, at - before)
  const end = Math.min(text.length, at + length + (spare - before))
  return {
    context: collapse(text.slice(start, end)),
    leading: start > 0,
    trailing: end < text.length,
  }
}

/** @param {string} text */
function collapse(text) {
  return text.replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// The fold_recall tool

/**
 * `fold_recall` (docs/04 §1, docs/10 §3): the one tool over the readers above. It is defined in
 * this module because every read it dispatches to lives here; the shared direct-call guard comes in
 * through the deps so this file keeps importing nothing but the texts.
 *
 * @param {import('./index.js').ToolInternals} deps
 * @returns {any} the fold_recall tool definition
 */
export function createRecallTool(deps) {
  return {
    name: 'fold_recall',
    description: texts.FOLD_RECALL_DESCRIPTION,
    // A lookup aid, not the discipline: the prompt section already names the tool, so the host
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: texts.FOLD_RECALL_PARAMS.task },
        fold: { type: 'integer', description: texts.FOLD_RECALL_PARAMS.fold },
        from: { type: 'integer', description: texts.FOLD_RECALL_PARAMS.from },
        to: { type: 'integer', description: texts.FOLD_RECALL_PARAMS.to },
        grep: { type: 'string', description: texts.FOLD_RECALL_PARAMS.grep },
        page: { type: 'integer', description: texts.FOLD_RECALL_PARAMS.page },
      },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      /** @param {any} _args @param {any} value */
      render(_args, value) {
        return [{ type: 'text', text: value.text }]
      },
    },
    /**
     * The dispatch the schema implies (docs/04 §1): no arguments lists the folds; `fold` or `task`
     * picks one; `from`/`to` reads an exact range of it; `grep` searches it. Reads are from the
     * log only, so an unknown fold, an unknown task or a bad pattern is a clean text, not a throw.
     *
     * @param {any} args
     * @param {any} exec
     */
    async execute(args, exec) {
      deps.assertDirect(exec, 'fold_recall')
      const session = exec.agent.session
      const state = await deps.stateOf(session)
      const given = /** @type {Record<string, any>} */ (args && typeof args === 'object' ? args : {})
      /** @param {string} key */
      const option = (key) => (given[key] === undefined || given[key] === null ? undefined : given[key])
      const fold = option('fold')
      const task = option('task')
      const from = option('from')
      const to = option('to')
      const grep = option('grep')
      const page = option('page')

      /** @type {number | null} */
      let ordinal = null
      if (fold !== undefined) {
        if (!Number.isInteger(fold)) return { text: texts.BAD_FOLD_ARG(fold) }
        ordinal = fold
      } else if (task !== undefined) {
        if (typeof task !== 'string') return { text: texts.BAD_TASK_ARG(task) }
        ordinal = foldOrdinalForTask(state, task)
        if (ordinal === null) return { text: texts.NOT_FOUND_TASK(task) }
      }

      if (ordinal === null) {
        const narrows = from !== undefined || to !== undefined || grep !== undefined || page !== undefined
        return { text: narrows ? texts.NEED_FOLD : listFolds(state, session) }
      }
      if (grep !== undefined && (from !== undefined || to !== undefined)) return { text: texts.RANGE_OR_GREP }
      if (from !== undefined || to !== undefined) {
        if (!Number.isInteger(from) || !Number.isInteger(to)) return { text: texts.RANGE_NEEDS_BOTH }
        return { text: foldRange(state, session, ordinal, from, to) }
      }
      if (grep !== undefined) {
        if (typeof grep !== 'string') return { text: texts.BAD_GREP_ARG(grep) }
        return { text: foldGrep(state, session, ordinal, grep) }
      }
      if (page !== undefined && !Number.isInteger(page)) return { text: texts.PAGE_INVALID(page) }
      return { text: foldIndex(state, session, ordinal, page === undefined ? 1 : page) }
    },
  }
}
