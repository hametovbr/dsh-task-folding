// T0 manifest contract (docs/09-testing-plan.md). A manifest can look fine and still make the host
// drop the whole client module: `exports["./client"]` once pointed at `./client.js` while the file
// lived at `client/client.js`, and the page loaded with an empty slot and no error. These tests read
// the package as a *package* — every exported path, the loader form, the patch rows the host mounts,
// `dsh.client`, `files` coverage — offline, and without executing any of it.

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const MANIFEST = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

/**
 * Normalize a manifest-relative path for on-disk lookup: drop the leading `./` and any trailing `/`.
 * @param {string} value
 * @returns {string}
 */
export function normalizeRepoPath(value) {
  return value.replace(/^\.\//u, '').replace(/\/+$/u, '')
}

/**
 * Read a repository-relative text file.
 * @param {string} relativePath
 * @returns {string}
 */
export function readRepoFile(relativePath) {
  return readFileSync(path.join(ROOT, normalizeRepoPath(relativePath)), 'utf8')
}

/**
 * Whether a repository-relative path is a regular file.
 * @param {string} relativePath
 * @returns {boolean}
 */
export function repoFileExists(relativePath) {
  try {
    return statSync(path.join(ROOT, normalizeRepoPath(relativePath))).isFile()
  } catch {
    return false
  }
}

/**
 * Escape one literal chunk of a glob for use inside a regular expression.
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Does one `files` entry cover `relativePath`? A `*` matches within one path segment; a plain entry
 * covers the exact path and everything below it, exactly as npm's packlist treats directories.
 * @param {string} entry
 * @param {string} relativePath
 * @returns {boolean}
 */
export function filesEntryCovers(entry, relativePath) {
  const normalized = normalizeRepoPath(entry)
  if (normalized === '') return false
  const target = normalizeRepoPath(relativePath)
  if (!normalized.includes('*')) {
    return target === normalized || target.startsWith(`${normalized}/`)
  }
  const source = normalized
    .split('*')
    .map((part) => escapeRegExp(part))
    .join('[^/]*')
  return new RegExp(`^${source}$`, 'u').test(target)
}

/**
 * Whether any `files` entry covers a repository-relative path.
 * @param {readonly string[]} files
 * @param {string} relativePath
 * @returns {boolean}
 */
export function isCoveredByFiles(files, relativePath) {
  return files.some((entry) => filesEntryCovers(entry, relativePath))
}

/**
 * Every regular file below a repository-relative directory, as repository-relative POSIX paths.
 * @param {string} relativeDir
 * @returns {string[]}
 */
export function listRepoFiles(relativeDir) {
  /** @type {string[]} */
  const files = []
  /**
   * @param {string} dir
   */
  function visit(dir) {
    const absolute = dir === '.' ? ROOT : path.join(ROOT, dir)
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const relative = dir === '.' ? entry.name : `${dir}/${entry.name}`
      if (entry.isDirectory()) visit(relative)
      else if (entry.isFile()) files.push(relative)
    }
  }
  const normalized = normalizeRepoPath(relativeDir)
  visit(normalized === '' ? '.' : normalized)
  return files.sort()
}

/**
 * Files that could match one `files`/`exports` pattern. Only one `*` is supported, which is all the
 * manifest uses; the walk starts at the pattern's literal directory so it never enters `node_modules`.
 * @param {string} pattern
 * @returns {string[]}
 */
export function filesMatchingPattern(pattern) {
  const normalized = normalizeRepoPath(pattern)
  const star = normalized.indexOf('*')
  if (star === -1) return repoFileExists(normalized) ? [normalized] : []
  const prefix = normalized.slice(0, star)
  const slash = prefix.lastIndexOf('/')
  const dir = slash === -1 ? '.' : prefix.slice(0, slash)
  return listRepoFiles(dir).filter((file) => filesEntryCovers(normalized, file))
}

/**
 * Whether a `files` entry names at least one thing that exists (a file, a directory or a pattern
 * match). Catches a stale entry that would silently stop shipping a file.
 * @param {string} entry
 * @returns {boolean}
 */
export function filesEntryHasTargets(entry) {
  const normalized = normalizeRepoPath(entry)
  if (normalized === '') return false
  if (!normalized.includes('*')) return existsSync(path.join(ROOT, normalized))
  return filesMatchingPattern(normalized).length > 0
}

/**
 * The target of one `exports` value: a plain string, or the conditional object form the host's
 * `clientExportOf` accepts for `./client` (string `default`, then the usual `import`/`require`).
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function exportTargetOf(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    const record = /** @type {Record<string, unknown>} */ (value)
    for (const key of ['default', 'import', 'require']) {
      const candidate = record[key]
      if (typeof candidate === 'string') return candidate
    }
  }
  return undefined
}

/**
 * Map one file matched by a wildcard `exports` key through that key's target pattern.
 * @param {string} keyPattern e.g. `./locale/*.json`
 * @param {string} targetPattern e.g. `./locale/*.json`
 * @param {string} match a file matched by `keyPattern`
 * @returns {string}
 */
export function expandExportTarget(keyPattern, targetPattern, match) {
  const normalizedKey = normalizeRepoPath(keyPattern)
  const star = normalizedKey.indexOf('*')
  const prefix = normalizedKey.slice(0, star)
  const suffix = normalizedKey.slice(star + 1)
  const captured = normalizeRepoPath(match).slice(
    prefix.length,
    normalizeRepoPath(match).length - suffix.length,
  )
  const normalizedTarget = normalizeRepoPath(targetPattern)
  return normalizedTarget.includes('*') ? normalizedTarget.replace('*', captured) : normalizedTarget
}

/**
 * `- id:` rows of a cordis bundle patch, in file order. The host mounts one Loader row per id, and a
 * row's module specifier must be the package name for `locatePkgJson` to find this manifest.
 * @param {string} patch
 * @returns {string[]}
 */
export function patchRowIds(patch) {
  /** @type {string[]} */
  const ids = []
  for (const line of patch.split('\n')) {
    if (!/^\s*-\s+id\s*:/u.test(line)) continue
    const match = /^\s*-\s+id\s*:\s*(?:(['"])([^'"]*)\1|([^\s#]+))/u.exec(line)
    if (match === null) continue
    const id = match[2] ?? match[3]
    if (typeof id === 'string') ids.push(id)
  }
  return ids
}

/**
 * Mirror of the host's `parseDshClient` checks (`@deepseek-ai/dsh-client-modules`,
 * `src/client/manifest.ts`): the host validates this exact shape while it builds the client roster,
 * and any violation throws, removing the whole client row. The host does the same; this function
 * returns the violations instead of throwing so the test can show them all at once.
 * @param {unknown} value the raw `dsh.client` declaration
 * @returns {string[]} human-readable problems; empty when the declaration is valid
 */
export function validateDshClient(value) {
  /** @type {string[]} */
  const problems = []
  if (value === undefined) {
    problems.push('dsh.client is absent')
    return problems
  }
  if (typeof value !== 'object' || value === null) {
    problems.push('dsh.client must be an object')
    return problems
  }
  const decl = /** @type {Record<string, unknown>} */ (value)
  if (typeof decl.platform !== 'string') problems.push('dsh.client.platform must be a string')
  if (decl.immediately !== undefined && typeof decl.immediately !== 'boolean') {
    problems.push('dsh.client.immediately must be a boolean')
  }
  for (const field of ['inject', 'external']) {
    const fieldValue = decl[field]
    if (fieldValue === undefined) continue
    if (!Array.isArray(fieldValue) || fieldValue.some((item) => typeof item !== 'string')) {
      problems.push(`dsh.client.${field} must be a string array`)
    }
  }
  return problems
}

/**
 * Every relative module specifier a source file imports or requires statically. Bare specifiers
 * (`react`) are host-provided and are not package files, so they are ignored.
 * @param {string} source
 * @returns {string[]}
 */
export function relativeSpecifiers(source) {
  /** @type {string[]} */
  const specifiers = []
  const patterns = [
    /^\s*import\s*(['"])([^'"]+)\1\s*;?\s*$/gmu,
    /\bfrom\s*(['"])([^'"]+)\1\s*;?\s*$/gmu,
    /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/gu,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[2]
      if (typeof specifier === 'string' && specifier.startsWith('.')) specifiers.push(specifier)
    }
  }
  return [...new Set(specifiers)]
}

/**
 * Resolve a relative specifier the way Node ESM would for this repository (explicit `.js`, then
 * appended `.js`, then a directory index).
 * @param {string} importerRelative
 * @param {string} specifier
 * @returns {string | undefined}
 */
export function resolveRelativeImport(importerRelative, specifier) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importerRelative), specifier))
  const candidates = specifier.endsWith('.js') ? [base] : [base, `${base}.js`, `${base}/index.js`]
  return candidates.find((candidate) => repoFileExists(candidate))
}

/**
 * The `{ id, factory }` header of a client bundle, parsed without executing it. This is the form the
 * host's module table registers (`window.__ModuleLoader__.load({ id, factory })`), and `id` must be
 * the package name because the boot wire keys module rows by it.
 * @param {string} source
 * @returns {{ hasLoadCall: boolean, hasFactory: boolean, id: string | undefined }}
 */
export function parseLoaderHeader(source) {
  const load = /window\s*\.\s*__ModuleLoader__\s*\.\s*load\s*\(\s*\{/u.exec(source)
  if (load === null) return { hasLoadCall: false, hasFactory: false, id: undefined }
  const after = source.slice(load.index)
  const factory = /\bfactory\s*(?:\(|:|=)/u.exec(after)
  const header = factory === null ? after : after.slice(0, factory.index)
  const id = /(?:^|[^\w$])id\s*:\s*(['"])([^'"]*)\1/u.exec(header)
  return {
    hasLoadCall: true,
    hasFactory: factory !== null,
    id: id === null ? undefined : id[2],
  }
}

/**
 * `package.json`'s `exports` map, asserted to exist first.
 * @returns {Record<string, unknown>}
 */
function exportsField() {
  assert.ok(MANIFEST.exports && typeof MANIFEST.exports === 'object', 'package.json must declare exports')
  return /** @type {Record<string, unknown>} */ (MANIFEST.exports)
}

/**
 * `package.json`'s `files` list, asserted to be a string array first.
 * @returns {string[]}
 */
function filesField() {
  assert.ok(Array.isArray(MANIFEST.files), 'package.json must declare files')
  assert.ok(
    MANIFEST.files.every((/** @type {unknown} */ entry) => typeof entry === 'string'),
    'files must be strings',
  )
  return /** @type {string[]} */ (MANIFEST.files)
}

/**
 * `package.json`'s `dsh` block, asserted to exist first.
 * @returns {any}
 */
function dshField() {
  assert.ok(MANIFEST.dsh && typeof MANIFEST.dsh === 'object', 'package.json must declare dsh')
  return MANIFEST.dsh
}

const PACKAGE_NAME = String(MANIFEST.name)

test('package name is declared and version is plain semver with engines.node', () => {
  assert.ok(PACKAGE_NAME.length > 0, 'package.json.name must be a non-empty string')
  assert.match(
    MANIFEST.version,
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u,
    'version must be a plain x.y.z string (no range, no prerelease, no leading v)',
  )
  assert.equal(typeof MANIFEST.engines?.node, 'string', 'engines.node must be declared')
  assert.ok(MANIFEST.engines.node.trim().length > 0, 'engines.node must not be empty')
})

test('every exports path resolves to a shipped file', () => {
  const exportsMap = exportsField()
  const keys = Object.keys(exportsMap)
  assert.ok(keys.length > 0, 'exports must not be empty')
  for (const key of keys) {
    const target = exportTargetOf(exportsMap[key])
    assert.equal(typeof target, 'string', `exports["${key}"] must resolve to a string target`)
    const targetPath = normalizeRepoPath(/** @type {string} */ (target))
    assert.ok(
      !path.isAbsolute(targetPath) && !targetPath.split('/').includes('..'),
      `exports["${key}"] -> ${targetPath} must stay inside the package`,
    )
    if (key.includes('*')) {
      const matches = filesMatchingPattern(key)
      assert.ok(matches.length > 0, `exports["${key}"] matches no file in the repository`)
      for (const match of matches) {
        const expanded = expandExportTarget(key, /** @type {string} */ (target), match)
        assert.ok(repoFileExists(expanded), `exports["${key}"] -> ${expanded} is missing`)
      }
    } else {
      assert.ok(repoFileExists(targetPath), `exports["${key}"] -> ${targetPath} is missing`)
    }
  }
})

test('exports["./client"] is a real file in the loader form the host expects', () => {
  const exportsMap = exportsField()
  assert.ok(
    Object.hasOwn(exportsMap, './client'),
    'exports["./client"] is required when dsh.client is declared',
  )
  const target = exportTargetOf(exportsMap['./client'])
  assert.equal(
    typeof target,
    'string',
    'exports["./client"] must be a string or an object with a string default',
  )
  const clientFile = normalizeRepoPath(/** @type {string} */ (target))
  // The historical M6 defect: this exact path was absent, and the host silently dropped the module.
  assert.ok(
    repoFileExists(clientFile),
    `exports["./client"] -> ${clientFile} is missing; the host would drop the client`,
  )
  assert.equal(
    statSync(path.join(ROOT, clientFile)).isFile(),
    true,
    `${clientFile} must be a regular file, not a directory`,
  )
  const header = parseLoaderHeader(readRepoFile(clientFile))
  assert.equal(header.hasLoadCall, true, `${clientFile} must call window.__ModuleLoader__.load({ ... })`)
  assert.equal(header.hasFactory, true, `${clientFile} loader entry must define factory(require)`)
  assert.equal(header.id, PACKAGE_NAME, `${clientFile} loader id must be the package name "${PACKAGE_NAME}"`)
})

test('dsh.bundle.patch declares loader rows named after the package', () => {
  const dsh = dshField()
  assert.ok(dsh.bundle && typeof dsh.bundle === 'object', 'dsh.bundle must be an object')
  assert.equal(typeof dsh.bundle.patch, 'string', 'dsh.bundle.patch must be a string path')
  const patchFile = normalizeRepoPath(/** @type {string} */ (dsh.bundle.patch))
  assert.ok(repoFileExists(patchFile), `dsh.bundle.patch -> ${patchFile} is missing`)
  const patch = readRepoFile(patchFile)
  assert.match(patch, /^-\s*insert\s*:/mu, `${patchFile} must open with an insert list`)
  const rows = patchRowIds(patch)
  assert.ok(rows.length > 0, `${patchFile} must declare at least one loader row`)
  for (const row of rows) {
    assert.equal(row, PACKAGE_NAME, `${patchFile} row id "${row}" must be the package name "${PACKAGE_NAME}"`)
  }
})

test('dsh.client passes the host parseDshClient rules', () => {
  const dsh = dshField()
  assert.deepEqual(validateDshClient(dsh.client), [], 'dsh.client must match the checks the host applies')
  assert.equal(dsh.client.platform, 'web', 'the host mounts only client declarations with platform "web"')
  assert.ok(
    Object.hasOwn(exportsField(), './client'),
    'a dsh.client declaration requires exports["./client"]',
  )
})

test('every relative runtime import is covered by files', () => {
  const files = filesField()
  let checked = 0
  for (const dir of ['host', 'client']) {
    for (const file of listRepoFiles(dir)) {
      if (!file.endsWith('.js')) continue
      for (const specifier of relativeSpecifiers(readRepoFile(file))) {
        const resolved = resolveRelativeImport(file, specifier)
        assert.ok(resolved !== undefined, `${file} imports "${specifier}", which resolves to no file`)
        assert.ok(isCoveredByFiles(files, resolved), `${file} imports ${resolved}, which files does not ship`)
        checked += 1
      }
    }
  }
  assert.ok(checked > 0, 'the import walk found nothing, so it proves nothing')
  for (const declared of ['locale/en.json', 'cordis.patch.yml']) {
    assert.ok(
      isCoveredByFiles(files, declared),
      `${declared} is declared in the manifest but files does not ship it`,
    )
  }
})

test('files ships every host and client script and nothing from test/CI', () => {
  const files = filesField()
  const scripts = [...listRepoFiles('host'), ...listRepoFiles('client')].filter((file) =>
    file.endsWith('.js'),
  )
  assert.ok(scripts.length > 0, 'there must be at least one shipped script')
  for (const script of scripts) {
    assert.ok(isCoveredByFiles(files, script), `${script} exists but files does not ship it`)
  }
  for (const entry of files) {
    assert.ok(filesEntryHasTargets(entry), `files entry "${entry}" matches nothing (stale entry)`)
  }
  // Nothing outside the runtime directories may ship: a broad entry such as `.` or `**` would pass
  // every check above and still publish tests, CI and scratch files.
  for (const dir of ['test', 'scripts', '.github']) {
    for (const file of listRepoFiles(dir)) {
      assert.equal(isCoveredByFiles(files, file), false, `${file} would ship though it is not a runtime file`)
    }
  }
  for (const leaked of ['test/manifest.test.js', '.github/workflows/ci.yml']) {
    for (const entry of files) {
      assert.equal(filesEntryCovers(entry, leaked), false, `files entry "${entry}" would ship ${leaked}`)
    }
  }
})
