import { readFileSync } from 'node:fs'
import vm from 'node:vm'

export function atom(initial) {
  let value = initial
  const listeners = new Set()
  return {
    get: () => value,
    set(next) {
      value = next
      for (const listener of [...listeners]) listener(value)
    },
    subscribe(listener) {
      listeners.add(listener)
      listener(value)
      return () => listeners.delete(listener)
    },
    listenerCount: () => listeners.size
  }
}

// Exercise the plugin's actual registration code without installing Hermes or
// importing its renderer dependencies into Node. Components are not mounted.
export function loadPlugin({ settingsApi = true, focusedApi = true, search = '', title = 'Hermes' } = {}) {
  const contributions = []
  const settings = []
  const disposers = []
  const values = new Map()
  const profile = atom('default')
  const focused = atom('default')
  const titleWrites = []
  let currentTitle = title
  const document = {
    body: {},
    querySelector: () => null,
    querySelectorAll: () => [],
    get title() { return currentTitle },
    set title(value) { currentTitle = String(value); titleWrites.push(currentTitle) }
  }
  const context = vm.createContext({
    console,
    URLSearchParams,
    document,
    window: { location: { search } },
    atom,
    host: { state: { profile, ...(focusedApi ? { focusedSessionProfile: focused } : {}) } },
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 1,
    profileColor: () => null,
    profileColorSoft: () => 'transparent',
    useValue: value => value.get(),
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useState: value => [value, () => {}],
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
    Button: 'button', Input: 'input', Separator: 'hr', Switch: 'switch',
    cn: (...classes) => classes.filter(Boolean).join(' ')
  })
  const source = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')
    .replace(/import \{[\s\S]*?\} from '@hermes\/plugin-sdk'\n/, '')
    .replace(/import [^\n]+ from 'react(?:\/jsx-runtime)?'\n/g, '')
    .replace('export default {', 'globalThis.testPlugin = {')
  vm.runInContext(source, context, { filename: 'plugin.js', timeout: 1000 })
  const ctx = {
    storage: {
      get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
      set: (key, value) => values.set(key, value),
      remove: key => values.delete(key)
    },
    register: contribution => contributions.push(contribution),
    onDispose: disposer => disposers.push(disposer),
    ...(settingsApi ? { registerSettingsPage: page => settings.push(page) } : {})
  }
  context.testPlugin.register(ctx)
  return {
    contributions, settings, profile, focused, document, titleWrites,
    dispose() { for (const disposer of disposers.splice(0)) disposer() },
    cleanupFixture() { context.__profileIdentityCleanup?.() }
  }
}
