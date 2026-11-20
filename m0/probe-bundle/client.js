window.__ModuleLoader__.load({
  id: 'tf-probe',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const tag = (slot) => function ProbeTag() {
      return h('div', { style: { fontSize: 11, opacity: 0.7, padding: '2px 6px' } }, 'TF-PROBE ' + slot)
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        for (const slot of ['conversation.composer.dock', 'conversation.input.dock']) {
          try {
            ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, id: 'tf-probe-' + slot, order: 99 }, tag(slot)))
            console.log('[tf-probe] registered', slot)
          } catch (err) {
            console.log('[tf-probe] failed', slot, String(err && err.message ? err.message : err))
          }
        }
      },
    }
  },
})
