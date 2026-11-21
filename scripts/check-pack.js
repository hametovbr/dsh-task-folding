#!/usr/bin/env node
// Offline tarball check (docs/09-testing-plan.md T0): what `npm pack` would publish, and what npm
// rewrites in the packed manifest. The npm cache is redirected under the gitignored `.tmp/` because
// `~/.npm` can be read-only — the check failed once with EROFS on `/home/developer/.npm/_cacache`.
// Needs no network and no dependency beyond npm itself.
//
//   npm run pack:check

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { gunzipSync } from 'node:zlib'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCRATCH = path.join(ROOT, '.tmp')
const CACHE = path.join(SCRATCH, 'npmcache')
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

/** Files every publish must contain, because the host reads each of them. */
const REQUIRED_FILES = ['host/index.js', 'client/client.js', 'locale/en.json', 'cordis.patch.yml', 'icon.svg']

/** Manifest fields npm must not rewrite while packing. */
const COMPARED_FIELDS = ['version', 'exports', 'dsh']

/** @type {string[]} */
const failures = []

/**
 * Record one failed assertion.
 * @param {boolean} ok
 * @param {string} message
 */
function check(ok, message) {
  if (!ok) failures.push(message)
}

/**
 * Run npm in the repository with a writable, offline cache.
 * @param {string[]} args
 * @returns {string} stdout
 */
function npm(args) {
  return execFileSync(NPM, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_cache: CACHE,
      npm_config_offline: 'true',
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * Parse `npm pack --json` output into the packed file list and tarball name.
 * @param {string} stdout
 * @returns {{ files: string[], filename?: string }}
 */
function parsePackJson(stdout) {
  const parsed = JSON.parse(stdout)
  const entry = Array.isArray(parsed) ? parsed[0] : parsed
  if (entry === null || typeof entry !== 'object') throw new Error('npm pack --json returned no entry')
  const files = Array.isArray(entry.files)
    ? entry.files.map((/** @type {unknown} */ file) => {
        if (typeof file === 'string') return file
        if (
          file !== null &&
          typeof file === 'object' &&
          typeof (/** @type {any} */ (file).path) === 'string'
        ) {
          return /** @type {string} */ (/** @type {any} */ (file).path)
        }
        throw new Error('npm pack --json returned a file without a path')
      })
    : []
  return {
    files,
    ...(typeof entry.filename === 'string' ? { filename: entry.filename } : {}),
  }
}

/**
 * Why a file must never be published, or undefined when it may be.
 * @param {string} file
 * @returns {string | undefined}
 */
function forbiddenReason(file) {
  const segments = file.split('/')
  if (file === 'test' || file.startsWith('test/')) return 'test/'
  if (file.startsWith('.github/')) return '.github/'
  if (file.startsWith('.tmp/')) return '.tmp/'
  if (file.endsWith('.test.js')) return '*.test.js'
  if (segments.includes('node_modules')) return 'node_modules/'
  const first = segments[0]
  if (typeof first === 'string' && /^\.m/u.test(first)) return '.m* scratch dir'
  return undefined
}

/**
 * Read one string field out of a fixed-width tar header block.
 * @param {Buffer} source
 * @param {number} start
 * @param {number} length
 * @returns {string}
 */
function tarField(source, start, length) {
  const raw = source.toString('utf8', start, start + length)
  const nul = raw.indexOf('\u0000')
  return nul === -1 ? raw : raw.slice(0, nul)
}

/**
 * Read one entry out of an npm tarball without a tar dependency. npm writes ustar headers, so a
 * 512-byte header plus its 512-byte-padded data is enough for the short `package/package.json` name.
 * @param {string} tarball absolute path to the packed `.tgz`
 * @param {string} target entry name, e.g. `package/package.json`
 * @returns {string | undefined}
 */
function readTarballEntry(tarball, target) {
  const tar = gunzipSync(fs.readFileSync(tarball))
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    const name = tarField(header, 0, 100)
    if (name === '') break
    const prefix = tarField(header, 345, 155)
    const fullName = prefix === '' ? name : `${prefix}/${name}`
    const sizeText = tarField(header, 124, 12).trim()
    const size = sizeText === '' ? 0 : Number.parseInt(sizeText, 8)
    if (!Number.isFinite(size) || size < 0) throw new Error(`malformed tar header for ${fullName}`)
    const dataStart = offset + 512
    if (fullName === target) return tar.toString('utf8', dataStart, dataStart + size)
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return undefined
}

function main() {
  fs.mkdirSync(CACHE, { recursive: true })

  const dryRun = parsePackJson(npm(['pack', '--dry-run', '--json']))
  check(dryRun.files.length > 0, 'npm pack --dry-run --json listed no files')
  for (const required of REQUIRED_FILES) {
    check(dryRun.files.includes(required), `required file ${required} is missing from the tarball`)
  }
  for (const file of dryRun.files) {
    const reason = forbiddenReason(file)
    check(reason === undefined, `${file} would be published (${reason ?? ''})`)
  }

  const packDir = fs.mkdtempSync(path.join(SCRATCH, 'pack-'))
  try {
    const packed = parsePackJson(npm(['pack', '--json', '--pack-destination', packDir]))
    if (packed.filename === undefined) throw new Error('npm pack --json did not name the tarball')
    check(
      isDeepStrictEqual([...packed.files].sort(), [...dryRun.files].sort()),
      'the dry-run file list differs from the actual tarball',
    )

    const packedText = readTarballEntry(path.join(packDir, packed.filename), 'package/package.json')
    check(typeof packedText === 'string', 'the tarball has no package/package.json')
    if (typeof packedText === 'string') {
      const packedManifest = JSON.parse(packedText)
      const treeManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
      for (const field of COMPARED_FIELDS) {
        check(
          isDeepStrictEqual(packedManifest[field], treeManifest[field]),
          `packed package.json "${field}" differs from the working tree`,
        )
      }
    }
  } finally {
    fs.rmSync(packDir, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    console.error(`pack:check FAILED — ${failures.join('; ')}`)
    process.exitCode = 1
    return
  }
  console.log(
    `pack:check ok — ${dryRun.files.length} files, required files present, no test/CI/scratch leaks, ` +
      'packed version/exports/dsh match the working tree',
  )
}

try {
  main()
} catch (error) {
  console.error(`pack:check FAILED — ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
