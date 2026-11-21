/* global window */
// Browser half of dsh-task-folding (docs/03 §9, docs/10 §11): the loader entry. It registers the
// module under the package name, fetches its package-local chunks, and wires the dictionary, the
// dock and the settings card to the Client services. The Host computes the wire view
// (`taskFolding`); the components only render it and never fold session events themselves.
//
// A plugin's client half is a classic loader script, not an ES module, so it cannot `import` its
// siblings. The host serves package-local chunks on demand — a file in this bundle's own directory
// whose name starts with `client.` (the loader's chunk contract) — and the module fetches them with
// `require.async`. That is why the component files are named `client.dock.js` and
// `client.settings-card.js`: the chunk protocol, not taste, fixes the prefix.

window.__ModuleLoader__.load({
  id: 'dsh-task-folding',
  factory(require) {
    /** Locale namespace owned by this module (registered through the Client locale service). */
    const NS = 'taskFolding'
    /** This package's name: the key the Plugins page dispatches `plugins.bundle.config` with. */
    const BUNDLE_KEY = 'dsh-task-folding'
    /**
     * Settings namespace of the bundle's Host row. `settings.describe()` keys every namespace by
     * the Loader entry id (`dsh-settings/src/index.ts`: `ns: entry.options.id`), and the bundle's
     * `cordis.patch.yml` declares that row id as the package name.
     */
    const SETTINGS_NS = 'dsh-task-folding'
    /** Full-width entries above the composer card; renders on the home screen and in conversations. */
    const DOCK_SLOT = 'conversation.input.dock'
    /** A bundle's own configuration, keyed by the bundle's package name on its Plugins page. */
    const CONFIG_SLOT = 'plugins.bundle.config'
    const DOCK_ID = 'task-folding'
    /** Ascending order beside the shipped docks: after todo (0) and goal (10), before the attached queue panel (20). */
    const DOCK_ORDER = 15

    /** English copy, generated from `locale/en.json` by `npm run locale:gen` (docs/10 §11). This file
     * is a classic loader script served as one bundle, so it cannot `import` the generated module;
     * the host serves that module as a package-local chunk and the loader fetches it with
     * `require.async`. The dictionary is not duplicated here: the generated file is the copy. */
    const DICTIONARY = require.async('./client.locale.generated.js')
    /** The dock component and the settings card, one chunk each (see the header). */
    const DOCK = require.async('./client.dock.js')
    const CARD = require.async('./client.settings-card.js')

    /**
     * One observable over the Host configuration form. The Client settings service may arrive after
     * this module and may be replaced when its plugin reloads, so the binding is lazy: every read and
     * subscription tracks the current form, and `refresh` republishes after the service appears.
     * The snapshot stays the form's own `ConfigFormSnapshot`, so a selector reads `value.showTaskBar`.
     */
    function createSettingsSource(readForm) {
      let bound
      let off
      const listeners = new Set()
      const emit = () => {
        for (const listener of listeners) listener()
      }
      const sync = () => {
        const form = readForm()
        if (form === bound) return
        if (off !== undefined) off()
        bound = form
        off = form === undefined ? undefined : form.subscribe(emit)
      }
      return {
        getSnapshot() {
          sync()
          return bound === undefined ? undefined : bound.getSnapshot()
        },
        subscribe(listener) {
          listeners.add(listener)
          sync()
          return () => {
            listeners.delete(listener)
          }
        },
        refresh() {
          sync()
          emit()
        },
      }
    }

    return {
      inject: ['slots', 'locale'],
      async apply(ctx) {
        // The dictionary and both components are package-local chunks, so they arrive as promises:
        // the plugin's own activation waits for them once, and the locale is registered only with
        // the packaged copy.
        const [{ en }, dock, card] = await Promise.all([DICTIONARY, DOCK, CARD])
        ctx.effect(() => ctx.locale.register(NS, { en }), 'task-folding: UI dictionaries')

        // The Host configuration form of this bundle's row, once the Client settings service serves
        // it; both surfaces read through one form so a write from the card reaches the dock at once.
        let form
        const settings = createSettingsSource(() => form)
        ctx.inject(['configForms'], (scope) => {
          form = scope.configForms.get(SETTINGS_NS)
          scope.effect(
            () => () => {
              form = undefined
              settings.refresh()
            },
            'task-folding: configuration form',
          )
          settings.refresh()
        })

        const writeField = (key, value) => {
          const current = form
          return current === undefined ? Promise.resolve(false) : current.set(key, value)
        }

        ctx.slots.inject(DOCK_SLOT, () =>
          ctx.slots.register(
            {
              name: DOCK_SLOT,
              id: DOCK_ID,
              order: DOCK_ORDER,
              locale: NS,
              inject: () => ({ hooks: { showTaskBar: settings } }),
            },
            dock.TaskFoldingDock,
          ),
        )

        ctx.slots.inject(CONFIG_SLOT, () =>
          ctx.slots.register(
            {
              name: CONFIG_SLOT,
              key: BUNDLE_KEY,
              locale: NS,
              inject: () => ({ hooks: { settings }, writeField }),
            },
            card.TaskFoldingSettings,
          ),
        )
      },
    }
  },
})
