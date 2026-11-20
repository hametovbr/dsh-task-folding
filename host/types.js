// Shared JSDoc types. This module has no runtime content.

/**
 * @typedef {{ op: 'replace', startSeq: number, endSeq: number }} ReplaceOp
 * @typedef {'append' | ReplaceOp} SurfaceOp
 */

/**
 * The subset of a DeepSeek Harness session event the plugin reads.
 * See docs/02-host-api.md §2 for the shapes per event type.
 *
 * @typedef {object} SessionEvent
 * @property {string} type
 * @property {number} seq
 * @property {any} [data]
 * @property {SurfaceOp} [surfaceOp]
 * @property {number[]} [sourceEventSeqs]
 */

/**
 * Durable payloads written by the tools into `tool/result.data.meta`.
 *
 * @typedef {{ tf: 1, op: 'begin', id: string, title: string, parent: string | null }} BeginMeta
 * @typedef {'queued' | 'delegate' | 'below-floor' | 'absorbed'} EndVerdict
 * @typedef {'done' | 'failed' | 'abandoned'} Outcome
 * @typedef {{
 *   tf: 1, op: 'end', id: string, merged: string[], verdict: EndVerdict, outcome: Outcome,
 *   estTokens: number, summaryChars: number, callId: string
 * }} EndMeta
 */

/**
 * @typedef {'opening' | 'open' | 'closing' | 'queued' | 'delegate'
 *   | 'below-floor' | 'merged' | 'folded' | 'absorbed' | 'failed'} TaskStatus
 */

/**
 * A cut is stored as the seq of the surface node it follows. ABSORBED (-1) means the boundary
 * no longer exists on the surface; null means it is not known yet.
 *
 * @typedef {object} Task
 * @property {string} id
 * @property {string} title
 * @property {string | null} parent
 * @property {number} depth
 * @property {TaskStatus} status
 * @property {number | null} beginCut  last node of the begin batch
 * @property {number | null} spanStart first surface node after the begin batch
 * @property {number | null} endCut    last node of the end batch
 * @property {number | null} endMsgSeq assistant/message that carried task_end
 * @property {string | null} endCallId
 * @property {EndVerdict | null} verdict verdict from task_end, applied when the end batch closes
 * @property {Outcome | null} outcome
 * @property {number} estTokens
 * @property {number} summaryChars
 * @property {number} openedAt   assistantCount when the begin batch closed
 * @property {boolean} reported  an assistant/message arrived after the end batch closed
 * @property {number} failures   compaction failures observed while waiting as 'delegate'
 * @property {number | null} foldIndex index into State.folds once folded
 */

/**
 * @typedef {object} Batch
 * @property {number} msgSeq
 * @property {string[]} waiting call ids without a result yet
 * @property {number} last      seq of the last node of the batch so far
 * @property {string[]} begins  task ids begun in this batch
 * @property {string[]} ends    task ids (plus merged descendants) closed in this batch
 */

/**
 * @typedef {object} FoldRow
 * @property {number} summarySeq the compaction/summary event
 * @property {number | null} nodeSeq the replacement user/message
 * @property {string | null} taskId set when the replacement exactly covers a waiting task's span
 * @property {number} shadowedCount
 * @property {number} shadowedTokens
 */

/**
 * @typedef {object} State
 * @property {number} nextId
 * @property {string[]} open stack, outermost first
 * @property {Record<string, Task>} tasks
 * @property {string[]} order task ids in creation order
 * @property {Batch | null} batch
 * @property {number} assistantCount
 * @property {FoldRow[]} folds
 * @property {number | null} pendingSummary index of a FoldRow waiting for its replacement
 * @property {string | null} hintKey
 * @property {number | null} lastHeaderSeq
 */

/**
 * @typedef {{ id: string, title: string, depth: number }} ViewOpen
 * @typedef {{ id: string, title: string }} ViewFolding
 * @typedef {{ id: string, title: string, status: TaskStatus }} ViewRecent
 * @typedef {{ open: ViewOpen[], folding: ViewFolding[], recent: ViewRecent[] }} View
 */

export {}
