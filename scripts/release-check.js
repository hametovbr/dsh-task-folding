#!/usr/bin/env node
// The release gate: every check a published version must pass, in one command, so that a publish
// cannot ship code the gates never saw (package.json runs this from `prepublishOnly`).
//
//   npm run release:check              # static gates, then the contract and the live E2E
//   npm run release:check -- --static  # no network and no model key (offline-shaped)
//   npm run release:check -- --full    # adds the mutation run (an hour or more)
//
// The two checks this gate exists for are the ones a push cannot run: `npm run contract` against the
// published host packages, and `npm run e2e`, which mounts the plugin into a real DSH and folds a
// real task. Both need the network and the second needs a model key, so `--static` is the honest
// escape hatch for an offline build, and `npm publish --ignore-scripts` bypasses the hook entirely
// for a hotfix whose gate already passed.
//
// One gate is optional rather than merely offline: `npm run probe:advisor` reads the installed
// third-party dsh-advisor package and exits 2 when it is absent, which this script reports as
// skipped — never as a pass. No other gate needs that package.
//
// Each npm child gets its cache and log directory under the gitignored `.tmp/`: `~/.npm` can be
// read-only (docs/09 T0 hit EROFS there), and a release check must not fail for that reason.

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const SCRATCH = path.join(ROOT, '.tmp')

/**
 * One gate: the npm script, its name for the report, what a failure means, and — for a gate that is
 * optional depending on the machine — the exit codes that mean "skipped", not "failed", and why.
 * @typedef {{
 *   script: string,
 *   title: string,
 *   why: string,
 *   skipExitCodes?: readonly number[],
 *   skipWhy?: string,
 * }} Step
 */

/** @type {Step[]} */
const STATIC = [
  { script: 'lint', title: 'lint', why: 'style and the host-import boundary (eslint + prettier)' },
  { script: 'typecheck', title: 'typecheck', why: 'JSDoc types under strict mode' },
  { script: 'test', title: 'test', why: 'the whole suite: unit, property, replay, faults, journals' },
  { script: 'coverage', title: 'coverage', why: 'the gate for every host/**/*.js file' },
  { script: 'perf', title: 'perf', why: 'the wall-clock guards, which `npm test` keeps out' },
  { script: 'pack:check', title: 'pack:check', why: 'what the tarball contains and what npm rewrites' },
  {
    // Offline like the rest of this group, but it reads the third-party dsh-advisor package, so it
    // is the one gate that can be legitimately unavailable: exit 2 means "not installed, nothing to
    // check" and the report says skipped rather than passed.
    script: 'probe:advisor',
    title: 'probe:advisor',
    why: 'the installed dsh-advisor still exports the transcript and guard surface a fold drives (no network, but it needs that package)',
    skipExitCodes: [2],
    skipWhy: 'dsh-advisor is not installed under $DSH_HOME/profiles, so there is nothing to check',
  },
]

/** @type {Step[]} */
const NETWORK = [
  { script: 'contract', title: 'contract', why: 'the adapter against the published host packages' },
  { script: 'e2e', title: 'e2e', why: 'a real DSH session: task, fold, recall, cache-hit' },
]

/** @type {Step[]} */
const LONG = [{ script: 'mutation', title: 'mutation', why: 'whether the tests can fail at all (slow)' }]

export const USAGE = `usage: node scripts/release-check.js [--static | --full]

  --static  run the offline gates only, skipping the contract check and the live E2E
  --full    also run \`npm run mutation\` (an hour or more)
  --help    show this text`

/** A gate returned non-zero: reported once, with the command to reproduce it. */
export class GateFailure extends Error {
  /** @param {Step} step @param {number} status */
  constructor(step, status) {
    super(`✗ ${step.title} failed (exit ${status}); reproduce with \`npm run ${step.script}\``)
    this.step = step
    this.status = status
  }
}

/**
 * @param {readonly string[]} argv
 * @returns {{ staticOnly: boolean, full: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  let staticOnly = false
  let full = false
  let help = false
  for (const arg of argv) {
    if (arg === '--static') staticOnly = true
    else if (arg === '--full') full = true
    else if (arg === '--help' || arg === '-h') help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (staticOnly && full) throw new Error('--static and --full are mutually exclusive')
  return { staticOnly, full, help }
}

/**
 * The gates a run covers, in order.
 *
 * @param {{ staticOnly: boolean, full: boolean }} options
 * @returns {Step[]}
 */
export function plan(options) {
  return [...STATIC, ...(options.staticOnly ? [] : NETWORK), ...(options.full ? LONG : [])]
}

/**
 * Run one npm script with the repository as cwd, streaming its output.
 *
 * @param {Step} step
 * @returns {{ ms: number, skipped: boolean }} how long it took, and whether it was a documented skip
 * @throws {GateFailure} when the script exits non-zero for a reason the step does not accept
 */
function runStep(step) {
  process.stdout.write(`\n▶ ${step.title} — ${step.why}\n`)
  const started = Date.now()
  const result = spawnSync(NPM, ['run', '--silent', step.script], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_cache: path.join(SCRATCH, 'npmcache'),
      npm_config_logs_dir: path.join(SCRATCH, 'npmlogs'),
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
    },
  })
  if (result.error !== undefined) throw result.error
  const status = result.status ?? 1
  const skipped = (step.skipExitCodes ?? []).includes(status)
  if (status !== 0 && !skipped) throw new GateFailure(step, status)
  return { ms: Date.now() - started, skipped }
}

/**
 * @param {readonly string[]} argv
 * @returns {number} the process exit code
 */
export function main(argv) {
  /** @type {{ staticOnly: boolean, full: boolean, help: boolean }} */
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`release-check: ${message}\n\n${USAGE}\n`)
    return 2
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const steps = plan(options)
  process.stdout.write(
    `release-check: ${steps.length} gate(s)${options.staticOnly ? ' (--static: no network, no model key)' : ''}\n`,
  )
  /** @type {{ title: string, ms: number, skipped: boolean, skipWhy?: string }[]} */
  const done = []
  for (const step of steps) {
    try {
      const { ms, skipped } = runStep(step)
      done.push({ title: step.title, ms, skipped, skipWhy: skipped ? step.skipWhy : undefined })
    } catch (error) {
      if (!(error instanceof GateFailure)) throw error
      process.stderr.write(`\n${error.message}\n`)
      process.stderr.write(`  the release stops here; ${done.length} earlier gate(s) passed\n`)
      return 1
    }
  }
  process.stdout.write('\n')
  for (const entry of done) {
    if (entry.skipped) {
      process.stdout.write(
        `- ${entry.title} skipped (${(entry.ms / 1000).toFixed(1)} s): ${entry.skipWhy ?? 'not applicable here'}\n`,
      )
    } else {
      process.stdout.write(`✓ ${entry.title} (${(entry.ms / 1000).toFixed(1)} s)\n`)
    }
  }
  const skipped = done.filter((entry) => entry.skipped).length
  process.stdout.write(
    `release-check: ${done.length - skipped} gate(s) passed${skipped > 0 ? `, ${skipped} skipped` : ''}\n`,
  )
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
