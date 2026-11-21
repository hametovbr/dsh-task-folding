// Reading DeepSeek Harness session journals.
//
// A journal is JSONL, one event per line, compressed as concatenated zstd frames. The first
// line is the session header and has no `seq`. `zlib.zstdDecompressSync` decodes only the
// first frame of a buffer, so a whole-file call silently truncates the log.

import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'

/** @typedef {import('../host/domain/types.js').SessionEvent} SessionEvent */

/**
 * @param {string} path a decoded .jsonl or a raw session.v4.jsonl.zstd
 * @returns {string} the decoded JSONL text
 */
export function readJournalText(path) {
  const raw = readFileSync(path)
  return path.endsWith('.zstd') ? decodeZstd(raw) : raw.toString('utf8')
}

/**
 * Split at frame magics, growing a segment when a magic-looking byte sequence inside a frame
 * produced a truncated piece.
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
export function decodeZstd(buffer) {
  const decompress = /** @type {any} */ (zlib).zstdDecompressSync
  if (typeof decompress !== 'function') throw new Error('this Node build has no zlib.zstdDecompressSync')
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  /** @type {number[]} */
  const starts = []
  for (let at = buffer.indexOf(magic); at !== -1; at = buffer.indexOf(magic, at + 1)) starts.push(at)
  starts.push(buffer.length)
  /** @type {Buffer[]} */
  const out = []
  let i = 0
  while (i < starts.length - 1) {
    let j = i + 1
    for (; j < starts.length; j++) {
      try {
        out.push(decompress(buffer.subarray(starts[i], starts[j])))
        break
      } catch {
        // a false magic inside this frame: extend the segment
      }
    }
    if (j === starts.length) throw new Error(`cannot decode the zstd frame at byte ${starts[i]}`)
    i = j
  }
  return Buffer.concat(out).toString('utf8')
}

/**
 * The events of a journal, in order, without the header line.
 *
 * @param {string} text decoded JSONL
 * @returns {SessionEvent[]}
 */
export function journalEvents(text) {
  /** @type {SessionEvent[]} */
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const parsed = JSON.parse(line)
    if (typeof parsed.seq === 'number') events.push(parsed)
  }
  return events
}
