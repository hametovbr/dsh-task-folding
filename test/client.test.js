// The browser half (docs/03 §9): the module loads in the Client's loader form, registers its two
// slots, and its runtime dictionary matches the packaged locale. No browser is needed for this.

import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { test } from 'node:test'

const SOURCE = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const LOCALE = JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))
const MANIFEST = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** A React stand-in: enough for the module to define components without rendering them. */
const React = {
  /** @param {...any} args */
  createElement: (...args) => ({ args }),
  Fragment: 'Fragment',
  /** @param {() => any} fn */
  useMemo: (fn) => fn(),
  /** @param {any} initial */
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  /** @param {any} value */
  useRef: (value) => ({ current: value }),
  /** @param {any} fn */
  useCallback: (fn) => fn,
  /** @param {any} _subscribe @param {() => any} read */
  useSyncExternalStore: (_subscribe, read) => read(),
  useId: () => 'id',
}

/**
 * Load the client module the way the browser's loader does.
 *
 * @returns {{ id: string, plugin: any, registered: any[] }}
 */
function loadClient() {
  /** @type {any} */
  let captured
  const window = { __ModuleLoader__: { load: (/** @type {any} */ entry) => (captured = entry) } }
  const require = (/** @type {string} */ name) => {
    if (name === 'react') return React
    throw new Error(`the client module must not require ${name}`)
  }
  new Function('window', 'require', SOURCE)(window, require)
  const plugin = captured.factory(require)
  /** @type {any[]} */
  const registered = []
  /** @type {any} */
  const ctx = {
    slots: {
      /** @param {string} _slot @param {() => any} fn */
      inject: (_slot, fn) => fn(),
      /** @param {any} meta @param {any} component */
      register: (meta, component) => {
        registered.push({ meta, component })
        return () => {}
      },
    },
    /** @param {() => any} fn */
    effect: (fn) => fn(),
    on: () => () => {},
    locale: { register: () => () => {}, t: (/** @type {string} */ key) => key },
    inject: () => {},
    get: () => undefined,
  }
  plugin.apply(ctx)
  return { id: captured.id, plugin, registered }
}

test('the client module loads with the package id and registers both slots', () => {
  const client = loadClient()
  assert.equal(client.id, MANIFEST.name, 'the loader id must be the package name')
  assert.deepEqual(client.plugin.inject, ['slots', 'locale'])
  const names = client.registered.map((entry) => entry.meta.name)
  assert.deepEqual(names, ['conversation.input.dock', 'plugins.bundle.config'])
  const dock = client.registered[0].meta
  assert.equal(dock.id, 'task-folding')
  assert.equal(typeof dock.order, 'number')
  assert.equal(client.registered[1].meta.key, MANIFEST.name, 'the config slot is keyed by the bundle')
  for (const entry of client.registered) assert.equal(typeof entry.component, 'function')
})

test('the packaged locale matches the runtime dictionary and keeps the display metadata', () => {
  assert.equal(LOCALE.meta.title, 'Task folding')
  assert.ok(LOCALE.meta.description.length > 0)
  const used = new Set(LOCALE.client ? Object.keys(LOCALE.client) : [])
  assert.ok(used.size >= 20, `expected the client section, got ${used.size} keys`)
  // Every key the module registers at runtime must be packaged: the Host reads locale/*.json for
  // display metadata, while the browser module cannot import JSON, so the two lists can drift.
  for (const key of used)
    assert.ok(SOURCE.includes(`'${key}'`), `locale key ${key} is missing from client.js`)
})

test('the manifest declares the client entry point and platform', () => {
  const clientPath = MANIFEST.exports['./client']
  assert.equal(typeof clientPath, 'string')
  // The Host resolves this path and silently drops the module when the file is missing, so the
  // export must point at the real file (a wrong path shows up as "our dock never appears").
  assert.ok(statSync(new URL(`../${clientPath.replace('./', '')}`, import.meta.url)).isFile())
  assert.ok(MANIFEST.files.includes('client'))
  assert.equal(MANIFEST.dsh.client.platform, 'web')
  assert.equal(MANIFEST.dsh.client.immediately, true)
  assert.deepEqual(MANIFEST.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-conversation'])
  assert.equal(MANIFEST.dsh.bundle.patch, './cordis.patch.yml', 'the host bundle entry survives')
})

test('the client styles use only host theme tokens', () => {
  const css = SOURCE.match(/(['"`])(?:[\s\S]*?)var\(--dsw-alias-[^)]+\)/g) ?? []
  assert.ok(css.length > 0, 'the client styles reference the theme')
  // A literal colour or a private radius would stop the dock following the host theme.
  const styleBlocks = SOURCE.split('const DOCK_CSS').slice(1).join('')
  const literal = styleBlocks.match(/#[0-9a-fA-F]{3,6}\b|rgb\(|hsl\(/g) ?? []
  assert.deepEqual(literal, [], 'no literal colours in the dock styles')
})
