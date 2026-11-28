#!/usr/bin/env node
// Offline compatibility probe for docs/adr/0009-fold-keeps-user-text.md: what does dsh-advisor's
// reviewer actually see after a task-folding fold, and does its anti-repeat state survive the
// rewrite? It imports the INSTALLED advisor package and calls no model, so it costs nothing and
// never touches the network.
//
// Why the probe lives in this repository: the ADR decides that plugin-authored text is referenced
// from a fold node instead of quoted back into the surface, and that decision rests on measured
// behaviour of the reviewer — a fold node is re-read as an ordinary user message, the reviewer's
// own notes are filtered by `source.kind`, and every rewrite clears the guard that suppresses a
// repeated note. An untracked scratch script cannot support that.
//
// Usage: npm run probe:advisor            # looks the package up under $DSH_HOME (default ~/.dsh)
//        node scripts/advisor-compat-probe.mjs /path/to/node_modules/dsh-advisor
// Exits 0 when every check passes, 1 when one fails, 2 when the package cannot be found.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** @param {string} p @returns {boolean} */
const isDir = (p) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * The advisor ships as a profile bundle, so the installed copy lives under the DSH home rather than
 * under this repository's node_modules. Profiles are enumerated because the bundle is mounted per
 * profile and the name is not fixed.
 *
 * @param {string | undefined} explicit a package directory passed on the command line
 * @returns {string} the package root that carries lib/transcript.js
 */
function locate(explicit) {
  if (explicit !== undefined) {
    if (!isDir(join(explicit, 'lib'))) throw new Error(`${explicit} has no lib/ directory`)
    return explicit
  }
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const profiles = join(home, 'profiles')
  const names = (() => {
    try {
      return readdirSync(profiles)
    } catch {
      throw new Error(`no profiles directory at ${profiles}`)
    }
  })()
  for (const name of names) {
    const candidate = join(profiles, name, 'node_modules', 'dsh-advisor')
    if (isDir(join(candidate, 'lib'))) return candidate
  }
  throw new Error(`dsh-advisor is not installed under ${profiles}/*/node_modules`)
}

const PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it.'

/**
 * The synthetic fold: one user turn, the assistant claim the user asked about, then the checkpoint
 * task-folding commits — a single user message whose surfaceOp replaces both, whose body is the host
 * preamble, the summary and the pinned plugin text. This is the shape read off the host's compaction
 * transaction, not a guess (host/ports/compaction-shim.js).
 *
 * @param {string} pin the plugin-text section the fold would carry
 * @returns {readonly object[]}
 */
function foldedSession(pin) {
  /** @param {number} seq @param {string} id @param {object[]} content */
  const assistant = (seq, id, content) => ({
    type: 'assistant/message',
    seq,
    data: { turn: 1, step: seq, message: { id, role: 'assistant', source: { kind: 'model' }, content } },
    surfaceOp: 'append',
  })
  return [
    { type: 'session', seq: 0, data: { session: 1 } },
    {
      type: 'user/message',
      seq: 1,
      data: {
        id: 'u1',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Check whether the bot can download an X video.' }],
      },
      surfaceOp: 'append',
    },
    assistant(2, 'a1', [
      { type: 'text', text: 'X works: tweet 1672185710151958529 downloads fine.' },
      { type: 'tool-call', name: 'web_fetch', arguments: '{"url":"https://xcancel.com/NASA"}' },
    ]),
    {
      type: 'user/message',
      seq: 3,
      data: {
        id: 'ck1',
        role: 'user',
        content: [
          { type: 'text', text: PREAMBLE },
          { type: 'text', text: '# T1 · X download\n## Done\nRe-verified on fresh tweets.' },
          { type: 'text', text: pin },
          { type: 'text', text: '</compacted-summary>' },
        ],
        source: { kind: 'compact-checkpoint', compactionId: 'c-1' },
      },
      sourceEventSeqs: [1, 2],
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 },
    },
    assistant(4, 'a2', [{ type: 'text', text: 'Done.' }]),
  ]
}

/** The marker only the quoted variant carries; the reference variant must not. */
const SEED = '1672185710151958529'

/** What a fold node would carry if it quoted the reviewer's note back into the surface. */
const QUOTED = [
  '## User messages, verbatim (folded)',
  `> [advisor:concern · seq 2] Re-check the X claim: the only evidence is the old tweet ${SEED}. Verify on 2-3 fresh video tweets before promising support.`,
].join('\n')

/** What the ADR decides instead: the note is named, its text stays behind fold_recall. */
const REFERENCED = [
  '## Folded inbound messages (references)',
  '> [advisor:concern · seq 2] folded into this node; the text is in fold_recall({ task: "T1" })',
].join('\n')

const root = (() => {
  try {
    return locate(process.argv[2])
  } catch (error) {
    console.error(`advisor-compat-probe: ${error.message}`)
    console.error(
      'Install the advisor bundle in a DSH profile, or pass its package directory as the argument.',
    )
    process.exit(2)
  }
})()

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const lib = (name) => pathToFileURL(join(root, 'lib', `${name}.js`)).href
const { DeltaRenderer } = await import(lib('transcript'))
const { EmissionGuard } = await import(lib('emission-guard'))
const { isAdvisorMessage } = await import(lib('kinds'))

/**
 * @param {string} pin
 * @returns {string} the reviewer's input after the fold
 */
function review(pin) {
  const renderer = new DeltaRenderer({ maxDeltaMessages: 60 })
  const events = foldedSession(pin)
  renderer.update(events.slice(0, 3))
  const delta = renderer.update(events)
  return String(typeof delta === 'string' ? delta : (delta.markdown ?? ''))
}

const quoted = review(QUOTED)
const referenced = review(REFERENCED)

console.log(`advisor-compat-probe: dsh-advisor ${version}`)
console.log(`  package: ${root}`)
console.log('  input:   one fold transaction (user turn + assistant claim -> one checkpoint)')
console.log('')
console.log('--- reviewer input, quoted variant ---')
for (const line of quoted.split('\n')) console.log(line.length > 200 ? `${line.slice(0, 200)}…` : line)
console.log('--- reviewer input, referenced variant (fold node only) ---')
for (const line of referenced.split('\n').slice(0, 8))
  console.log(line.length > 200 ? `${line.slice(0, 200)}…` : line)
console.log('--- checks ---')

/** @type {[string, boolean, string][]} */
const checks = []
/** @param {string} name @param {boolean} ok @param {string} detail */
const pass = (name, ok, detail) => checks.push([name, ok, detail])

const at = quoted.indexOf(`tweet ${SEED}`)
pass(
  'a quoted note reaches the reviewer verbatim',
  at >= 0,
  at >= 0 ? `"tweet ${SEED}" found at column ${at}` : 'not found',
)

const userBefore = at < 0 ? -1 : quoted.lastIndexOf('**user**', at)
const assistantBefore = at < 0 ? -1 : quoted.lastIndexOf('**assistant**', at)
pass(
  'and is read as the user speaking: no role marker separates it from the checkpoint',
  userBefore > assistantBefore,
  `nearest role marker before it: **user** (${userBefore}) vs **assistant** (${assistantBefore})`,
)

pass(
  'the reference form reaches the reviewer without the note text',
  referenced.includes('[advisor:concern · seq 2]') && !referenced.includes(`tweet ${SEED}`),
  `label present, text ${referenced.includes(`tweet ${SEED}`) ? 'LEAKED' : 'absent'}`,
)

pass(
  'the checkpoint is not an advisor message, so the reviewer filters do not apply to it',
  isAdvisorMessage({ source: { kind: 'compact-checkpoint' } }) === false,
  'isAdvisorMessage({ source: { kind: "compact-checkpoint" } }) === false',
)

const guard = new EmissionGuard()
const note = {
  note: 'The X evidence is one stale tweet; verify on 2-3 fresh video tweets',
  severity: 'concern',
}
guard.beginUpdate()
const first = guard.accept({ ...note })
guard.beginUpdate()
const repeat = guard.accept({ ...note })
guard.reset()
guard.beginUpdate()
const afterReset = guard.accept({ ...note })
pass(
  'a rewrite (what every fold is) clears the anti-repeat history',
  first === true && repeat === false && afterReset === true,
  `accepted=${first} suppressed=${repeat} accepted-after-reset=${afterReset}`,
)

let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  console.log(`      ${detail}`)
}
console.log('')
console.log(`${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
