#!/usr/bin/env node
// Browser E2E for the client half (docs/09-testing-plan.md T6; closes docs/08-followups.md F7):
// the settings card renders on the plugin's page, a card write reaches the profile patch, and
// `showTaskBar` really drives the dock in a conversation. The Host composes the client roster and
// the settings transport, so only a live page can prove the chain docs/08 F7 could not see.
//
//   node scripts/e2e-browser.js --url 'http://127.0.0.1:PORT/?token=...' \
//     --patch .f7-scratch/profiles/f7/cordis.patch.yml [--session dock] [--keep-browser]
//
// Preconditions, all checked by this script:
//   - a `dsh web` server is running and the URL is the token URL it printed;
//   - the profile has dsh-task-folding installed and enabled, and its settings card is writable;
//   - a session in this server has a task that is still open, so the dock has something to render.
//     Open one with `task_begin` (for example through the web composer) before running the checks.
//
// The script drives the ego-browser runtime shipped with the DSH web profile, but in its own
// state/data directory under `.tmp/` with its own headless browser, so it never touches the
// browser the Settings → Agent Browser page uses. `--ego` and `--chrome` override discovery.
//
// It prints one PASS/FAIL line per assertion and exits non-zero when any assertion fails.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SENTINEL = '@@DSH_RESULT@@'
const DEFAULT_TIMEOUT_MS = 30_000
/** The two packages whose presence the dock depends on: ours and the injected conversation UI. */
const CLIENT_PACKAGE = 'dsh-task-folding'
const INJECTED_PACKAGE = '@deepseek-ai/dsh-client-ui-conversation'

const USAGE = `Usage: node scripts/e2e-browser.js --url <authenticated dsh web URL> --patch <profile cordis.patch.yml> [options]

Options:
  --url <url>          the token URL printed by \`dsh web\` (required)
  --patch <path>       the profile cordis.patch.yml the card's write must reach (required)
  --session <text>     pick the sidebar session whose title contains <text> (default: first)
  --ego <path>         ego-browser runtime entry (default: EGO_BROWSER_BIN, then the web profile copy)
  --chrome <path>      Chrome binary (default: EGO_LINUX_CHROME, then Playwright's Chromium)
  --state-dir <path>   ego state/data root (default: <repo>/.tmp/e2e-browser)
  --space <name>       ego task space to use (default: dsh-e2e-browser)
  --timeout <ms>       per-wait timeout (default: ${DEFAULT_TIMEOUT_MS})
  --keep-browser       leave the headless browser running after the run
  --help               show this text`

/**
 * @typedef {object} Options
 * @property {string} url
 * @property {string} patch
 * @property {string} session
 * @property {string} ego
 * @property {string} chrome
 * @property {string} stateDir
 * @property {string} space
 * @property {number} timeoutMs
 * @property {boolean} keepBrowser
 */

/**
 * Print the usage line and one error, then exit.
 * @param {string} message
 * @returns {never}
 */
function die(message) {
  console.error(`e2e-browser: ${message}`)
  console.error(USAGE)
  process.exit(2)
}

/**
 * Parse `--flag value` and `--flag=value` arguments.
 * @param {string[]} argv
 * @returns {Options}
 */
function parseOptions(argv) {
  /** @type {Record<string, string>} */
  const values = {}
  let keepBrowser = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === undefined) continue
    if (argument === '--help' || argument === '-h') {
      console.log(USAGE)
      process.exit(0)
    }
    if (argument === '--keep-browser') {
      keepBrowser = true
      continue
    }
    const equals = argument.indexOf('=')
    const name = equals === -1 ? argument : argument.slice(0, equals)
    if (equals !== -1) {
      values[name] = argument.slice(equals + 1)
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) die(`${name} needs a value`)
    values[name] = value
    index += 1
  }
  for (const name of Object.keys(values)) {
    if (
      !['--url', '--patch', '--session', '--ego', '--chrome', '--state-dir', '--space', '--timeout'].includes(
        name,
      )
    ) {
      die(`unknown option ${name}`)
    }
  }
  const url = values['--url']
  if (url === undefined) die('--url is required')
  try {
    new URL(url)
  } catch {
    die(`--url is not a valid URL: ${url}`)
  }
  const patch = values['--patch']
  if (patch === undefined) die('--patch is required: the profile cordis.patch.yml the write must reach')
  const timeout = Number(values['--timeout'] ?? DEFAULT_TIMEOUT_MS)
  if (!Number.isFinite(timeout) || timeout <= 0) die('--timeout must be a positive number of milliseconds')
  return {
    url,
    patch: path.resolve(patch),
    session: values['--session'] ?? '',
    ego: values['--ego'] ?? '',
    chrome: values['--chrome'] ?? '',
    stateDir: path.resolve(values['--state-dir'] ?? path.join(ROOT, '.tmp', 'e2e-browser')),
    space: values['--space'] ?? 'dsh-e2e-browser',
    timeoutMs: timeout,
    keepBrowser,
  }
}

/**
 * The first existing path of a candidate list.
 * @param {string[]} candidates
 * @returns {string | undefined}
 */
function firstExisting(candidates) {
  return candidates.find((candidate) => candidate !== '' && existsSync(candidate))
}

/**
 * Locate the vendored ego-browser runtime the DSH web profile ships.
 * @param {string} explicit
 * @returns {string}
 */
function findEgoBin(explicit) {
  const found = firstExisting([
    explicit,
    process.env.EGO_BROWSER_BIN ?? '',
    path.join(ROOT, 'node_modules', 'dsh-ego-browser', 'runtime', 'ego-linux', 'bin', 'ego-browser.mjs'),
    path.join(
      os.homedir(),
      '.dsh',
      'profiles',
      'web',
      'node_modules',
      'dsh-ego-browser',
      'runtime',
      'ego-linux',
      'bin',
      'ego-browser.mjs',
    ),
  ])
  if (found === undefined) {
    die('cannot find ego-browser; pass --ego <path> or set EGO_BROWSER_BIN')
  }
  return found
}

/**
 * Locate a Chrome binary: the ego runtime cannot start one on this host without an explicit path
 * when Playwright owns the only Chromium.
 * @param {string} explicit
 * @returns {string}
 */
function findChrome(explicit) {
  /** @type {string[]} */
  const candidates = [explicit, process.env.EGO_LINUX_CHROME ?? '']
  const playwright = path.join(os.homedir(), '.cache', 'ms-playwright')
  if (existsSync(playwright)) {
    const builds = readdirSync(playwright)
      .filter((entry) => entry.startsWith('chromium-'))
      .sort()
      .reverse()
    for (const build of builds) {
      candidates.push(path.join(playwright, build, 'chrome-linux64', 'chrome'))
      candidates.push(path.join(playwright, build, 'chrome-linux', 'chrome'))
    }
  }
  candidates.push(
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  )
  const found = firstExisting(candidates)
  if (found === undefined) {
    die('cannot find a Chrome binary; pass --chrome <path> or set EGO_LINUX_CHROME')
  }
  return found
}

/**
 * The task-control snippet every generated ego script starts with. It is executed by the
 * ego-browser Node runtime, where `page`, `browser` and `taskSpaces` are preloaded facades.
 * @param {Options} options
 * @param {boolean} restore the Task bar value the restore phase must put back
 * @returns {string}
 */
function prelude(options, restore) {
  const config = {
    url: options.url,
    session: options.session,
    timeout: options.timeoutMs,
    space: options.space,
  }
  return `
const CFG = ${JSON.stringify(config)}
const RESTORE = ${JSON.stringify(restore)}
const emit = (payload) => console.log(${JSON.stringify(SENTINEL)} + JSON.stringify(payload))
const wait = (ms) => page.waitForTimeout(ms)
async function openApp() {
  const connect = () => browser.openOrReuseTab(CFG.url, { match: 'origin', wait: true, timeout: 30000 })
  // The first call after a cold browser start can race the DevTools channel; one retry is the
  // documented cold-start behaviour of the vendored runtime, not a product failure.
  try {
    await connect()
  } catch {
    await wait(1000)
    await connect()
  }
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const ready = await page.evaluate(() => !!(window.__DSH_BOOT__ && Array.isArray(window.__DSH_BOOT__.entries)))
    if (ready) {
      await collectErrors()
      return
    }
    await wait(250)
  }
  throw new Error('the DSH web app did not boot: window.__DSH_BOOT__.entries never appeared')
}
async function dismissNotice() {
  const cont = page.getByRole('button', { name: 'Continue' })
  if ((await cont.count()) > 0) await cont.first().click().catch(() => {})
}
async function openPluginPage() {
  await dismissNotice()
  await page.getByRole('button', { name: 'Plugins' }).first().click()
  const view = page.getByRole('button', { name: 'View Task folding' })
  await view.waitFor({ state: 'visible', timeout: CFG.timeout })
  await view.click()
  await page.locator('[data-task-folding-settings]').waitFor({ state: 'visible', timeout: CFG.timeout })
}
async function openSession() {
  const rows = page.locator('button[aria-label^="Session actions for "]')
  try {
    await rows.first().waitFor({ state: 'visible', timeout: CFG.timeout })
  } catch {
    throw new Error('no session in the sidebar: open a session with an open task before running this check')
  }
  const count = await rows.count()
  let chosen = -1
  for (let index = 0; index < count; index += 1) {
    const label = await rows.nth(index).getAttribute('aria-label')
    if (CFG.session === '' || (label !== null && label.includes(CFG.session))) {
      chosen = index
      break
    }
  }
  if (chosen < 0) throw new Error('no session title contains ' + JSON.stringify(CFG.session))
  const label = await rows.nth(chosen).getAttribute('aria-label')
  await rows.nth(chosen).evaluate((element) => {
    const row = element.closest('[role=treeitem]') || element.parentElement
    if (row !== null) row.click()
  })
  await wait(700)
  return label
}
// Address the control by its visible label, not by field order: the card's schema may grow, and
// the label text comes from the packaged locale (settings.fields.showTaskBar.label).
async function taskBar() {
  return page.evaluate(() => {
    const root = document.querySelector('[data-task-folding-settings]')
    if (root === null) return null
    const fields = [...root.querySelectorAll('.task-folding-field')]
    for (const field of fields) {
      const label = field.querySelector('.task-folding-field-label')
      if (label === null || !/task bar/i.test(label.textContent || '')) continue
      const box = field.querySelector('input[type=checkbox]')
      return box === null ? null : box.checked
    }
    return null
  })
}
async function waitTaskBar() {
  const deadline = Date.now() + CFG.timeout
  let observed = await taskBar()
  while (Date.now() < deadline && observed === null) {
    // The card first paints its "unavailable" shell while the settings mirror is still loading;
    // the fields and their controls follow on the next snapshot.
    await wait(250)
    observed = await taskBar()
  }
  return observed
}
async function clickTaskBar() {
  await page.evaluate(() => {
    const root = document.querySelector('[data-task-folding-settings]')
    if (root === null) return
    const fields = [...root.querySelectorAll('.task-folding-field')]
    for (const field of fields) {
      const label = field.querySelector('.task-folding-field-label')
      if (label === null || !/task bar/i.test(label.textContent || '')) continue
      const box = field.querySelector('input[type=checkbox]')
      if (box !== null) box.click()
      return
    }
  })
}
async function setTaskBar(target) {
  const before = await waitTaskBar()
  if (before === null) throw new Error('the settings card has no Task bar checkbox')
  let clicked = false
  if (before !== target) {
    await clickTaskBar()
    clicked = true
  }
  const deadline = Date.now() + CFG.timeout
  let observed = before
  while (Date.now() < deadline) {
    observed = await taskBar()
    if (observed === target) break
    await wait(250)
  }
  return { before, observed, clicked }
}
async function cardError() {
  return page.evaluate(() => {
    const note = document.querySelector('[data-task-folding-settings] [role=status]')
    return note === null ? null : note.textContent
  })
}
async function dockVisible() {
  return page.evaluate(() => !!document.querySelector('[data-task-folding-dock]'))
}
async function waitDock(wanted) {
  const deadline = Date.now() + CFG.timeout
  let observed = await dockVisible()
  while (Date.now() < deadline && observed !== wanted) {
    await wait(250)
    observed = await dockVisible()
  }
  return observed
}
const task = await taskSpaces.useOrCreate(CFG.space)
// Surface client-side failures a failed assertion would otherwise hide: the app is a script graph,
// so a chunk that throws leaves a rendered shell with no clue in the DOM.
async function collectErrors() {
  return page
    .evaluate(() => {
      if (Array.isArray(window.__e2eErrors)) return window.__e2eErrors.slice(-5)
      window.__e2eErrors = []
      addEventListener('error', (event) => window.__e2eErrors.push(String(event.message || event.error)))
      addEventListener('unhandledrejection', (event) =>
        window.__e2eErrors.push('unhandledrejection: ' + String(event.reason)),
      )
      return []
    })
    .catch(() => [])
}
`
}

/** One generated ego script body per phase. Each body receives the prelude above. */
const PHASES = {
  /** Read the boot graph, open the card and write the setting on. */
  inspect: `
await openApp()
const entries = await page.evaluate(() => (window.__DSH_BOOT__ && window.__DSH_BOOT__.entries) || [])
await openPluginPage()
const hasTaskBar = (await waitTaskBar()) !== null
if (!hasTaskBar) {
  const diag = await page.evaluate(() => {
    const root = document.querySelector('[data-task-folding-settings]')
    return {
      card: root !== null,
      fields: root === null ? 0 : root.querySelectorAll('.task-folding-field').length,
      notes: root === null ? [] : [...root.querySelectorAll('p')].map((node) => node.textContent),
      body: document.body ? document.body.innerText.slice(0, 240) : '',
    }
  })
  emit({ fatal: 'no Task bar control', diag, errors: await collectErrors() })
  throw new Error('the Task bar control never appeared: ' + JSON.stringify({ diag, errors: await collectErrors() }))
}
const card = await page.evaluate(() => {
  const root = document.querySelector('[data-task-folding-settings]')
  if (root === null) return null
  return {
    inputs: root.querySelectorAll('input').length,
    labels: [...root.querySelectorAll('.task-folding-field-label')].map((node) => node.textContent),
  }
})
let write = await setTaskBar(true)
if (!write.clicked) {
  // The card already showed the value: write the other way first so this run still proves a
  // write, not an unchanged document.
  await setTaskBar(false)
  write = await setTaskBar(true)
}
emit({ entries, card, hasTaskBar, write, error: await cardError() })
`,
  /** Open the prepared session and wait for the dock. */
  dock: `
await openApp()
const label = await openSession()
const visible = await waitDock(true)
const text = await page.evaluate(() => {
  const dock = document.querySelector('[data-task-folding-dock]')
  return dock === null ? '' : (dock.innerText || '').trim()
})
emit({ label, visible, text })
`,
  /** Turn the dock off from the card. */
  disable: `
await openApp()
await openPluginPage()
const write = await setTaskBar(false)
emit({ write, error: await cardError() })
`,
  /** The dock must be gone, and it must still be gone after a reload. */
  hidden: `
await openApp()
await openSession()
const before = await waitDock(false)
await page.reload()
const bootDeadline = Date.now() + 30000
while (Date.now() < bootDeadline) {
  const ready = await page.evaluate(() => !!window.__DSH_BOOT__).catch(() => false)
  if (ready) break
  await wait(250)
}
await openSession()
const after = await waitDock(false)
emit({ before, after })
`,
  /** Put the card back where the run found it. */
  restore: `
await openApp()
await openPluginPage()
const write = await setTaskBar(RESTORE)
emit({ write, error: await cardError() })
`,
}

/** The PASS/FAIL record of one assertion. */
class Report {
  constructor() {
    /** @type {{ name: string, ok: boolean, detail: string }[]} */
    this.rows = []
  }

  /**
   * @param {string} name
   * @param {boolean} ok
   * @param {string} [detail]
   */
  check(name, ok, detail = '') {
    this.rows.push({ name, ok, detail })
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }

  /** @returns {boolean} */
  get passed() {
    return this.rows.every((row) => row.ok)
  }
}

/**
 * Run one generated ego script and return its emitted payload.
 * @param {Options} options
 * @param {string} egoBin
 * @param {string} body
 * @returns {Promise<any>}
 */
function runEgo(options, egoBin, body, restore = false) {
  const script = prelude(options, restore) + body
  // Keep the last generated script on disk: when an assertion fails, the fastest way to see what
  // the browser was asked to do is to read (or replay) this file.
  writeFileSync(path.join(options.stateDir, 'last-script.js'), script)
  const env = {
    ...process.env,
    XDG_STATE_HOME: path.join(options.stateDir, 'state'),
    XDG_DATA_HOME: path.join(options.stateDir, 'data'),
    EGO_LINUX_HEADLESS: process.env.EGO_LINUX_HEADLESS ?? '1',
    EGO_LINUX_CHROME: options.chrome,
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [egoBin, 'nodejs'], {
      cwd: ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    /** @type {Buffer[]} */
    const stdout = []
    /** @type {Buffer[]} */
    const stderr = []
    child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    // The first call of a run starts the headless browser; on a cold profile that start is much
    // slower than any in-page wait, so the process budget is wider than the per-wait timeout.
    const budget = Math.max(options.timeoutMs * 10, 300_000)
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`ego-browser did not finish within ${budget} ms`))
    }, budget)
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      const out = Buffer.concat(stdout).toString('utf8')
      const err = Buffer.concat(stderr).toString('utf8')
      if (code !== 0) {
        const lines = out.split('\n').filter((line) => line.startsWith(SENTINEL))
        const detail = lines.at(-1)
        reject(
          new Error(
            `ego-browser exited with ${String(code)}: ${err.trim().slice(-1500)}` +
              (detail === undefined ? '' : ` | payload: ${detail.slice(SENTINEL.length)}`),
          ),
        )
        return
      }
      const lines = out.split('\n').filter((line) => line.startsWith(SENTINEL))
      const last = lines.at(-1)
      if (last === undefined) {
        reject(new Error(`ego-browser printed no ${SENTINEL} payload: ${out.trim().slice(-1500)}`))
        return
      }
      try {
        resolve(JSON.parse(last.slice(SENTINEL.length)))
      } catch (error) {
        reject(new Error(`cannot parse the ego payload: ${String(error)}`))
      }
    })
    child.stdin?.end(script)
  })
}

/**
 * Read `showTaskBar` out of the profile patch, or undefined when the row or field is absent.
 * @param {string} patchPath
 * @returns {boolean | undefined}
 */
function patchShowTaskBar(patchPath) {
  let text
  try {
    text = readFileSync(patchPath, 'utf8')
  } catch {
    return undefined
  }
  const rows = text.split(/\n(?=- )/u)
  const row = rows.find((candidate) =>
    /^- id:\s*(['"]?)dsh-task-folding\1\s*$/mu.test(candidate.split('\n')[0] ?? ''),
  )
  if (row === undefined) return undefined
  const match = /^\s+showTaskBar:\s*(true|false)\s*$/mu.exec(row)
  if (match === null) return undefined
  return match[1] === 'true'
}

/**
 * Poll the patch for the expected value, giving the Host's write a moment to settle.
 * @param {string} patchPath
 * @param {boolean} expected
 * @returns {Promise<boolean | undefined>}
 */
async function waitForPatch(patchPath, expected) {
  const deadline = Date.now() + 5000
  let observed = patchShowTaskBar(patchPath)
  while (Date.now() < deadline && observed !== expected) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    observed = patchShowTaskBar(patchPath)
  }
  return observed
}

/**
 * Stop the headless browser this script started, so repeated runs do not accumulate processes.
 * @param {Options} options
 * @param {string} egoBin
 */
async function stopBrowser(options, egoBin) {
  if (options.keepBrowser) return
  const env = {
    ...process.env,
    XDG_STATE_HOME: path.join(options.stateDir, 'state'),
    XDG_DATA_HOME: path.join(options.stateDir, 'data'),
    EGO_LINUX_CHROME: options.chrome,
  }
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [egoBin, '--stop'], { cwd: ROOT, env, stdio: 'ignore' })
    child.on('close', () => resolve(undefined))
    child.on('error', () => resolve(undefined))
  })
}

/** The assertions this run must report, in output order. */
const EXPECTED = [
  `client module ${CLIENT_PACKAGE} is in the boot graph`,
  `the injected client package ${INJECTED_PACKAGE} is in the boot graph`,
  'the settings card renders on the plugin page',
  'the Task bar control accepts the on write',
  'the card write reaches the profile cordis.patch.yml (showTaskBar: true)',
  'the dock renders above the composer with showTaskBar on',
  'the Task bar control accepts the off write',
  'the card write reaches the profile cordis.patch.yml (showTaskBar: false)',
  'the dock hides with showTaskBar off',
  'the off value survives a page reload',
]

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const egoBin = findEgoBin(options.ego)
  options.chrome = findChrome(options.chrome)
  mkdirSync(options.stateDir, { recursive: true })
  console.log(`e2e-browser: url ${options.url}`)
  console.log(`e2e-browser: patch ${options.patch}`)
  console.log(`e2e-browser: ego ${egoBin}`)
  console.log(`e2e-browser: chrome ${options.chrome}`)
  const report = new Report()
  /** @type {boolean | undefined} */
  let initial
  /** @type {string} */
  let failure = ''
  try {
    // 1. Boot graph, card and the on-write. The boot-graph entries are the live side of F8: the
    //    Host composes the injected conversation UI and our module into the same roster.
    const inspect = await runEgo(options, egoBin, PHASES.inspect)
    // The boot graph carries entry objects on this Host (`{ id, url, rev, inject }`) and plain ids
    // on older builds; normalize both.
    const entries = (Array.isArray(inspect.entries) ? inspect.entries : []).map((/** @type {any} */ entry) =>
      typeof entry === 'string' ? entry : entry?.id,
    )
    report.check(
      `client module ${CLIENT_PACKAGE} is in the boot graph`,
      entries.includes(CLIENT_PACKAGE),
      `boot entries: ${entries.length}`,
    )
    report.check(
      `the injected client package ${INJECTED_PACKAGE} is in the boot graph`,
      entries.includes(INJECTED_PACKAGE),
    )
    report.check(
      'the settings card renders on the plugin page',
      inspect.card !== null && inspect.card.inputs >= 8 && inspect.hasTaskBar === true,
      inspect.card === null
        ? 'the card did not render'
        : `inputs: ${String(inspect.card.inputs)}, Task bar control: ${String(inspect.hasTaskBar)}`,
    )
    report.check(
      'the Task bar control accepts the on write',
      inspect.write !== undefined && inspect.write.observed === true,
      `before ${String(inspect.write?.before)}, after ${String(inspect.write?.observed)}` +
        (inspect.error === null || inspect.error === undefined
          ? ''
          : `; card says: ${String(inspect.error)}`),
    )
    const patchOn = await waitForPatch(options.patch, true)
    report.check(
      'the card write reaches the profile cordis.patch.yml (showTaskBar: true)',
      patchOn === true,
      patchOn === undefined
        ? 'no dsh-task-folding row with showTaskBar in the patch'
        : `patch says ${String(patchOn)}`,
    )
    initial = inspect.write?.before === true

    // 2. The dock must render in the prepared session.
    const dock = await runEgo(options, egoBin, PHASES.dock)
    report.check(
      'the dock renders above the composer with showTaskBar on',
      dock.visible === true,
      dock.visible === true
        ? `dock: ${String(dock.text).slice(-60)}`
        : 'no [data-task-folding-dock] in the session (does it hold an open task?)',
    )

    // 3. Turning the value off through the card must hide the dock, live.
    const disable = await runEgo(options, egoBin, PHASES.disable)
    report.check(
      'the Task bar control accepts the off write',
      disable.write !== undefined && disable.write.observed === false,
      `before ${String(disable.write?.before)}, after ${String(disable.write?.observed)}`,
    )
    const patchOff = await waitForPatch(options.patch, false)
    report.check(
      'the card write reaches the profile cordis.patch.yml (showTaskBar: false)',
      patchOff === false,
      patchOff === undefined
        ? 'no dsh-task-folding row with showTaskBar in the patch'
        : `patch says ${String(patchOff)}`,
    )

    // 4. The dock is gone, and the off value survives a page reload. The restart half is the
    //    manual F7 check; the settings document is the same file either way.
    const hidden = await runEgo(options, egoBin, PHASES.hidden)
    report.check('the dock hides with showTaskBar off', hidden.before === false)
    report.check('the off value survives a page reload', hidden.after === false)
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
    report.check('the E2E scenario completes', false, failure)
  } finally {
    // 5. Restore the value the run found, so repeated runs start from the same state. Best effort:
    //    a broken page must not hide the assertion report.
    await runEgo(options, egoBin, PHASES.restore, initial === true).catch(() => {})
    await stopBrowser(options, egoBin)
  }
  // An early failure skips later assertions; report them as failures with the reason instead of
  // silently shortening the checklist.
  for (const name of EXPECTED) {
    if (report.rows.some((row) => row.name === name)) continue
    report.check(name, false, `not run${failure === '' ? '' : `: ${failure}`}`)
  }
  const failed = report.rows.filter((row) => !row.ok).length
  console.log(`\ne2e-browser: ${report.rows.length - failed}/${report.rows.length} assertions passed`)
  if (!report.passed || report.rows.length === 0) process.exitCode = 1
}

try {
  await main()
} catch (error) {
  console.error(`e2e-browser FAILED — ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
