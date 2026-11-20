#!/usr/bin/env node
// Replay a DeepSeek Harness session journal through the taskFolding projection and print the
// resulting state (or the wire view). Accepts a decoded .jsonl file or the raw
// session.v4.jsonl.zstd (concatenated zstd frames; needs a Node build with zstd support).
//
//   node scripts/replay-journal.js <journal> [--view] [--events] [--decode]

import { readJournalText, journalEvents } from './journal.js'

import { apply, initialState, view } from '../host/projection.js'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
if (!file) {
  console.error(
    'usage: node scripts/replay-journal.js <journal.jsonl|session.v4.jsonl.zstd> [--view] [--events] [--decode]',
  )
  process.exit(2)
}

const text = readJournalText(file)
if (args.includes('--decode')) {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
  process.exit(0)
}

const events = journalEvents(text)

let state = initialState()
for (const event of events) {
  const next = apply(state, event)
  if (args.includes('--events') && next !== state) console.log(`${event.seq} ${event.type}`)
  state = next
}
console.log(JSON.stringify(args.includes('--view') ? view(state) : state, null, 2))
