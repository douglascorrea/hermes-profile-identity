import assert from 'node:assert/strict'
import test from 'node:test'
import { loadPlugin } from './helpers.mjs'

test('registers preferences in Settings without contributing a side pane', t => {
  const plugin = loadPlugin()
  t.after(() => plugin.cleanupFixture())
  assert.equal(plugin.settings.length, 1, 'missing native plugin settings page')
  assert.equal(plugin.settings[0].title, 'Profile Identity')
  assert.equal(plugin.settings[0].id, 'settings')
  assert.equal(typeof plugin.settings[0].render, 'function')
  assert.equal(typeof plugin.settings[0].render().type, 'function')
  assert.equal(plugin.contributions.filter(c => c.area === 'panes').length, 0)
  assert.equal(plugin.contributions.filter(c => c.area === 'titleBar.center').length, 1)
})

test('keeps the legacy pane available on hosts without the settings API', t => {
  const plugin = loadPlugin({ settingsApi: false })
  t.after(() => plugin.cleanupFixture())
  assert.equal(plugin.settings.length, 0)
  const panes = plugin.contributions.filter(c => c.area === 'panes')
  assert.equal(panes.length, 1)
  assert.equal(panes[0].id, 'pane')
  assert.equal(typeof panes[0].render, 'function')
})
