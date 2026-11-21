// Mutation testing for the riskiest host modules, without a dependency.
//
// Line coverage says the tests executed a line; it cannot say whether they would notice if that
// line were wrong. This script edits one operator at a time in a throwaway copy of the repository,
// runs the module's tests, and counts how many mutations the suite kills. A surviving mutation is a
// concrete, reproducible missing assertion — the output prints the exact file, line and replacement.
//
// Usage:
//   node scripts/mutate.js                            # every target, default test sets
//   node scripts/mutate.js --target host/cuts.js --tests test/cuts.test.js,test/properties.test.js
//   node scripts/mutate.js --json --min-score 0.85
//
// The copy lives under `.tmp/mutation/`, which is gitignored; the working tree is never modified.

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// One directory per run: two authors (or two shells) must not delete each other's copy mid-flight.
const WORK = join(ROOT, '.tmp', `mutation-${process.pid}`)

/** @typedef {{ target: string, tests: string[] }} Target */
/** @typedef {{ line: number, from: string, to: string, mutated: string }} Mutant */

/** @type {Target[]} */
const DEFAULT_TARGETS = [
  {
    target: 'host/cuts.js',
    tests: ['test/cuts.test.js', 'test/properties.test.js', 'test/projection.test.js'],
  },
  {
    target: 'host/projection.js',
    tests: ['test/projection.test.js', 'test/properties.test.js', 'test/replay.test.js'],
  },
  {
    target: 'host/planner.js',
    tests: ['test/planner.test.js', 'test/fold-runner.test.js', 'test/properties.test.js'],
  },
]

/**
 * Replacements applied one at a time. Longer operators first so `<=` is not read as `<`.
 *
 * @type {[string, string][]}
 */
const REPLACEMENTS = [
  ['===', '!=='],
  ['!==', '==='],
  ['&&', '||'],
  ['||', '&&'],
  ['<=', '<'],
  ['>=', '>'],
  ['<', '<='],
  ['>', '>='],
  ['+', '-'],
  ['-', '+'],
  ['*', '/'],
  ['1', '0'],
  ['0', '1'],
  ['true', 'false'],
  ['false', 'true'],
]

/**
 * Mask string and template literals so a replacement never rewrites a model-facing message.
 *
 * @param {string} source
 * @returns {{ masked: string, strings: string[] }}
 */
function maskStrings(source) {
  /** @type {string[]} */
  const strings = []
  // Comments are masked too: mutating prose would only produce noise, and a JSDoc `0` is not code.
  const masked = source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => {
      // Keep the newlines so reported line numbers stay true.
      strings.push(comment)
      return `\uE000${strings.length - 1}\uE000${'\n'.repeat((comment.match(/\n/g) ?? []).length)}`
    })
    .replace(/(^|[^:])\/\/[^\n]*/g, (match) => {
      strings.push(match)
      return `\uE000${strings.length - 1}\uE000`
    })
    .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, (literal) => {
      strings.push(literal)
      return `\uE000${strings.length - 1}\uE000`
    })
  return { masked, strings }
}

/**
 * @param {string} masked
 * @param {string[]} strings
 * @returns {string}
 */
function unmaskStrings(masked, strings) {
  return masked.replace(/\uE000(\d+)\uE000/g, (_match, index) => strings[Number(index)] ?? '')
}

/**
 * Every single-operator mutation of one source.
 *
 * @param {string} source
 * @returns {Mutant[]}
 */
export function mutationsOf(source) {
  const { masked, strings } = maskStrings(source)
  /** @type {Mutant[]} */
  const result = []
  for (const [from, to] of REPLACEMENTS) {
    let index = masked.indexOf(from)
    while (index !== -1) {
      // Keep the set meaningful: never touch an operator glued to an identifier (`x=1`, `a-b`, but
      // also `foo1`), and never touch a digit inside a number.
      const before = masked[index - 1] ?? ''
      const after = masked[index + from.length] ?? ''
      const glued = /[\w$]/.test(before) || /[\w$]/.test(after)
      const digitish = /[0-9]/.test(from) && (/[0-9.]/.test(before) || /[0-9.]/.test(after))
      // A literal in an `export const NAME = …` declaration is an equivalent mutant: the tests use
      // the constant, so changing its value changes both sides of every assertion.
      const declaration = /(?:const|let|var)\s+[A-Z_][A-Z_0-9]*\s*=\s*-?\s*$/.test(
        masked.slice(Math.max(0, index - 40), index),
      )
      // Mask markers are `\uE000<index>\uE000`; their digits are not code.
      const inMarker = before === '\uE000' || after === '\uE000'
      if (!glued && !digitish && !declaration && !inMarker) {
        const mutated = `${masked.slice(0, index)}${to}${masked.slice(index + from.length)}`
        result.push({
          line: masked.slice(0, index).split('\n').length,
          from,
          to,
          mutated: unmaskStrings(mutated, strings),
        })
      }
      index = masked.indexOf(from, index + from.length)
    }
  }
  return result
}

/**
 * Apply one mutation, run the tests, restore the file.
 *
 * @param {string} file absolute path inside the copy
 * @param {string} original
 * @param {string} mutated
 * @param {string[]} tests
 * @returns {boolean} true when the suite failed, i.e. the mutation was killed
 */
function kills(file, original, mutated, tests) {
  writeFileSync(file, mutated)
  try {
    execFileSync(process.execPath, ['--test', ...tests], { cwd: WORK, stdio: 'ignore', timeout: 180_000 })
    return false
  } catch {
    return true
  } finally {
    writeFileSync(file, original)
  }
}

/**
 * @param {Target} entry
 * @returns {{ target: string, total: number, killed: number, survived: { line: number, from: string, to: string }[] }}
 */
function mutateTarget(entry) {
  const file = join(WORK, entry.target)
  const original = readFileSync(file, 'utf8')
  const mutants = mutationsOf(original)
  /** @type {{ line: number, from: string, to: string }[]} */
  const survived = []
  let killed = 0
  for (const mutant of mutants) {
    if (kills(file, original, mutant.mutated, entry.tests)) killed += 1
    else survived.push({ line: mutant.line, from: mutant.from, to: mutant.to })
  }
  return { target: entry.target, total: mutants.length, killed, survived }
}

/**
 * @param {string[]} argv
 * @returns {{ targets: Target[], json: boolean, minScore: number }}
 */
function parseArgs(argv) {
  /** @type {Target[]} */
  const targets = []
  let json = false
  let minScore = 0
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') json = true
    else if (arg === '--min-score') minScore = Number(argv[++i] ?? '0')
    else if (arg === '--target') {
      const target = argv[++i] ?? ''
      /** @type {string[]} */
      let tests = []
      if (argv[i + 1] === '--tests') {
        tests = (argv[i + 2] ?? '').split(',').filter(Boolean)
        i += 2
      }
      targets.push({ target, tests: tests.length > 0 ? tests : ['test/**/*.test.js'] })
    }
  }
  return { targets: targets.length > 0 ? targets : DEFAULT_TARGETS, json, minScore }
}

/**
 * @param {string[]} argv
 * @returns {number} process exit code
 */
export function main(argv) {
  const { targets, json, minScore } = parseArgs(argv)
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  // Only what a test run needs: sources, tests and the manifest. The dependency tree is symlinked
  // so the copy stays cheap and `fast-check` still resolves.
  cpSync(join(ROOT, 'host'), join(WORK, 'host'), { recursive: true })
  cpSync(join(ROOT, 'test'), join(WORK, 'test'), { recursive: true })
  cpSync(join(ROOT, 'package.json'), join(WORK, 'package.json'))
  if (!existsSync(join(WORK, 'node_modules')))
    symlinkSync(join(ROOT, 'node_modules'), join(WORK, 'node_modules'))

  /** @type {ReturnType<typeof mutateTarget>[]} */
  const results = []
  for (const entry of targets) results.push(mutateTarget(entry))
  rmSync(WORK, { recursive: true, force: true })

  const total = results.reduce((sum, r) => sum + r.total, 0)
  const killed = results.reduce((sum, r) => sum + r.killed, 0)
  const score = total === 0 ? 0 : killed / total
  if (json) process.stdout.write(`${JSON.stringify({ results, total, killed, score })}\n`)
  else {
    for (const r of results) process.stdout.write(`${r.target}: ${r.killed}/${r.total} killed\n`)
    for (const r of results)
      for (const s of r.survived)
        process.stdout.write(`  survived ${r.target}:${s.line} ${s.from} -> ${s.to}\n`)
    process.stdout.write(`mutation score ${(score * 100).toFixed(1)}% (${killed}/${total})\n`)
  }
  return score < minScore ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2))
