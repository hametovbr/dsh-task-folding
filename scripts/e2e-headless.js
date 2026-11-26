#!/usr/bin/env node
// Headless E2E for the server half (docs/09-testing-plan.md T5): a scripted session against a
// scratch DSH home proves that the plugin, mounted through a profile the way a user mounts it,
// opens a task, folds it, returns the originals on demand — and that the fold does not cost
// provider cache hits (docs/03 §12 invariant 9, the priority of docs/07 Q12).
//
//   node scripts/e2e-headless.js [--scenario self|delegate|both] [--keep]
//
// Two scenarios, because the two fold paths are different code:
//   self      the model's own summary fits, so the plugin commits it without an LLM call;
//   delegate  the summary the model writes is below `minSummaryChars`, so the plugin has to
//             generate one in the background — the path that spends tokens and that
//             scripts/verify-cache.js exists for.
//
// One process per turn, the recipe of docs/02 §11: `dsh --profile <p> --json "<task>"`, resumed
// with `--session-id`. The script asserts the NDJSON stream (which tools the model called) and the
// session journal (what the plugin committed), then re-checks the journal with the existing
// scripts/eval-report.js and scripts/verify-cache.js instead of inventing a second metric.
//
// Nothing in `~/.dsh` is written; the credentials file is copied into the scratch home because the
// shipped headless template disables the managed credential store (m0/commands.md §2). The scratch
// home lives under `.tmp/` and is wiped at the start of a run unless --keep is given.

import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { apply, initialState } from '../host/domain/projection.js'
import { PROMPT_SECTION } from '../host/domain/texts.js'
import { analyzeSession } from './eval-report.js'
import { journalEvents, readJournalText } from './journal.js'
import { analyzeJournal, judgeJournal } from './verify-cache.js'

/** @typedef {import('../host/domain/types.js').SessionEvent} SessionEvent */

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
/** The one package name the profile manifest carries for this plugin. */
const PLUGIN_PACKAGE = 'dsh-task-folding'
/** The task tools the live roster must contain (docs/04 §2). */
const TASK_TOOLS = ['task_begin', 'task_end', 'fold_recall']
/** A read result proves nothing about the span; two reads clear `minSpanTokens` (docs/09 T5). */
const READ_CALLS = 2
/** Each scenario is a profile of the scratch home, with the settings that force its fold path. */
const SCENARIOS = Object.freeze({
  self: {
    profile: 'e2e-self',
    config: { minSpanTokens: 2000 },
    summary: 'the model writes a summary that fits',
  },
  delegate: {
    profile: 'e2e-delegate',
    config: { minSpanTokens: 2000, minSummaryChars: 3000 },
    summary: 'the model summary is below the floor, so the plugin generates one',
  },
})
/** First content lines of the two scripted files: they exist only inside the originals. */
const NOTES_MARKERS = ['Line 1 of notes-a.md', 'Line 1 of notes-b.md']
const NOTES_LINES = 150
/**
 * A turn that lasts long enough for a background delegate generation to finish before its process
 * exits, and stays small enough that the implicit turn fold has nothing to fold (docs/07 Q10): the
 * plugin commits a generated summary at the next boundary, so a two-second turn gives it no room.
 */
const KEEPALIVE_PROMPT = 'Use the bash tool to run `sleep 12`, then reply with exactly: keepalive.'
const DEFAULT_TIMEOUT_MS = 240_000
const DEFAULT_KEEPALIVE_TURNS = 3
/** The provider floor of docs/03 §12 invariant 9, the same default scripts/verify-cache.js uses. */
const MIN_CACHE_RATIO = 0.8

const USAGE = `Usage: node scripts/e2e-headless.js [options]

Runs the scripted session (task → fold → recall) against a scratch DSH home and asserts the
journal. Exits 0 when every check passes, 1 when one fails, 2 on a usage error.

Options:
  --scenario <name>     self, delegate, or both (default: both)
  --home <path>         scratch DSH home (default: <repo>/.tmp/e2e-headless/dsh-home)
  --work <path>         working directory of the scripted session (default: <repo>/.tmp/e2e-headless/work)
  --plugin <spec>       what \`dsh plugin add\` installs (default: this checkout; pass
                        dsh-task-folding@<version> to check a published release)
  --dsh <path>          dsh executable (default: DSH_BIN, then dsh on PATH)
  --credentials <path>  credentials file to copy into the scratch home
                        (default: ~/.dsh/.credentials.yaml; DEEPSEEK_API_KEY is used when it is absent)
  --timeout <ms>        per-turn timeout (default: ${DEFAULT_TIMEOUT_MS})
  --keepalive <n>       extra turns allowed while a queued fold generates (default: ${DEFAULT_KEEPALIVE_TURNS})
  --keep                keep the scratch home instead of wiping it at the start
  --help                show this text`

/** A usage error: the caller's flags, not the system under test. */
class UsageError extends Error {}

/**
 * Everything one run needs; resolved once and read by every step.
 * @typedef {object} Context
 * @property {string} dsh
 * @property {string} scratch
 * @property {string} home
 * @property {string} work
 * @property {string} logs
 * @property {string} plugin
 * @property {string} credentials
 * @property {number} timeoutMs
 * @property {number} keepalive
 * @property {boolean} keep
 * @property {'self' | 'delegate' | 'both'} scenario
 * @property {'file' | 'env'} [auth] where the model key comes from (set before any scenario)
 */

// ---------------------------------------------------------------------------
// Parsing the two inputs: the NDJSON turn stream and the session journal

/**
 * Parse a `--json` turn stream. A torn last line is tolerated: the stream is written while the
 * process runs, and a killed turn may leave half an object.
 *
 * @param {string} text
 * @returns {Record<string, any>[]}
 */
export function parseNdjson(text) {
  /** @type {Record<string, any>[]} */
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line)
      if (typeof parsed === 'object' && parsed !== null) events.push(parsed)
    } catch {
      // a torn line from a killed turn: the rest of the stream is still worth reading
    }
  }
  return events
}

/**
 * What one turn said about itself: the session it belongs to, the tools the model called, and how
 * the turn ended.
 *
 * @param {string} text the NDJSON stream of one `dsh --json` invocation
 */
export function summarizeTurn(text) {
  const events = parseNdjson(text)
  const session = events.find((event) => event.type === 'session')
  const final = events.find((event) => event.type === 'final') ?? null
  /** @type {{ name: string, args: string }[]} */
  const calls = []
  for (const event of events) {
    if (event.type !== 'tool_call') continue
    calls.push({ name: typeof event.tool === 'string' ? event.tool : '', args: JSON.stringify(event.input) })
  }
  const reason =
    final !== null && typeof final.reason === 'object' && final.reason !== null ? final.reason : null
  const failure = reason !== null && isRecord(reason.error) ? reason.error.message : null
  return {
    sessionId: session !== undefined && typeof session.sessionId === 'string' ? session.sessionId : null,
    calls,
    text: final !== null && typeof final.text === 'string' ? final.text : '',
    kind: reason !== null && typeof reason.kind === 'string' ? reason.kind : null,
    // The host's own message ("Authentication Fails, Your api key ... is invalid"), because a turn
    // that dies on a missing key or a broken route otherwise reads as a model that ignored the
    // script, and the only witness would be the uploaded artifact.
    error: typeof failure === 'string' ? failure : null,
    completed: reason !== null && reason.kind === 'completed',
  }
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null
}

/**
 * The text of a message's content blocks, joined. Tool results and messages both carry an array.
 *
 * @param {unknown} content
 * @returns {string}
 */
function blocksText(content) {
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) if (isRecord(block) && typeof block.text === 'string') text += block.text
  return text
}

/**
 * Everything a check needs from the journal, derived once: the replayed projection plus the rows
 * the projection does not keep (tool roster, replacements, summaries, recall results).
 *
 * @param {readonly SessionEvent[]} events
 */
export function inspectJournal(events) {
  let state = initialState()
  for (const event of events) state = apply(state, event)
  /** @type {string[]} */
  const tools = []
  let systemText = ''
  /** @type {{ seq: number, startSeq: number, endSeq: number }[]} */
  const replacements = []
  /** @type {{ seq: number, source: 'self' | 'delegate', usage: Record<string, any> | null, shadowedTokens: number, shadowedCount: number }[]} */
  const summaries = []
  /** @type {{ seq: number, args: string, text: string }[]} */
  const recalls = []
  /** @type {{ seq: number, tool: string }[]} */
  const rejected = []
  /** @type {Map<string, { name: string, args: string }>} */
  const calls = new Map()
  /** @type {string | null} */
  let verdict = null
  for (const event of events) {
    const data = isRecord(event.data) ? event.data : {}
    if (event.type === 'request/header' && tools.length === 0 && isRecord(data.header)) {
      const list = data.header.tools
      if (Array.isArray(list)) {
        for (const tool of list) if (isRecord(tool) && typeof tool.name === 'string') tools.push(tool.name)
      }
    }
    if (event.type === 'system/message' && systemText === '' && isRecord(data.message)) {
      systemText = blocksText(data.message.content)
    }
    const op = event.surfaceOp
    if (
      isRecord(op) &&
      op.op === 'replace' &&
      typeof op.startSeq === 'number' &&
      typeof op.endSeq === 'number'
    ) {
      replacements.push({ seq: event.seq, startSeq: op.startSeq, endSeq: op.endSeq })
    }
    if (event.type === 'compaction/summary') {
      const usage = isRecord(data.usage) ? data.usage : null
      summaries.push({
        seq: event.seq,
        source: usage === null ? 'self' : 'delegate',
        usage,
        shadowedTokens: typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : 0,
        shadowedCount: Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : 0,
      })
    }
    if (event.type === 'tool/call' && typeof data.callId === 'string' && typeof data.name === 'string') {
      calls.set(data.callId, {
        name: data.name,
        args: typeof data.arguments === 'string' ? data.arguments : '',
      })
    }
    if (event.type !== 'tool/result') continue
    // A task_end result carries the verdict the plugin decided; the profile config is only
    // proven to have reached the plugin if the verdict matches the scenario.
    if (isRecord(data.meta) && data.meta.op === 'end' && typeof data.meta.verdict === 'string') {
      verdict = data.meta.verdict
    }
    if (!isRecord(data.message)) continue
    const callId = data.message.toolCallId
    const call = typeof callId === 'string' ? calls.get(callId) : undefined
    if (call === undefined) continue
    if (data.message.isError === true && TASK_TOOLS.includes(call.name))
      rejected.push({ seq: event.seq, tool: call.name })
    if (call.name === 'fold_recall') {
      recalls.push({ seq: event.seq, args: call.args, text: blocksText(data.message.content) })
    }
  }
  return { state, tools, systemText, replacements, summaries, recalls, rejected, verdict }
}

// ---------------------------------------------------------------------------
// The checks

/**
 * @param {number | null | undefined} value
 * @returns {string}
 */
function percent(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'n/a'
}

/**
 * Assert one scenario's evidence. Pure over what the run produced, so the recorded fixtures of
 * test/e2e-headless.test.js exercise exactly the checks a live run does.
 *
 * @param {object} input
 * @param {'self' | 'delegate'} input.scenario
 * @param {ReturnType<typeof summarizeTurn>} input.first the turn that opened and closed the task
 * @param {ReturnType<typeof summarizeTurn>} input.recall the turn that asked for the originals
 * @param {ReturnType<typeof inspectJournal>} input.journal
 * @param {ReturnType<typeof judgeJournal>} input.cache
 * @param {ReturnType<typeof analyzeSession>} input.report
 * @param {{ minSpanTokens: number }} input.settings
 * @returns {{ name: string, ok: boolean, detail: string }[]}
 */
export function judge(input) {
  const { scenario, first, recall, journal, cache, report, settings } = input
  /** @type {{ name: string, ok: boolean, detail: string }[]} */
  const checks = []
  /** @param {string} name @param {unknown} ok @param {string} detail */
  const check = (name, ok, detail) => checks.push({ name, ok: ok === true, detail })
  const called = first.calls.map((call) => call.name)

  check('the first turn completed', first.completed, `final reason: ${first.kind ?? 'none'}`)
  check('the model opened a task', called.includes('task_begin'), `calls: ${called.join(', ') || 'none'}`)
  check(
    `the model read ${READ_CALLS} files inside the span`,
    called.filter((name) => name === 'read').length >= READ_CALLS,
    `${called.filter((name) => name === 'read').length} read call(s)`,
  )
  check('the model closed the task', called.includes('task_end'), `calls: ${called.join(', ') || 'none'}`)
  check('the recall turn completed', recall.completed, `final reason: ${recall.kind ?? 'none'}`)

  check(
    'the three task tools are in the live roster',
    TASK_TOOLS.every((name) => journal.tools.includes(name)),
    `roster: ${journal.tools.join(', ') || 'none'}`,
  )
  check(
    'the prompt section is mounted',
    journal.systemText.includes(PROMPT_SECTION.slice(0, 60)),
    `${journal.systemText.length} characters of system message`,
  )

  const expected = scenario === 'delegate' ? 'delegate' : 'queued'
  check(
    'the profile config reached the plugin',
    journal.verdict === expected,
    `task_end verdict: ${journal.verdict ?? 'none'}, expected ${expected}`,
  )

  /** @type {import('../host/domain/types.js').Task[]} */
  const tasks = []
  for (const id of journal.state.order) {
    const task = journal.state.tasks[id]
    if (task !== undefined) tasks.push(task)
  }
  const task = tasks[0] ?? null
  check(
    'the task ended folded',
    task !== null && task.status === 'folded',
    `status: ${task?.status ?? 'none'}`,
  )

  const rows = task === null ? [] : journal.state.folds.filter((row) => row.taskId === task.id)
  check(
    'one fold row names the task',
    rows.length === 1,
    `${rows.length} row(s) name ${task?.id ?? 'no task'}`,
  )
  const row = rows[0] ?? null
  check(
    'the fold row became a surface node',
    row !== null && row.nodeSeq !== null,
    `nodeSeq: ${row?.nodeSeq ?? 'none'}`,
  )
  check(
    `the folded span cleared the ${settings.minSpanTokens}-token floor`,
    (row?.shadowedTokens ?? 0) >= settings.minSpanTokens,
    `${row?.shadowedTokens ?? 0} tokens over ${row?.shadowedCount ?? 0} node(s)`,
  )
  const replacement = row === null ? undefined : journal.replacements.find((item) => item.seq === row.nodeSeq)
  check(
    'the replacement covers the task span exactly',
    replacement !== undefined &&
      replacement.startSeq === task?.spanStart &&
      replacement.endSeq === task?.endCut,
    `replacement ${replacement?.startSeq ?? 'none'}..${replacement?.endSeq ?? 'none'}, ` +
      `span ${task?.spanStart ?? 'none'}..${task?.endCut ?? 'none'}`,
  )

  const summary = row === null ? undefined : journal.summaries.find((item) => item.seq === row.summarySeq)
  if (scenario === 'delegate') {
    check(
      'the fold is a delegate fold',
      summary?.source === 'delegate',
      `source: ${summary?.source ?? 'none'}`,
    )
    const cached = summary?.usage?.cacheReadTokens
    check(
      'the delegate request replayed the session prefix',
      typeof cached === 'number' && cached > 0,
      `${cached ?? 0} cached tokens, ${summary?.usage?.inputTokens ?? 0} fresh`,
    )
    check(
      'the cache-hit check passes',
      cache.ok && cache.checked >= 1,
      `${cache.checked} checked, worst ${percent(cache.worstRatio)} vs median ${percent(cache.medianRatio)}`,
    )
  } else {
    check('the fold is a self fold', summary?.source === 'self', `source: ${summary?.source ?? 'none'}`)
    check(
      'no LLM request is counted against the cache',
      cache.ok && cache.checked === 0,
      `${cache.checked} checked summary(-ies), floor ${percent(MIN_CACHE_RATIO)}`,
    )
  }

  const recalled = journal.recalls.map((item) => item.text).join('\n')
  const missing = NOTES_MARKERS.filter((marker) => !recalled.includes(marker))
  check(
    'fold_recall returned the originals',
    journal.recalls.length > 0 && missing.length === 0,
    `${journal.recalls.length} call(s); missing ${missing.join(', ') || 'nothing'}`,
  )
  check(
    'the recall came after the fold',
    row !== null && journal.recalls.some((item) => item.seq > row.summarySeq),
    `first recall at ${journal.recalls[0]?.seq ?? 'none'}, summary at ${row?.summarySeq ?? 'none'}`,
  )
  check(
    'no task-tool call was rejected',
    journal.rejected.length === 0,
    journal.rejected.map((item) => `${item.tool}@${item.seq}`).join(', ') || 'none',
  )

  check(
    'eval-report agrees with the projection',
    report.folds.count === 1 &&
      (scenario === 'delegate' ? report.folds.delegate === 1 : report.folds.self === 1),
    `${report.folds.count} fold(s), self ${report.folds.self}, delegate ${report.folds.delegate}`,
  )
  check(
    'eval-report counts the folded task',
    report.folds.verdicts.folded === 1,
    JSON.stringify(report.folds.verdicts),
  )
  check(
    'eval-report counts no rejection',
    report.rejectedCalls.count === 0,
    `${report.rejectedCalls.count} rejected`,
  )
  check('eval-report sees the recall', report.recall.calls >= 1, `${report.recall.calls} recall call(s)`)
  return checks
}

// ---------------------------------------------------------------------------
// Running one `dsh` process

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {{ cwd: string, env: Record<string, string | undefined>, timeoutMs: number }} options
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, timedOut: boolean }>}
 */
function run(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)
    child.stdout?.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: `${stderr}${String(error)}`, timedOut })
    })
  })
}

/** @param {Context} context @returns {Record<string, string | undefined>} */
function childEnv(context) {
  const env = { ...process.env, DSH_HOME: context.home }
  // pnpm's store and XDG directories must stay inside the scratch tree: a run may not write
  // outside it, and a read-only HOME would otherwise fail the install (m0/commands.md §2).
  return {
    ...env,
    npm_config_store_dir: path.join(context.scratch, 'pnpm-store'),
    XDG_CACHE_HOME: path.join(context.scratch, 'xdg/cache'),
    XDG_CONFIG_HOME: path.join(context.scratch, 'xdg/config'),
    XDG_DATA_HOME: path.join(context.scratch, 'xdg/data'),
    XDG_STATE_HOME: path.join(context.scratch, 'xdg/state'),
  }
}

/**
 * Run one turn of the scripted session and keep its stream and stderr on disk for diagnosis.
 *
 * @param {Context} context
 * @param {{ profile: string, prompt: string, sessionId: string | null, label: string }} turn
 * @returns {Promise<ReturnType<typeof summarizeTurn> & { stderr: string, code: number | null, timedOut: boolean }>}
 */
async function runTurn(context, turn) {
  const args = ['--profile', turn.profile, '--json']
  if (turn.sessionId !== null) args.push('--session-id', turn.sessionId)
  args.push(turn.prompt)
  const result = await run(context.dsh, args, {
    cwd: context.work,
    env: childEnv(context),
    timeoutMs: context.timeoutMs,
  })
  writeFileSync(path.join(context.logs, `${turn.label}.json`), result.stdout)
  writeFileSync(path.join(context.logs, `${turn.label}.err`), result.stderr)
  return {
    ...summarizeTurn(result.stdout),
    stderr: result.stderr,
    code: result.code,
    timedOut: result.timedOut,
  }
}

/**
 * @param {Context} context
 * @param {string} profile
 * @returns {Promise<{ created: boolean }>}
 */
async function ensureProfile(context, profile) {
  const dir = path.join(context.home, 'profiles', profile)
  if (existsSync(path.join(dir, 'package.json'))) return { created: false }
  mkdirSync(path.join(context.home, 'profiles'), { recursive: true })
  const result = await run(
    context.dsh,
    ['--profile', profile, '--from-default-profile', 'headless', '--dump-config'],
    { cwd: context.scratch, env: childEnv(context), timeoutMs: context.timeoutMs },
  )
  if (result.code !== 0 || !existsSync(path.join(dir, 'package.json'))) {
    throw new Error(`cannot create profile ${profile}: ${result.stderr.trim() || `exit ${result.code}`}`)
  }
  return { created: true }
}

/**
 * The headless template disables the managed credential store, so the copied `$DSH_HOME/.credentials.yaml`
 * is only read once `credentials`, `authorization` and `deepseek-account` are back on. The plugin's
 * own row carries the scenario's settings, which also proves a profile patch reaches the plugin.
 *
 * @param {Context} context
 * @param {string} profile
 * @param {Record<string, number>} config
 */
function writeProfilePatch(context, profile, config) {
  const lines = [
    `# Written by scripts/e2e-headless.js for ${profile}: do not edit, the next run rewrites it.`,
    ...(context.auth === 'file'
      ? [
          '# The copied credentials file is only read once the store the headless template disables is',
          '# back on (m0/commands.md §2). An environment key needs none of this.',
          '- id: credentials',
          '  disabled: false',
          '- id: authorization',
          '  disabled: false',
          '- id: deepseek-account',
          '  disabled: false',
        ]
      : []),
    '- id: dsh-task-folding',
    '  config:',
    ...Object.entries(config).map(([key, value]) => `    ${key}: ${value}`),
    '',
  ]
  writeFileSync(path.join(context.home, 'profiles', profile, 'cordis.patch.yml'), lines.join('\n'))
}

/**
 * @param {Context} context
 * @param {string} profile
 * @returns {Promise<{ installed: boolean }>}
 */
async function ensurePlugin(context, profile) {
  const manifest = path.join(context.home, 'profiles', profile, 'package.json')
  const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
  const dependencies = isRecord(parsed.dependencies) ? parsed.dependencies : {}
  // A profile an earlier run made may carry a different spec — a linked checkout where this run asks
  // for a published version, or the reverse — so the add is repeated unless the spec is the one asked
  // for. That is what makes `--plugin dsh-task-folding@<version>` test that package and not the tree.
  if (dependencies[PLUGIN_PACKAGE] === context.plugin) return { installed: false }
  const result = await run(context.dsh, ['plugin', '--profile', profile, 'add', context.plugin], {
    cwd: context.scratch,
    env: childEnv(context),
    timeoutMs: context.timeoutMs,
  })
  if (result.code !== 0)
    throw new Error(`cannot install ${context.plugin} into ${profile}: ${result.stderr.trim()}`)
  return { installed: true }
}

/**
 * Put an API key where the profile can read it: a copied credentials file (the local case) or the
 * launch environment (CI). The two need different patches — the shipped headless template disables
 * the managed credential store, and only a file needs that store back on.
 *
 * @param {Context} context
 * @returns {{ mode: 'file' | 'env', detail: string }}
 */
function ensureCredentials(context) {
  const target = path.join(context.home, '.credentials.yaml')
  // The credentials service refuses a file readable beyond its owner, so a plain write (0664 under
  // the default umask) would leave every turn failing on a missing key.
  if (existsSync(target)) {
    chmodSync(target, 0o600)
    return { mode: 'file', detail: 'already in the scratch home' }
  }
  if (existsSync(context.credentials)) {
    writeFileSync(target, readFileSync(context.credentials), { mode: 0o600 })
    return { mode: 'file', detail: `copied ${context.credentials}` }
  }
  const key = process.env.DEEPSEEK_API_KEY
  if (typeof key === 'string' && key !== '') {
    writeFileSync(path.join(context.home, '.env'), `DEEPSEEK_API_KEY=${key}\n`, { mode: 0o600 })
    return { mode: 'env', detail: 'no credentials file; DEEPSEEK_API_KEY from the environment' }
  }
  throw new Error(
    `no credentials: ${context.credentials} is missing and DEEPSEEK_API_KEY is not exported ` +
      '(the headless template ignores the managed credential store)',
  )
}

/**
 * The two files the scripted session reads. Their size is what clears `minSpanTokens`.
 *
 * @param {Context} context
 */
function ensureNotes(context) {
  mkdirSync(context.work, { recursive: true })
  for (const name of ['notes-a.md', 'notes-b.md']) {
    const target = path.join(context.work, name)
    const lines = [`# ${name}`, '']
    for (let index = 1; index <= NOTES_LINES; index += 1) {
      lines.push(
        `Line ${index} of ${name}: the quick brown fox jumps over the lazy dog, entry ${(index * 7) % 1000}.`,
      )
    }
    writeFileSync(target, `${lines.join('\n')}\n`)
  }
}

/**
 * The journal of one session: `$DSH_HOME/sessions/<escaped cwd>/session-<uuid>/session.v4.jsonl.zstd`
 * (docs/02 §11). Found by the session directory rather than by re-deriving the host's escaping.
 *
 * @param {Context} context
 * @param {string} sessionId
 * @returns {string | null}
 */
function findJournal(context, sessionId) {
  const root = path.join(context.home, 'sessions')
  if (!existsSync(root)) return null
  for (const workspace of readdirSync(root)) {
    const candidate = path.join(root, workspace, sessionId, 'session.v4.jsonl.zstd')
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * @param {string} file
 * @returns {SessionEvent[]}
 */
function readEvents(file) {
  return journalEvents(readJournalText(file))
}

// ---------------------------------------------------------------------------
// The scripted session

/**
 * @param {Context} context
 * @param {'self' | 'delegate'} name
 * @returns {Promise<{ name: string, checks: { name: string, ok: boolean, detail: string }[], journal: string, turns: number }>}
 */
async function runScenario(context, name) {
  const scenario = SCENARIOS[name]
  const profile = scenario.profile
  const settings = { minSpanTokens: scenario.config.minSpanTokens }
  const setup = await ensureProfile(context, profile)
  const plugin = await ensurePlugin(context, profile)
  writeProfilePatch(context, profile, scenario.config)
  process.stdout.write(
    `  profile ${profile}: ${setup.created ? 'created' : 'reused'}, plugin ${plugin.installed ? 'installed' : 'present'}\n`,
  )

  const title = `headless e2e ${name}`
  const firstPrompt =
    `Call task_begin with title "${title}" in its own message, before any other work. ` +
    'Then read notes-a.md and notes-b.md in full, one read tool call per file, and close the task with task_end.'
  let first = await runTurn(context, {
    profile,
    prompt: firstPrompt,
    sessionId: null,
    label: `${name}-turn1`,
  })
  let turns = 1
  // An errored turn is not an uncooperative model: retrying it would spend another request to learn
  // the same thing, so say what the host said and stop.
  if (!first.completed) throw new Error(`the first turn failed: ${first.error ?? describeTurn(first)}`)
  const opened = first.calls.some((call) => call.name === 'task_begin')
  const closed = first.calls.some((call) => call.name === 'task_end')
  if (!opened || !closed || first.sessionId === null) {
    // The scenario is scripted, the model is not: one retry in a fresh session, then a hard stop
    // that says which instruction the model did not follow.
    process.stdout.write(`  first turn did not follow the script (${describeTurn(first)}); retrying once\n`)
    first = await runTurn(context, { profile, prompt: firstPrompt, sessionId: null, label: `${name}-turn1b` })
    turns += 1
    if (!first.completed)
      throw new Error(`the retried first turn failed: ${first.error ?? describeTurn(first)}`)
  }
  if (first.sessionId === null) throw new Error(`turn 1 produced no session id: ${describeTurn(first)}`)

  // A queued or delegate fold commits at the next boundary, so the session needs another turn.
  // The delegate generation runs in the background: keep giving it boundaries until it commits.
  let folded = false
  for (let index = 0; index < context.keepalive && !folded; index += 1) {
    await runTurn(context, {
      profile,
      prompt: KEEPALIVE_PROMPT,
      sessionId: first.sessionId,
      label: `${name}-turn${turns + 1}`,
    })
    turns += 1
    folded = isFolded(context, first.sessionId)
  }
  if (!folded) {
    throw new Error(`the fold did not commit within ${context.keepalive} keepalive turn(s); see the logs`)
  }

  const journalFile = findJournal(context, first.sessionId)
  if (journalFile === null)
    throw new Error(`no journal for ${first.sessionId} under ${context.home}/sessions`)
  const before = inspectJournal(readEvents(journalFile))
  const taskId = foldedTaskId(before) ?? 'T1'

  const recall = await runTurn(context, {
    profile,
    prompt: `Call fold_recall for task ${taskId} and quote the first content line of each original file it returns.`,
    sessionId: first.sessionId,
    label: `${name}-recall`,
  })
  turns += 1

  const events = readEvents(journalFile)
  const journal = inspectJournal(events)
  const analysis = analyzeJournal(events, journalFile)
  const cache = judgeJournal(analysis, MIN_CACHE_RATIO)
  const report = analyzeSession(events, { label: name })
  const checks = judge({ scenario: name, first, recall, journal, cache, report, settings })
  return { name, checks, journal: journalFile, turns }
}

/** @param {ReturnType<typeof inspectJournal>} journal */
function foldedTaskId(journal) {
  for (const id of journal.state.order) {
    const task = journal.state.tasks[id]
    if (task !== undefined && task.status === 'folded') return task.id
  }
  return null
}

/**
 * Whether the journal already has a folded task. Reads the journal only after a turn finished, so
 * a partially written file is the only failure mode and it means "not yet".
 *
 * @param {Context} context
 * @param {string} sessionId
 */
function isFolded(context, sessionId) {
  const file = findJournal(context, sessionId)
  if (file === null) return false
  try {
    return foldedTaskId(inspectJournal(readEvents(file))) !== null
  } catch {
    return false
  }
}

/** @param {ReturnType<typeof summarizeTurn>} turn */
function describeTurn(turn) {
  const calls = turn.calls.map((call) => call.name).join(', ') || 'no tool calls'
  return `final ${turn.kind ?? 'none'}, ${calls}`
}

// ---------------------------------------------------------------------------
// Entry point

/**
 * @param {readonly string[]} argv
 * @returns {Context}
 */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const values = {}
  let keep = false
  let help = false
  const known = new Set(['scenario', 'home', 'work', 'plugin', 'dsh', 'credentials', 'timeout', 'keepalive'])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) continue
    if (arg === '--help' || arg === '-h') {
      help = true
      continue
    }
    if (arg === '--keep') {
      keep = true
      continue
    }
    if (!arg.startsWith('--')) throw new UsageError(`unexpected argument: ${arg}`)
    const name = arg.slice(2)
    if (!known.has(name)) throw new UsageError(`unknown option: ${arg}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`)
    values[name] = value
    index += 1
  }
  if (help) {
    process.stdout.write(`${USAGE}\n`)
    process.exit(0)
  }
  const scenario = values.scenario ?? 'both'
  if (scenario !== 'self' && scenario !== 'delegate' && scenario !== 'both') {
    throw new UsageError(`--scenario must be self, delegate, or both, got ${scenario}`)
  }
  const scratch = path.join(ROOT, '.tmp/e2e-headless')
  const home = path.resolve(values.home ?? path.join(scratch, 'dsh-home'))
  const timeoutMs = Number(values.timeout ?? DEFAULT_TIMEOUT_MS)
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    throw new UsageError('--timeout must be a positive integer')
  const keepalive = Number(values.keepalive ?? DEFAULT_KEEPALIVE_TURNS)
  if (!Number.isInteger(keepalive) || keepalive < 0)
    throw new UsageError('--keepalive must be a non-negative integer')
  return {
    dsh: values.dsh ?? process.env.DSH_BIN ?? 'dsh',
    scratch,
    home,
    work: path.resolve(values.work ?? path.join(scratch, 'work')),
    logs: path.join(scratch, 'logs'),
    plugin: values.plugin ?? ROOT,
    credentials: path.resolve(values.credentials ?? path.join(os.homedir(), '.dsh/.credentials.yaml')),
    timeoutMs,
    keepalive,
    keep,
    scenario,
  }
}

/**
 * Wipe the scratch tree, refusing any path outside `<repo>/.tmp/`.
 *
 * @param {Context} context
 */
function resetScratch(context) {
  const tmp = path.join(ROOT, '.tmp')
  const target = path.resolve(context.scratch)
  if (!target.startsWith(`${tmp}${path.sep}`)) {
    throw new Error(`refusing to remove ${target}: the scratch tree must live under ${tmp}`)
  }
  if (context.keep) return
  rmSync(target, { recursive: true, force: true })
}

/**
 * @param {{ name: string, ok: boolean, detail: string }[]} checks
 * @param {number} turns
 * @returns {boolean} whether every check passed
 */
function printChecks(checks, turns) {
  let failed = 0
  for (const check of checks) {
    if (!check.ok) failed += 1
    process.stdout.write(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name} — ${check.detail}\n`)
  }
  process.stdout.write(`  ${checks.length - failed}/${checks.length} checks in ${turns} turn(s)\n`)
  return failed === 0
}

async function main() {
  /** @type {Context} */
  let context
  try {
    context = parseArgs(process.argv.slice(2))
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    process.stderr.write(`e2e-headless: ${error.message}\n\n${USAGE}\n`)
    return 2
  }
  resetScratch(context)
  mkdirSync(context.home, { recursive: true })
  mkdirSync(context.logs, { recursive: true })
  const credentials = ensureCredentials(context)
  context.auth = credentials.mode
  ensureNotes(context)
  process.stdout.write(
    `e2e-headless: ${context.dsh}, scratch home ${path.relative(ROOT, context.home)} (${credentials.detail})\n`,
  )

  /** @type {Array<'self' | 'delegate'>} */
  const names = context.scenario === 'both' ? ['self', 'delegate'] : [context.scenario]
  /** @type {string[]} */
  const failed = []
  for (const name of names) {
    process.stdout.write(`\nscenario ${name} — ${SCENARIOS[name].summary}\n`)
    try {
      const result = await runScenario(context, name)
      process.stdout.write(`  journal ${path.relative(ROOT, result.journal)}\n`)
      if (!printChecks(result.checks, result.turns)) failed.push(name)
    } catch (error) {
      failed.push(name)
      process.stdout.write(
        `  FAIL  the run itself: ${error instanceof Error ? error.message : String(error)}\n`,
      )
    }
  }

  process.stdout.write(`\n${failed.length === 0 ? 'ok' : `failed: ${failed.join(', ')}`}\n`)
  if (failed.length > 0) {
    process.stdout.write(`logs: ${path.relative(ROOT, context.logs)}\n`)
    return 1
  }
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
