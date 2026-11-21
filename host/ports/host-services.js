// The host-services port (docs/10 §3, §7): the one module that touches the host's service table.
// It registers what the plugin offers (`ctx.tools`, `ctx.sessionProjections`, `ctx.systemPrompt`,
// `ctx.on`), reads the optional services the plugin may use (`ctx.get`), and resolves a DeepSeek
// Harness package from the running installation. Everything above this port receives one plain
// object, so a missing service is a named failure here instead of a TypeError in the middle of an
// unrelated registration.
//
// Resolving a host package: a registry install sits inside the profile's node_modules, where a bare
// import works; a development install (`dsh plugin add <path>`) is a pnpm link whose real path is
// outside every node_modules that holds host packages, so the fallback resolves from the running
// DSH runtime instead (docs/02-host-api.md §9). Read-only: nothing here writes files.

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

/** The plugin's name, the prefix of every diagnostic and the host's service row id. */
export const PLUGIN_NAME = 'dsh-task-folding'

/** @typedef {{ warn(message: string): void, info?(message: string): void, error?(message: string): void }} HostLogger */

/**
 * The typed host surface `plugin/mount.js` may use. Every method either succeeds or reports the
 * missing service once and deactivates the plugin cleanly (docs/10 §7).
 *
 * @typedef {object} HostServices
 * @property {any} logger the host logger; diagnostics go through `ports/logger.js`
 * @property {any} tokenMeter the host token meter used by the span estimator
 * @property {(name: string) => any} service an optional injected service, `ctx.get(name)`
 * @property {(definitions: readonly any[]) => boolean} registerTools all three tools, or none
 * @property {(spec: any) => Promise<any> | null} registerProjection the projection handle, or null
 * @property {(section: { name: string, order: number, text: string }) => void} registerSection
 * @property {(event: string, handler: (...args: any[]) => any) => void} onHook
 */

/**
 * @param {any} ctx the plugin's context
 * @returns {HostServices}
 */
export function createHostServices(ctx) {
  /** @type {(() => void)[]} */
  const disposals = []

  /** Dispose everything registered so far, so a failed mount leaves no partial registration. */
  function disposeAll() {
    for (const dispose of disposals.splice(0)) dispose()
  }

  return {
    logger: ctx.logger,
    tokenMeter: ctx.tokenMeter,
    service: (name) => ctx.get(name),
    registerTools(definitions) {
      try {
        for (const definition of definitions) disposals.push(ctx.tools.register(definition))
        return true
      } catch (error) {
        disposeAll()
        ctx.logger.warn(
          `${PLUGIN_NAME}: not activated, ${reason(error)} Uninstall dsh-taskfold and restart to use this plugin.`,
        )
        return false
      }
    },
    registerProjection(spec) {
      try {
        return Promise.resolve(ctx.sessionProjections.register(spec))
      } catch (error) {
        disposeAll()
        ctx.logger.warn(
          `${PLUGIN_NAME}: not activated, ${reason(error)} Fold state needs a session projection; nothing was registered.`,
        )
        return null
      }
    },
    registerSection(section) {
      ctx.systemPrompt.section(section)
    },
    onHook(event, handler) {
      ctx.on(event, handler)
    },
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
export function reason(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

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
