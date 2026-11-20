// Loader for decoded DeepSeek Harness session journals (one JSON event per line; the first
// line is the session header and has no seq). The M0 captures live in m0/sessions/.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** @typedef {import('../../host/types.js').SessionEvent} SessionEvent */

export const M0_SESSIONS = fileURLToPath(new URL('../../m0/sessions/', import.meta.url))

/** @returns {string[]} */
export function journalNames() {
  return readdirSync(M0_SESSIONS)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
}

/**
 * @param {string} name
 * @returns {SessionEvent[]}
 */
export function loadJournal(name) {
  /** @type {SessionEvent[]} */
  const events = []
  for (const line of readFileSync(join(M0_SESSIONS, name), 'utf8').split('\n')) {
    if (line.trim() === '') continue
    const parsed = JSON.parse(line)
    if (typeof parsed.seq === 'number') events.push(parsed)
  }
  return events
}
