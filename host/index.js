// The package entry (docs/10 §3, rule 1): a thin module that re-exports the plugin object and the
// names the host and the tests read. The implementation lives in `plugin/`; nothing else belongs
// here, so the host's module entry cannot grow a second concern.

export { default } from './plugin/index.js'
export { Config, inject } from './plugin/index.js'
export {
  DELEGATE_BUDGET_TOKENS,
  DELEGATE_MAX_TOKENS,
  ENGINE_UNAVAILABLE,
  PLUGIN_NAME,
} from './plugin/mount.js'
export { PROMPT_ORDER } from './prompt/section.js'
