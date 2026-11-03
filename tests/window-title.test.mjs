import assert from 'node:assert/strict'
import test from 'node:test'
import { loadPlugin } from './window-title-helpers.mjs'

test('renames the window without requiring the native preferences API', t => {
  const plugin = loadPlugin({ settingsApi: false })
  t.after(() => { plugin.dispose(); plugin.cleanupFixture() })
  assert.equal(plugin.settings.length, 0)
  assert.equal(plugin.contributions.filter(c => c.area === 'panes').length, 1)
  assert.equal(plugin.document.title, 'Hermes - default')
})

test('main window title follows the focused profile without changing the gateway', t => {
  const plugin = loadPlugin()
  t.after(() => { plugin.dispose(); plugin.cleanupFixture() })
  assert.equal(plugin.document.title, 'Hermes - default')
  plugin.focused.set('research')
  assert.equal(plugin.document.title, 'Hermes - research')
  assert.equal(plugin.profile.get(), 'default')
})

test('disabling restores the original title and removes title subscriptions', t => {
  const plugin = loadPlugin({ title: 'Original title' })
  t.after(() => plugin.cleanupFixture())
  const listenersWithTitle = plugin.profile.listenerCount()
  plugin.dispose()
  assert.equal(plugin.document.title, 'Original title')
  assert.equal(plugin.focused.listenerCount(), 0)
  assert.ok(plugin.profile.listenerCount() < listenersWithTitle)
  plugin.focused.set('disabled')
  plugin.profile.set('disabled')
  assert.equal(plugin.document.title, 'Original title')
})

test('disabling does not overwrite a title subsequently set by another owner', t => {
  const plugin = loadPlugin()
  t.after(() => plugin.cleanupFixture())
  plugin.document.title = 'A different owner'
  plugin.dispose()
  assert.equal(plugin.document.title, 'A different owner')
})

for (const kind of ['hud', 'overlay', 'quick', 'wake', 'browser', 'unknown']) {
  test(`does not rename the ${kind} auxiliary window`, t => {
    const plugin = loadPlugin({ search: `?win=${kind}`, title: 'Special title' })
    t.after(() => { plugin.dispose(); plugin.cleanupFixture() })
    plugin.focused.set('research')
    assert.equal(plugin.document.title, 'Special title')
    assert.equal(plugin.focused.listenerCount(), 0)
  })
}

test('falls back to the gateway and then default for missing focused profiles', t => {
  const plugin = loadPlugin()
  t.after(() => { plugin.dispose(); plugin.cleanupFixture() })
  plugin.profile.set('work')
  plugin.focused.set('  ')
  assert.equal(plugin.document.title, 'Hermes - work')
  plugin.profile.set('')
  assert.equal(plugin.document.title, 'Hermes - default')
  plugin.focused.set(null)
  assert.equal(plugin.document.title, 'Hermes - default')
})

test('supports older hosts without the focused-session profile atom', t => {
  const plugin = loadPlugin({ focusedApi: false })
  t.after(() => { plugin.dispose(); plugin.cleanupFixture() })
  plugin.profile.set('legacy')
  assert.equal(plugin.document.title, 'Hermes - legacy')
})

test('secondary chat windows retain their own independent title', t => {
  const main = loadPlugin()
  const secondary = loadPlugin({ search: '?win=secondary' })
  t.after(() => {
    main.dispose(); main.cleanupFixture()
    secondary.dispose(); secondary.cleanupFixture()
  })
  main.focused.set('main-profile')
  secondary.focused.set('other-profile')
  assert.equal(main.document.title, 'Hermes - main-profile')
  assert.equal(secondary.document.title, 'Hermes - other-profile')
})

test('profile names remain plain text and unchanged titles are not rewritten', t => {
  const plugin = loadPlugin()
  t.after(() => { plugin.dispose(); plugin.cleanupFixture() })
  const value = '<script>doNotExecute()</script> — étude'
  plugin.focused.set(value)
  assert.equal(plugin.document.title, `Hermes - ${value}`)
  const writes = plugin.titleWrites.length
  plugin.focused.set(value)
  plugin.profile.set('unchanged-focus')
  assert.equal(plugin.titleWrites.length, writes)
})

test('repeated disable and reactivation in one document do not accumulate title listeners', t => {
  const plugin = loadPlugin({ title: 'Original title' })
  t.after(() => { plugin.dispose(); plugin.cleanupFixture() })
  const initialProfileListeners = plugin.profile.listenerCount()
  for (let cycle = 0; cycle < 3; cycle++) {
    plugin.focused.set(`profile-${cycle}`)
    assert.equal(plugin.document.title, `Hermes - profile-${cycle}`)
    assert.equal(plugin.focused.listenerCount(), 1)
    assert.equal(plugin.profile.listenerCount(), initialProfileListeners)
    plugin.dispose()
    assert.equal(plugin.document.title, 'Original title')
    assert.equal(plugin.focused.listenerCount(), 0)
    plugin.activate()
    assert.equal(plugin.document.title, `Hermes - profile-${cycle}`)
  }
})
