// The browser half (docs/03 §9): the module loads in the Client's loader form, registers its two
// slots, and registers the packaged dictionary that `npm run locale:gen` writes. No browser is
// needed for this: both client scripts are classic scripts over a fake `window.__ModuleLoader__`.

import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { test } from 'node:test'

const SOURCE = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const GENERATED = readFileSync(new URL('../client/client.locale.generated.js', import.meta.url), 'utf8')
const LOCALE = JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))
const MANIFEST = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** The chunk name `client/client.js` requests and the host's chunk route accepts. */
const CHUNK = 'client.locale.generated.js'

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
 * Execute one classic client script the way the browser's loader does, and return everything it
 * registered (the bundle registers itself with `id`; a package-local chunk adds `chunk`).
 *
 * @param {string} source
 * @returns {any[]}
 */
function registrationsOf(source) {
  /** @type {any[]} */
  const registrations = []
  const window = { __ModuleLoader__: { load: (/** @type {any} */ entry) => registrations.push(entry) } }
  new Function('window', source)(window)
  return registrations
}

/**
 * The generated dictionary chunk, registered the way the host's on-demand chunk route makes the
 * loader execute it.
 *
 * @returns {any}
 */
function generatedChunk() {
  const chunk = registrationsOf(GENERATED).find((entry) => entry.chunk === CHUNK)
  assert.ok(chunk, `the generated locale must register the ${CHUNK} chunk`)
  return chunk
}

/**
 * Load both client scripts the way the browser's loader does: the chunk arrives through
 * `require.async`, and the module's factory receives the same `require`.
 *
 * @returns {Promise<{ id: string, plugin: any, registered: any[], locales: [string, any][] }>}
 */
async function loadClient() {
  const chunks = registrationsOf(GENERATED)
  /** @type {any} */
  const require = (/** @type {string} */ name) => {
    if (name === 'react') return React
    throw new Error(`the client module must not require ${name}`)
  }
  require.async = async (/** @type {string} */ spec) => {
    if (spec !== `./${CHUNK}`) throw new Error(`the client module must not load ${spec}`)
    const chunk = chunks.find((entry) => entry.chunk === CHUNK)
    if (chunk === undefined) throw new Error('the generated locale chunk is not registered')
    return chunk.factory(require)
  }
  const captured = registrationsOf(SOURCE).find(
    (entry) => entry.id === MANIFEST.name && entry.chunk === undefined,
  )
  assert.ok(captured, 'the client bundle must register itself under the package name')
  const plugin = captured.factory(require)
  /** @type {any[]} */
  const registered = []
  /** @type {[string, any][]} */
  const locales = []
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
    locale: {
      /** @param {string} ns @param {any} dictionary */
      register: (ns, dictionary) => {
        locales.push([ns, dictionary])
        return () => {}
      },
      t: (/** @type {string} */ key) => key,
    },
    inject: () => {},
    get: () => undefined,
  }
  await plugin.apply(ctx)
  return { id: captured.id, plugin, registered, locales }
}

test('the client module loads with the package id and registers both slots', async () => {
  const client = await loadClient()
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

test('the generated locale equals the packaged client section', () => {
  assert.equal(LOCALE.meta.title, 'Task folding')
  assert.ok(LOCALE.meta.description.length > 0)
  const chunk = generatedChunk()
  assert.equal(chunk.id, MANIFEST.name, 'the chunk must register under the owning package')
  assert.equal(chunk.chunk, CHUNK)
  const exports = chunk.factory(() => {
    throw new Error('the generated dictionary requests no module')
  })
  assert.deepEqual(exports, { en: LOCALE.client }, 'locale:gen must emit exactly locale/en.json')
  assert.ok(Object.keys(LOCALE.client).length >= 20, 'the client section is the whole dictionary')
})

test('the client module registers the packaged dictionary and keeps no copy of its own', async () => {
  const client = await loadClient()
  assert.equal(client.locales.length, 1, 'one locale namespace registration')
  const locale = client.locales[0]
  assert.ok(locale, 'the module registers one locale namespace')
  const [ns, dictionary] = locale
  assert.equal(ns, 'taskFolding')
  assert.deepEqual(dictionary.en, LOCALE.client)
  // The old inline copy is gone: the bundle only requests the generated chunk, so the packaged JSON
  // and the browser dictionary cannot drift apart (docs/10 §11).
  assert.match(SOURCE, /require\.async\('\.\/client\.locale\.generated\.js'\)/)
  assert.equal(
    SOURCE.includes("'settings.fields.minSpanTokens.description':"),
    false,
    'client.js must not carry its own dictionary',
  )
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
