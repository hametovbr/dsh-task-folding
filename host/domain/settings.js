// The plugin's Config schema and the readers that turn it into safe values (docs/03 §10).
// Readers never throw: an invalid or missing value falls back to its default.

/**
 * @typedef {object} Settings
 * @property {number} minSpanTokens
 * @property {boolean} delegateEnabled
 * @property {number} minSummaryChars
 * @property {number} maxSummaryRatio
 * @property {number} staleTaskSteps
 * @property {boolean} showTaskBar
 * @property {string} summarizationProvider
 * @property {string} summarizationModel
 */

/** @typedef {{ kind: 'number', def: number, min: number, max: number, integer: boolean } | { kind: 'boolean', def: boolean } | { kind: 'string', def: string }} Field */

/** @type {Readonly<Record<keyof Settings, Field>>} */
export const FIELDS = Object.freeze({
  minSpanTokens: { kind: 'number', def: 2000, min: 0, max: 1_000_000, integer: true },
  delegateEnabled: { kind: 'boolean', def: true },
  minSummaryChars: { kind: 'number', def: 200, min: 0, max: 10_000, integer: true },
  maxSummaryRatio: { kind: 'number', def: 0.5, min: 0.05, max: 0.9, integer: false },
  staleTaskSteps: { kind: 'number', def: 25, min: 5, max: 1000, integer: true },
  showTaskBar: { kind: 'boolean', def: false },
  summarizationProvider: { kind: 'string', def: '' },
  summarizationModel: { kind: 'string', def: '' },
})

/** @type {Readonly<Record<keyof Settings, string>>} */
const DESCRIPTIONS = Object.freeze({
  minSpanTokens: 'A closed task smaller than this many tokens is never folded.',
  delegateEnabled: 'Summarize a task automatically when its own summary is missing or unusable.',
  minSummaryChars: 'A task summary shorter than this is treated as missing.',
  maxSummaryRatio: 'A task summary larger than this share of the task is treated as unusable.',
  staleTaskSteps: 'Remind the model about a task that stays open for this many steps.',
  showTaskBar: 'Show open and folding tasks above the composer.',
  summarizationProvider: 'Provider for automatic summaries; empty uses the session route.',
  summarizationModel: 'Model for automatic summaries; set together with the provider.',
})

/** @returns {Settings} */
export function defaults() {
  return /** @type {Settings} */ (
    Object.fromEntries(Object.entries(FIELDS).map(([key, field]) => [key, field.def]))
  )
}

/**
 * Build the Config schema with the host's schemastery module.
 *
 * @param {any} z the default export of @deepseek-ai/schemastery
 */
export function buildConfig(z) {
  /** @type {Record<string, any>} */
  const shape = {}
  for (const [key, field] of Object.entries(FIELDS)) {
    let schema
    if (field.kind === 'number') {
      schema = z.number().min(field.min).max(field.max)
      if (field.integer) schema = schema.step(1)
    } else if (field.kind === 'boolean') schema = z.boolean()
    else schema = z.string()
    shape[key] = schema
      .default(field.def)
      .description(DESCRIPTIONS[/** @type {keyof Settings} */ (key)])
      .volatile()
  }
  return z.object(shape)
}

/**
 * Read the current settings from the resolved config. Each field may be a volatile
 * (`{ get() }`), a plain value, or missing.
 *
 * @param {unknown} config
 * @returns {Settings}
 */
export function readSettings(config) {
  const source =
    typeof config === 'object' && config !== null ? /** @type {Record<string, unknown>} */ (config) : {}
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [key, field] of Object.entries(FIELDS)) out[key] = clamp(field, current(source[key]))
  return /** @type {Settings} */ (out)
}

/** @param {unknown} value */
function current(value) {
  if (typeof value === 'object' && value !== null && typeof (/** @type {any} */ (value).get) === 'function') {
    try {
      return /** @type {any} */ (value).get()
    } catch {
      return undefined
    }
  }
  return value
}

/**
 * @param {Field} field
 * @param {unknown} value
 */
export function clamp(field, value) {
  if (field.kind === 'boolean') return typeof value === 'boolean' ? value : field.def
  if (field.kind === 'string') return typeof value === 'string' ? value.trim() : field.def
  if (typeof value !== 'number' || !Number.isFinite(value)) return field.def
  const n = field.integer ? Math.round(value) : value
  return Math.min(field.max, Math.max(field.min, n))
}
