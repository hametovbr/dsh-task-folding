#!/usr/bin/env node
// Contract check for the engine adapter (docs/adr/0004): download the published host packages in
// the peer range and assert the facts `host/engine-adapter.js` relies on. Needs network, so it is
// not part of `npm test`.
//
//   npm run contract            # newest version allowed by package.json peerDependencies
//   node scripts/contract-check.js --keep   # leave the unpacked tarballs for inspection

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(import.meta.dirname, '..')
const manifest = require(path.join(ROOT, 'package.json'))
// A fresh checkout has no `.tmp`: create the scratch parent before asking for a child in it.
fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true })
const work = fs.mkdtempSync(path.join(ROOT, '.tmp', 'contract-'))
const keep = process.argv.includes('--keep')

const PACKAGES = [
  {
    name: '@deepseek-ai/dsh-compaction-basic',
    /** @param {string} source */
    checks: (source) => [
      [
        'exports a BasicCompactionEngine class extending CompactionEngine',
        /(class|var) BasicCompactionEngine = class extends CompactionEngine|class BasicCompactionEngine extends CompactionEngine/.test(
          source,
        ),
      ],
      ['summarize() is the subclass hook', /\bsummarize\(/.test(source)],
      ['compactRegion() is implemented', /\bcompactRegion\(/.test(source)],
      ['construction is gated by config.auto', /\bconfig\.auto\b/.test(source)],
      [
        'the shrink refusal message the adapter classifies on',
        source.includes('summary is not smaller than the shadowed content'),
      ],
      [
        'static inject matches the adapter shim',
        /static inject = \[\s*["']llm["'],\s*["']tokenMeter["'],\s*["']sessions["']\s*\]/.test(source),
      ],
    ],
  },
  {
    name: '@deepseek-ai/dsh-compaction',
    /** @param {string} source */
    checks: (source) => [
      [
        'exports ManualCompactionError',
        /(class|var) ManualCompactionError = class extends Error|class ManualCompactionError extends Error/.test(
          source,
        ),
      ],
      ['exports toolPairingBalancedBefore', /toolPairingBalancedBefore/.test(source)],
      ['exports toolPairingBalancedAfter', /toolPairingBalancedAfter/.test(source)],
      ['the service is provided as "compaction"', /super\([^)]*["']compaction["']\)/.test(source)],
    ],
  },
]

/** @param {string} command @param {string[]} args */
function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * The newest published version the peer range allows; npm resolves the range for us.
 *
 * @param {string} name
 * @param {string} range
 */
function newestInRange(name, range) {
  const raw = run('npm', ['view', `${name}@${range}`, 'version', '--json']).trim()
  const parsed = JSON.parse(raw)
  const versions = Array.isArray(parsed) ? parsed : [parsed]
  const last = versions.at(-1)
  if (typeof last !== 'string' || last.length === 0)
    throw new Error(`no published version of ${name} matches ${range}`)
  return last
}

/**
 * @param {string} name
 * @param {string} version
 */
function fetchAndUnpack(name, version) {
  const before = new Set(fs.readdirSync(work))
  run('npm', ['pack', `${name}@${version}`, '--pack-destination', work, '--silent'])
  const tarball = fs.readdirSync(work).find((entry) => !before.has(entry) && entry.endsWith('.tgz'))
  if (tarball === undefined) throw new Error(`npm pack produced no tarball for ${name}@${version}`)
  run('tar', ['-xzf', path.join(work, tarball), '-C', work])
  return path.join(work, 'package')
}

/**
 * The file a package's `main`/`exports["."]` points at.
 *
 * @param {string} dir
 */
function entryFile(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const exported = pkg.exports && pkg.exports['.']
  const candidate =
    (typeof exported === 'string' ? exported : undefined) ??
    (exported && typeof exported === 'object'
      ? (exported.default ?? exported.import ?? exported.require)
      : undefined) ??
    pkg.main ??
    'index.js'
  return path.join(dir, candidate)
}

let failures = 0
/** @type {string[]} */
const lines = []

for (const target of PACKAGES) {
  const range = manifest.peerDependencies?.[target.name]
  if (typeof range !== 'string') {
    lines.push(`SKIP ${target.name}: not declared in peerDependencies`)
    continue
  }
  let version
  try {
    version = newestInRange(target.name, range)
  } catch (error) {
    failures += 1
    lines.push(`FAIL ${target.name}: cannot resolve ${range}: ${messageOf(error)}`)
    continue
  }
  let dir
  try {
    dir = fetchAndUnpack(target.name, version)
  } catch (error) {
    failures += 1
    lines.push(`FAIL ${target.name}@${version}: cannot download: ${messageOf(error)}`)
    continue
  }
  const file = entryFile(dir)
  if (!fs.existsSync(file)) {
    failures += 1
    lines.push(`FAIL ${target.name}@${version}: entry ${path.relative(dir, file)} is missing`)
    continue
  }
  const source = fs.readFileSync(file, 'utf8')
  lines.push(`${target.name}@${version} (${path.relative(dir, file)}, ${source.length} bytes)`)
  for (const [what, ok] of target.checks(source)) {
    if (!ok) failures += 1
    lines.push(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`)
  }
}

console.log(lines.join('\n'))
if (!keep) fs.rmSync(work, { recursive: true, force: true })
else console.log(`\nunpacked under ${work}`)
if (failures > 0) {
  console.error(`\n${failures} contract check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall contract checks passed')
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
