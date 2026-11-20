// Loads @deepseek-ai/schemastery from the host. A registry install sits inside the profile's
// node_modules, where a bare import works; a development install (`dsh plugin add <path>`)
// is a pnpm link whose real path is outside every node_modules that holds host packages, so
// the fallback resolves from the running DSH runtime instead (docs/02-host-api.md §9).
// Read-only: nothing here writes files.

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const SCHEMASTERY = '@deepseek-ai/schemastery'

/**
 * @param {{ importer?: (spec: string) => Promise<any>, entry?: string | undefined }} [options]
 *   test seams: the bare importer and the runtime entry script (default `process.argv[1]`)
 * @returns {Promise<any | null>} the schemastery default export, or null
 */
export async function loadSchemastery(options = {}) {
  const importer = options.importer || ((/** @type {string} */ spec) => import(spec))
  try {
    const bare = unwrap(await importer(SCHEMASTERY))
    if (bare) return bare
  } catch {
    // fall through to the runtime-anchored lookup
  }
  const dir = runtimeModulesDir(options.entry === undefined ? process.argv[1] : options.entry, SCHEMASTERY)
  if (dir === null) return null
  try {
    const require = createRequire(path.join(dir, 'noop.js'))
    return unwrap(require(SCHEMASTERY))
  } catch {
    return null
  }
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
function unwrap(mod) {
  const value = mod && mod.default ? mod.default : mod
  return typeof value === 'function' && typeof value.object === 'function' ? value : null
}
