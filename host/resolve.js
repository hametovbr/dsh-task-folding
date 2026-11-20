// Loads a DeepSeek Harness package from the host. A registry install sits inside the profile's
// node_modules, where a bare import works; a development install (`dsh plugin add <path>`) is a
// pnpm link whose real path is outside every node_modules that holds host packages, so the
// fallback resolves from the running DSH runtime instead (docs/02-host-api.md §9).
// Read-only: nothing here writes files.

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

/**
 * The namespace object of a host package, or null when neither route resolves it. The two
 * routes can yield different module instances, so callers cache the result per process.
 *
 * @param {string} spec bare specifier, e.g. `@deepseek-ai/dsh-compaction`
 * @param {{ importer?: (spec: string) => Promise<any>, entry?: string | undefined }} [options]
 *   test seams: the bare importer and the runtime entry script (default `process.argv[1]`)
 * @returns {Promise<any | null>}
 */
export async function loadHostModule(spec, options = {}) {
  const importer = options.importer || ((/** @type {string} */ name) => import(name))
  try {
    const bare = await importer(spec)
    if (bare) return bare
  } catch {
    // fall through to the runtime-anchored lookup
  }
  const entry = options.entry === undefined ? process.argv[1] : options.entry
  const dir = runtimeModulesDir(entry, spec)
  if (dir === null) return null
  try {
    const require = createRequire(path.join(dir, 'noop.js'))
    return require(spec) || null
  } catch {
    return null
  }
}

/**
 * @param {{ importer?: (spec: string) => Promise<any>, entry?: string | undefined }} [options]
 * @returns {Promise<any | null>} the schemastery default export, or null
 */
export async function loadSchemastery(options = {}) {
  return unwrapSchemastery(await loadHostModule('@deepseek-ai/schemastery', options))
}

/**
 * The closest `node_modules` above the real path of `entry` that contains `pkg`.
 *
 * @param {string | undefined} entry
 * @param {string} pkg
 * @returns {string | null}
 */
export function runtimeModulesDir(entry, pkg) {
  if (!entry) return null
  let dir
  try {
    dir = path.dirname(fs.realpathSync(entry))
  } catch {
    return null
  }
  for (;;) {
    const candidate = path.join(dir, 'node_modules')
    if (fs.existsSync(path.join(candidate, pkg, 'package.json'))) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** @param {any} mod */
function unwrapSchemastery(mod) {
  const value = mod && mod.default ? mod.default : mod
  return typeof value === 'function' && typeof value.object === 'function' ? value : null
}
