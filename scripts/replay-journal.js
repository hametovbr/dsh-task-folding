#!/usr/bin/env node
// Replay a DeepSeek Harness session journal through the taskFolding projection and print the
// resulting state (or the wire view). Accepts a decoded .jsonl file or the raw
// session.v4.jsonl.zstd (concatenated zstd frames; needs a Node build with zstd support).
//
//   node scripts/replay-journal.js <journal> [--view] [--events]

import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'

import { apply, initialState, view } from '../host/projection.js'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
if (!file) {
  console.error(
    'usage: node scripts/replay-journal.js <journal.jsonl|session.v4.jsonl.zstd> [--view] [--events]',
  )
  process.exit(2)
}

const text = file.endsWith('.zstd') ? decodeZstd(readFileSync(file)) : readFileSync(file, 'utf8')
const events = text
  .split('\n')
  .filter((/** @type {string} */ line) => line.trim() !== '')
  .map((/** @type {string} */ line) => JSON.parse(line))
  .filter((/** @type {any} */ e) => typeof e.seq === 'number')

let state = initialState()
for (const event of events) {
  const next = apply(state, event)
  if (args.includes('--events') && next !== state) console.log(`${event.seq} ${event.type}`)
  state = next
}
console.log(JSON.stringify(args.includes('--view') ? view(state) : state, null, 2))

/**
 * DSH journals are concatenated zstd frames, and zstdDecompressSync decodes only the first
 * frame of a buffer. Split at frame magics, growing a segment when a magic-looking byte
 * sequence inside a frame produced a truncated piece.
 *
 * @param {Buffer} buffer
 */
function decodeZstd(buffer) {
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
