/**
 * profile-identity — one glanceable visual identity per Hermes profile.
 *
 * The stock app distinguishes profiles only by the small colored square (with
 * an initial letter) in the bottom-left rail. This plugin makes the ACTIVE
 * profile obvious everywhere:
 *
 *   1. A titlebar-center pill with the profile name in its color.
 *   2. A per-profile backdrop layer injected into every chat surface —
 *      a custom image (URL or upload, per profile) or a soft color wash
 *      derived from the profile's rail color.
 *   3. A per-profile RAIL ICON: replace the initial letter in the profile
 *      square with any image (URL or upload) — e.g. the logo of the company
 *      that agent works with. Also shown in the titlebar pill.
 *   4. A settings pane (right side) to pick color override, backdrop, icon.
 *
 * Color default = the same deterministic hue the rail uses (profileColor), so
 * identity stays consistent with the squares; a per-profile override wins.
 * Config lives in ctx.storage (hermes.plugin.profile-identity.*); uploaded
 * images live in IndexedDB (localStorage quota is too small for photos).
 *
 * Input hardening: stored colors must match an hsl()/hex allowlist before they
 * reach a style, stored image sources must be http(s) or data:image/*, and
 * opacity is clamped to 0..0.5 — a hand-edited localStorage value can never
 * become CSS/url() or script execution.
 *
 * DOM injection is idempotent across hot reloads: every (re)load tears down
 * the previous observers + layers via globalThis.__profileIdentityCleanup.
 * The backdrop layer mirrors the core <Backdrop/> recipe (absolute, inset-0,
 * z-2, pointer-events:none) inside each [data-chat-surface] container; rail
 * icons re-apply self-healing style whenever the rail re-renders.
 *
 * Plain ESM, loaded uncompiled — jsx() calls only, no JSX syntax.
 * Only @hermes/plugin-sdk, react, react/jsx-runtime resolve.
 */

import {
  Button,
  Input,
  Separator,
  Switch,
  atom,
  cn,
  host,
  profileColor,
  profileColorSoft,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'profile-identity'
const SURFACE_SELECTOR = '[data-chat-surface]'
const RAIL_SELECTOR = '[data-slot="profile-rail"]'
const LAYER_ATTR = 'data-profile-identity-layer'
const ICON_ATTR = 'data-profile-identity-icon'
const DEFAULT_IMAGE_OPACITY = 0.14
const DEFAULT_ICON_SIZE = 24 // stock rail squares are 20px; icons read better bigger
const MAX_ICON_SIZE = 36
const MIN_ICON_SIZE = 20

// Same 12 swatches as the app's rail color picker (30° hue steps, same S/L).
const SWATCHES = Array.from({ length: 12 }, (_, i) => `hsl(${i * 30} 68% 58%)`)

// ------------------------------------------------------------------- guards --

// Colors only reach styles after this check. Values we write are hsl() from
// SWATCHES, but a hand-edited store could hold anything — refuse url(), quotes,
// parens tricks by shape, not by blocklist.
const SAFE_COLOR_RE = /^(hsl\(\d{1,3}(\.\d+)? \d{1,3}(\.\d+)?% \d{1,3}(\.\d+)?%( \/ [\d.]+%?)?\)|#[0-9a-fA-F]{3,8})$/

function safeColor(value) {
  return typeof value === 'string' && SAFE_COLOR_RE.test(value.trim()) ? value.trim() : null
}

// Image sources: remote http(s) or an uploaded data:image/*. Never javascript:,
// file:, data:text/html, etc. — <img> wouldn't execute them anyway, but a
// strict allowlist keeps weird schemes out of the renderer entirely.
function safeImageSrc(value) {
  if (typeof value !== 'string') return null
  const src = value.trim()
  if (/^https:\/\/\S+$/.test(src) || /^http:\/\/\S+$/.test(src)) return src
  if (/^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml);/i.test(src)) return src
  return null
}

const clampOpacity = value =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(0.5, Math.max(0, value)) : DEFAULT_IMAGE_OPACITY

// ------------------------------------------------------------------ state --

let store = null // ctx.storage, captured in register()
const $version = atom(0) // config-change signal: repaints layers + panes
const bump = () => $version.set($version.get() + 1)

const normProfile = name => (name ?? '').trim() || 'default'
const cfgKey = profile => `cfg.${profile}`
const iconIdbKey = profile => `icon:${profile}` // IndexedDB key for rail icons

function loadCfg(profile) {
  const cfg = store?.get(cfgKey(profile), null)
  return cfg && typeof cfg === 'object' ? cfg : {}
}

function loadPrefs() {
  return { chip: true, iconSize: DEFAULT_ICON_SIZE, wash: true, ...(store?.get('prefs', {}) || {}) }
}

// Stored icon size in px, clamped to the supported range.
function iconSize() {
  const n = Number(loadPrefs().iconSize)
  return Number.isFinite(n) ? Math.min(MAX_ICON_SIZE, Math.max(MIN_ICON_SIZE, n)) : DEFAULT_ICON_SIZE
}

function saveCfg(profile, patch) {
  const next = { ...loadCfg(profile), ...patch }
  for (const key of Object.keys(next)) {
    if (next[key] == null || next[key] === '') delete next[key]
  }
  // Tidy: an all-cleared config removes the key entirely (matches clearCfg).
  if (Object.keys(next).length === 0) {
    store.remove(cfgKey(profile))
  } else {
    store.set(cfgKey(profile), next)
  }
  const known = store.get('known', [])
  if (!known.includes(profile)) store.set('known', [...known, profile])
  bump()
}

function clearCfg(profile) {
  store.remove(cfgKey(profile))
  store.set('known', store.get('known', []).filter(name => name !== profile))
  void idbDel(profile) // backdrop upload
  void idbDel(iconIdbKey(profile)) // icon upload
  bump()
}

function savePrefs(patch) {
  store.set('prefs', { ...loadPrefs(), ...patch })
  bump()
}

// Color resolution: explicit override > deterministic rail hue. 'none' = neutral.
function resolveColor(profile) {
  const cfg = loadCfg(profile)
  if (cfg.color === 'none') return null
  const override = safeColor(cfg.color)
  if (override) return override
  return profileColor(profile)
}

// --------------------------------------------------------------- IndexedDB --
// Uploaded images are data URLs: backdrops under key = profile name, rail
// icons under key = `icon:<profile>`.

// Cache the connection — one open per realm, retried after a failure.
let idbPromise = null

function idbOpen() {
  if (!idbPromise) {
    idbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('hermes-profile-identity', 1)
      req.onupgradeneeded = () => req.result.createObjectStore('images')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    idbPromise.catch(() => {
      idbPromise = null
    })
  }
  return idbPromise
}

async function idbPut(key, value) {
  const db = await idbOpen()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('images', 'readwrite')
    tx.objectStore('images').put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function idbGet(key) {
  const db = await idbOpen()
  return new Promise((resolve, reject) => {
    const req = db.transaction('images', 'readonly').objectStore('images').get(key)
    req.onsuccess = () => resolve(req.result ?? null)
    req.onerror = () => reject(req.error)
  })
}

async function idbDel(key) {
  try {
    const db = await idbOpen()
    await new Promise((resolve, reject) => {
      const tx = db.transaction('images', 'readwrite')
      tx.objectStore('images').delete(key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    /* best effort */
  }
}

// Downscale uploads so multi-MB photos don't bloat IndexedDB / decode time.
// Backdrops cap at 1600px; rail icons only ever render at 20px → cap at 256.
function fileToDataUrl(file, maxPx) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const scale = Math.min(1, maxPx / Math.max(img.width, img.height))
        if (scale >= 1) {
          resolve(reader.result)
          return
        }
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(img.width * scale)
        canvas.height = Math.round(img.height * scale)
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/png'))
      }
      img.onerror = () => {
        // Undecodable → store raw, but refuse multi-MB blobs: IndexedDB is
        // generous, not infinite, and an icon/backdrop never needs 4MB+.
        const raw = reader.result
        if (typeof raw === 'string' && raw.length > 4_000_000) {
          reject(new Error('image is too large to store'))
          return
        }
        resolve(raw)
      }
      img.src = reader.result
    }
    reader.readAsDataURL(file)
  })
}

// kind: 'backdrop' (cfg.image, idb key = profile) | 'icon' (cfg.icon, idb key = icon:profile)
async function resolveImage(profile, kind) {
  const cfg = loadCfg(profile)
  const setting = kind === 'icon' ? cfg.icon : cfg.image
  const idbKey = kind === 'icon' ? iconIdbKey(profile) : profile
  if (setting === 'upload') return idbGet(idbKey).then(safeImageSrc)
  return safeImageSrc(setting)
}

// -------------------------------------------------------- backdrop injector --

function startInjector() {
  // Hot-reload safety: tear down the previous run in this realm first.
  if (globalThis.__profileIdentityCleanup) {
    try {
      globalThis.__profileIdentityCleanup()
    } catch {
      /* noop */
    }
  }

  const layers = new Map() // chat surface element -> backdrop layer element
  const iconCache = new Map() // profile name -> resolved icon src (null = none)
  let disposed = false
  let repaintSeq = 0 // generation guard: last writer wins, stale reads drop
  let current = { color: null, opacity: DEFAULT_IMAGE_OPACITY, src: null }

  const paintWash = layer => {
    if (!current.color) return
    const wash = document.createElement('div')
    wash.style.cssText =
      'position:absolute;inset:0;background:linear-gradient(155deg,' +
      `${profileColorSoft(current.color, 9)} 0%,transparent 40%,` +
      `transparent 62%,${profileColorSoft(current.color, 7)} 100%);`
    layer.appendChild(wash)
  }

  const paintLayer = layer => {
    layer.replaceChildren()
    if (current.src) {
      const img = document.createElement('img')
      img.alt = ''
      img.draggable = false
      img.src = current.src
      img.style.cssText = `width:100%;height:100%;object-fit:cover;opacity:${current.opacity};`
      // Broken URL / CSP refusal → fall back to the wash instead of alt chrome.
      img.onerror = () => {
        layer.replaceChildren()
        paintWash(layer)
      }
      layer.appendChild(img)
    } else if (loadPrefs().wash) {
      paintWash(layer)
    }
  }

  const attach = surface => {
    const layer = document.createElement('div')
    layer.setAttribute(LAYER_ATTR, '')
    layer.style.cssText = 'position:absolute;inset:0;z-index:2;overflow:hidden;pointer-events:none;'
    surface.insertBefore(layer, surface.firstChild)
    layers.set(surface, layer)
    paintLayer(layer)
  }

  // -- rail icons: overlay the profile square's initial with a custom image --

  const applyIcon = (button, src) => {
    let img = button.querySelector(`[${ICON_ATTR}]`)
    if (!src) {
      img?.remove()
      if (button.dataset.piSized) {
        button.style.width = ''
        button.style.height = ''
        delete button.dataset.piSized
      }
      return
    }
    const size = iconSize()
    // Grow the square itself so the icon has room (20px stock is cramped).
    button.style.width = `${size}px`
    button.style.height = `${size}px`
    button.dataset.piSized = '1'
    if (!img) {
      img = document.createElement('img')
      img.setAttribute(ICON_ATTR, '')
      img.alt = ''
      img.draggable = false
      // Cover the initial completely: same tint as the square, logo centered.
      // contain (not cover) so wide company logos survive the small tile.
      img.style.cssText =
        'position:absolute;inset:0;box-sizing:border-box;' +
        'width:100%;height:100%;object-fit:contain;border-radius:inherit;pointer-events:none;'
      button.style.position = 'relative'
      button.appendChild(img)
    }
    img.src = src
    img.style.padding = `${Math.max(2, size * 0.08)}px`
    // Re-sync the tint every sweep: the square darkens slightly when active.
    img.style.backgroundColor = getComputedStyle(button).backgroundColor
  }

  const sweepRailIcons = () => {
    if (disposed) return
    document.querySelectorAll(`${RAIL_SELECTOR} button[aria-label]`).forEach(button => {
      const name = button.getAttribute('aria-label')
      // Profile squares carry the bare profile name as label and a single-char
      // initial as content — glyph pills ("Manage profiles…", "New profile")
      // fail at least one of these checks.
      const looksLikeSquare = (button.textContent ?? '').trim().length <= 1
      const wantsIcon = looksLikeSquare && loadCfg(name).icon != null
      if (!wantsIcon) {
        applyIcon(button, null)
        return
      }
      const cached = iconCache.get(name)
      if (cached !== undefined) {
        // In-flight promise or resolved src — either way, apply when ready.
        void Promise.resolve(cached).then(src => {
          if (!disposed) applyIcon(button, src)
        })
        return
      }
      const pending = resolveImage(name, 'icon')
        .then(src => {
          iconCache.set(name, src)
          return src
        })
        .catch(() => {
          iconCache.set(name, null)
          return null
        })
      iconCache.set(name, pending)
      void pending.then(src => {
        if (!disposed) applyIcon(button, src)
      })
    })
  }

  // The rail re-renders on profile switches (active ring, order) without any
  // childList change we can rely on — watch its attributes too, scoped to the
  // rail element so streaming chat mutations stay out of this observer.
  let railObserver = null
  let boundRail = null
  let railScheduled = false
  const scheduleRailSweep = () => {
    if (railScheduled) return
    railScheduled = true
    requestAnimationFrame(() => {
      railScheduled = false
      sweepRailIcons()
    })
  }
  const bindRail = () => {
    const rail = document.querySelector(RAIL_SELECTOR)
    if (rail === boundRail) return
    boundRail = rail
    railObserver?.disconnect()
    railObserver = null
    if (rail) {
      railObserver = new MutationObserver(scheduleRailSweep)
      railObserver.observe(rail, {
        attributes: true,
        attributeFilter: ['style', 'class'],
        childList: true,
        subtree: true
      })
    }
    scheduleRailSweep()
  }

  const ensureLayers = () => {
    if (disposed) return
    bindRail()
    document.querySelectorAll(SURFACE_SELECTOR).forEach(surface => {
      const existing = layers.get(surface)
      if (!existing || !existing.isConnected) attach(surface)
    })
    // Drop bookkeeping for surfaces that left the DOM.
    for (const [surface, layer] of layers) {
      if (!surface.isConnected || !layer.isConnected) layers.delete(surface)
    }
  }

  const repaintAll = async () => {
    if (disposed) return
    const run = ++repaintSeq
    const profile = normProfile(host.state.profile.get())
    const cfg = loadCfg(profile)
    const color = resolveColor(profile)
    const opacity = clampOpacity(cfg.opacity)
    const src = await resolveImage(profile, 'backdrop').catch(() => null)
    // A newer repaint started while the IndexedDB read was in flight — drop it.
    if (disposed || run !== repaintSeq) return
    current = { color, opacity, src }
    ensureLayers()
    layers.forEach(paintLayer)
  }

  // Streaming tokens mutate the DOM constantly — coalesce to one sweep/frame.
  let scheduled = false
  const observer = new MutationObserver(() => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      ensureLayers()
    })
  })
  observer.observe(document.body, { childList: true, subtree: true })

  const unsubProfile = host.state.profile.subscribe(() => void repaintAll())
  const unsubVersion = $version.subscribe(() => {
    iconCache.clear()
    void repaintAll()
    scheduleRailSweep()
  })
  void repaintAll()

  globalThis.__profileIdentityCleanup = () => {
    disposed = true
    observer.disconnect()
    railObserver?.disconnect()
    unsubProfile()
    unsubVersion()
    document.querySelectorAll(`[${LAYER_ATTR}]`).forEach(el => el.remove())
    document.querySelectorAll(`[${ICON_ATTR}]`).forEach(el => el.remove())
    layers.clear()
    iconCache.clear()
  }
}

// -------------------------------------------------------------- components --

function ProfileChip() {
  const profile = normProfile(useValue(host.state.profile))
  useValue($version)
  const [iconSrc, setIconSrc] = useState(null)
  const cfgIcon = loadCfg(profile).icon

  useEffect(() => {
    let cancelled = false
    if (cfgIcon == null) {
      setIconSrc(null)
      return undefined
    }
    void resolveImage(profile, 'icon')
      .then(src => !cancelled && setIconSrc(src))
      .catch(() => !cancelled && setIconSrc(null))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, cfgIcon])

  if (!loadPrefs().chip) return null
  const color = resolveColor(profile)

  return jsxs('span', {
    className:
      'inline-flex max-w-44 select-none items-center gap-1.5 rounded-full border px-2 py-px text-[0.6875rem] font-medium',
    style: color
      ? {
          backgroundColor: profileColorSoft(color, 14),
          borderColor: profileColorSoft(color, 38),
          color
        }
      : { borderColor: 'var(--ui-stroke-secondary)', color: 'var(--ui-text-tertiary)' },
    title: `profile: ${profile}`,
    children: [
      iconSrc
        ? jsx('img', {
            alt: '',
            className: 'size-3 shrink-0 rounded-[2px] object-contain',
            key: 'mark',
            src: iconSrc
          })
        : jsx('span', {
            key: 'mark',
            style: {
              width: 6,
              height: 6,
              borderRadius: 9999,
              flexShrink: 0,
              backgroundColor: color ?? 'var(--ui-text-quaternary)'
            }
          }),
      jsx('span', { className: 'truncate', key: 'name', children: profile })
    ]
  })
}

function Section({ title, children }) {
  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'text-[0.6875rem] font-medium uppercase tracking-wide text-(--ui-text-quaternary)',
        children: title
      }),
      ...children
    ]
  })
}

// Shared URL-input + upload + clear controls for one image slot (backdrop or
// rail icon) of the active profile.
function ImageControls({ kind, profile, tall }) {
  useValue($version)
  const cfg = loadCfg(profile)
  const setting = kind === 'icon' ? cfg.icon : cfg.image
  const idbKey = kind === 'icon' ? iconIdbKey(profile) : profile
  const fileRef = useRef(null)
  const [url, setUrl] = useState(setting && setting !== 'upload' ? setting : '')
  const [preview, setPreview] = useState(null)

  useEffect(() => {
    setUrl(setting && setting !== 'upload' ? setting : '')
    let cancelled = false
    void resolveImage(profile, kind)
      .then(src => !cancelled && setPreview(src))
      .catch(() => !cancelled && setPreview(null))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, kind, setting])

  const pickFile = async file => {
    if (!file) return
    try {
      const dataUrl = await fileToDataUrl(file, kind === 'icon' ? 256 : 1600)
      await idbPut(idbKey, dataUrl)
      saveCfg(profile, { [kind === 'icon' ? 'icon' : 'image']: 'upload' })
      host.notify({ kind: 'success', message: `${kind} set for ${profile}` })
    } catch (err) {
      host.notifyError(err, 'could not read that image')
    }
  }

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      preview
        ? jsx('img', {
            alt: `${kind} preview`,
            className: cn(
              'w-full rounded-md border border-(--ui-stroke-secondary)',
              tall ? 'h-20 object-cover' : 'h-10 object-contain p-1'
            ),
            src: preview
          })
        : jsx('div', {
            className: cn(
              'grid w-full place-items-center rounded-md border border-dashed border-(--ui-stroke-secondary) text-[0.6875rem] text-(--ui-text-quaternary)',
              tall ? 'h-20' : 'h-10'
            ),
            children: kind === 'icon' ? 'no icon — initial letter is used' : 'no image — color wash is used'
          }),
      jsxs('div', {
        className: 'flex items-center gap-1.5',
        children: [
          jsx(Input, {
            className: 'h-7 flex-1 text-xs',
            onChange: event => setUrl(event.target.value),
            placeholder: 'https://image-url…',
            value: url
          }),
          jsx(Button, {
            size: 'sm',
            type: 'button',
            variant: 'outline',
            onClick: () => {
              const src = safeImageSrc(url)
              if (url.trim() && !src) {
                host.notify({ kind: 'error', message: 'only http(s) or uploaded images are allowed' })
                return
              }
              // Switching away from an upload → drop the orphaned data URL.
              if (setting === 'upload' && src !== 'upload') void idbDel(idbKey)
              saveCfg(profile, { [kind === 'icon' ? 'icon' : 'image']: src ?? undefined })
            },
            children: 'Set'
          })
        ]
      }),
      jsxs('div', {
        className: 'flex items-center gap-1.5',
        children: [
          jsx(Button, {
            size: 'sm',
            type: 'button',
            variant: 'outline',
            onClick: () => fileRef.current?.click(),
            children: 'Upload…'
          }),
          jsx(Button, {
            disabled: setting == null,
            size: 'sm',
            type: 'button',
            variant: 'ghost',
            onClick: () => {
              void idbDel(idbKey)
              saveCfg(profile, { [kind === 'icon' ? 'icon' : 'image']: undefined })
            },
            children: 'Clear'
          }),
          jsx('input', {
            accept: 'image/*',
            className: 'hidden',
            ref: fileRef,
            type: 'file',
            onChange: event => {
              void pickFile(event.target.files?.[0])
              event.target.value = ''
            }
          })
        ]
      })
    ]
  })
}

function IdentityPane() {
  const profile = normProfile(useValue(host.state.profile))
  useValue($version)

  const cfg = loadCfg(profile)
  const prefs = loadPrefs()
  const known = store.get('known', [])
  const opacityPct = Math.round(clampOpacity(cfg.opacity) * 100)

  const swatchButton = (value, label, background) =>
    jsx('button', {
      'aria-label': label,
      className: cn(
        'size-5 rounded-[4px] border transition',
        (cfg.color ?? undefined) === value || (value === undefined && cfg.color == null)
          ? 'border-(--ui-accent) ring-1 ring-(--ui-accent)'
          : 'border-(--ui-stroke-secondary) hover:opacity-80'
      ),
      style: { background },
      title: label,
      type: 'button',
      onClick: () => saveCfg(profile, { color: value })
    })

  return jsxs('div', {
    className: 'flex h-full flex-col gap-4 overflow-y-auto p-3 text-sm',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between gap-2',
        children: [
          jsx('div', { className: 'font-medium', children: 'Profile identity' }),
          jsx(ProfileChip, {})
        ]
      }),

      jsx(Separator, {}),

      jsx(Section, {
        title: `color — ${profile}`,
        children: [
          jsxs('div', {
            className: 'flex flex-wrap items-center gap-1.5',
            children: [
              swatchButton(undefined, 'auto (rail color)', 'linear-gradient(135deg, var(--ui-text-quaternary), transparent)'),
              swatchButton('none', 'no color', 'transparent'),
              ...SWATCHES.map(swatch => swatchButton(swatch, swatch, swatch))
            ]
          }),
          jsx('div', {
            className: 'text-[0.6875rem] text-(--ui-text-tertiary)',
            children: 'auto = the deterministic hue used by the profile rail.'
          })
        ]
      }),

      jsx(Section, {
        title: 'rail icon — replace the initial',
        children: [
          jsx(ImageControls, { kind: 'icon', profile }),
          jsxs('label', {
            className: 'flex items-center gap-2 text-[0.6875rem] text-(--ui-text-tertiary)',
            children: [
              'size',
              jsx('input', {
                className: 'flex-1',
                max: MAX_ICON_SIZE,
                min: MIN_ICON_SIZE,
                step: 2,
                type: 'range',
                value: iconSize(),
                onChange: event => savePrefs({ iconSize: Number(event.target.value) })
              }),
              `${iconSize()}px`
            ]
          }),
          jsx('div', {
            className: 'text-[0.6875rem] text-(--ui-text-tertiary)',
            children: 'shown in the bottom-left profile square and the titlebar chip — e.g. a company logo.'
          })
        ]
      }),

      jsx(Section, {
        title: 'backdrop image',
        children: [
          jsx(ImageControls, { kind: 'backdrop', profile, tall: true }),
          jsxs('label', {
            className: 'flex items-center gap-2 text-[0.6875rem] text-(--ui-text-tertiary)',
            children: [
              jsx('input', {
                className: 'flex-1',
                max: 50,
                min: 0,
                type: 'range',
                value: opacityPct,
                onChange: event => saveCfg(profile, { opacity: Number(event.target.value) / 100 })
              }),
              `${opacityPct}%`
            ]
          })
        ]
      }),

      jsx(Section, {
        title: 'options',
        children: [
          jsxs('label', {
            className: 'flex items-center justify-between gap-2 text-[0.8125rem]',
            children: [
              'Titlebar chip',
              jsx(Switch, {
                checked: prefs.chip,
                onCheckedChange: on => savePrefs({ chip: Boolean(on) })
              })
            ]
          }),
          jsxs('label', {
            className: 'flex items-center justify-between gap-2 text-[0.8125rem]',
            children: [
              'Color wash when no image',
              jsx(Switch, {
                checked: prefs.wash,
                onCheckedChange: on => savePrefs({ wash: Boolean(on) })
              })
            ]
          })
        ]
      }),

      known.length > 0 &&
        jsx(Section, {
          title: 'configured profiles',
          children: known.map(name =>
            jsxs(
              'div',
              {
                className: 'flex items-center justify-between gap-2 text-[0.8125rem]',
                children: [
                  jsxs('span', {
                    className: 'flex min-w-0 items-center gap-1.5',
                    children: [
                      jsx('span', {
                        style: {
                          width: 8,
                          height: 8,
                          borderRadius: 9999,
                          flexShrink: 0,
                          backgroundColor: resolveColor(name) ?? 'var(--ui-text-quaternary)'
                        }
                      }),
                      jsx('span', { className: 'truncate', children: name })
                    ]
                  }),
                  jsx(Button, {
                    size: 'sm',
                    type: 'button',
                    variant: 'ghost',
                    onClick: () => clearCfg(name),
                    children: 'reset'
                  })
                ]
              },
              name
            )
          )
        }),

      jsx('div', {
        className: 'mt-auto text-[0.6875rem] leading-relaxed text-(--ui-text-quaternary)',
        children:
          'Tip: turn the built-in chat backdrop off (Settings → Appearance) so it does not stack with this layer.'
      })
    ]
  })
}

// ------------------------------------------------------------ window title --

function startWindowTitle(ctx) {
  // Only chat windows own profile-based titles; preserve HUD/browser/etc.
  const kind = new URLSearchParams(window.location.search).get('win')
  if (kind && kind !== 'secondary') return

  const previousTitle = document.title
  let ownedTitle = null
  const focused = host.state.focusedSessionProfile
  const update = () => {
    const profile = focused?.get()?.trim() || host.state.profile.get()?.trim() || 'default'
    ownedTitle = `Hermes - ${profile}`
    if (document.title !== ownedTitle) document.title = ownedTitle
  }
  const unsubscribers = [host.state.profile.subscribe(update)]
  if (focused) unsubscribers.push(focused.subscribe(update))
  ctx.onDispose(() => {
    unsubscribers.forEach(unsubscribe => unsubscribe())
    // Do not undo a subsequent title change made by the app or another plugin.
    if (document.title === ownedTitle) document.title = previousTitle
  })
}

// ----------------------------------------------------------------- plugin --

export default {
  id: ID,
  name: 'Profile Identity',
  register(ctx) {
    store = ctx.storage
    startWindowTitle(ctx)

    ctx.register({
      id: 'chip',
      area: 'titleBar.center',
      order: 90,
      render: () => jsx(ProfileChip, {})
    })

    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'profile identity',
      data: { placement: 'right', width: '272px' },
      render: () => jsx(IdentityPane, {})
    })

    startInjector()
  }
}
