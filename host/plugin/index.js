// The plugin object the host mounts (docs/02-host-api.md §1): its name, the services it injects,
// the optional Config schema and the apply function. Everything that touches the host context lives
// in `mount.js`; this module only assembles the object and resolves the Config schema the host
// uses to render the bundle's settings row.
//
// The schema builder is resolved at import time because the host reads `plugin.Config` before it
// calls `apply`; a host that does not carry schemastery simply gets a plugin without Config, which
// runs on the defaults.

import { buildConfig } from '../domain/settings.js'
import { PLUGIN_NAME, loadSchemastery } from '../ports/host-services.js'
import { apply, inject } from './mount.js'

/** The host services this plugin injects; the host refuses to mount it without them. */
export { inject }

/** The host's schema builder, or null when it cannot be resolved (the plugin then runs with defaults). */
const schemastery = await loadSchemastery()

/** The Config schema, absent when the host's schemastery cannot be resolved. */
export const Config = schemastery === null ? undefined : buildConfig(schemastery)

/** @type {any} */
const plugin = {
  name: PLUGIN_NAME,
  inject,
  ...(Config === undefined ? {} : { Config }),
  apply,
}

export default plugin
