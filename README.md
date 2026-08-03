# hermes-profile-identity

**One glanceable visual identity per [Hermes Agent](https://github.com/NousResearch/hermes-agent) profile.**

The stock Hermes desktop app distinguishes profiles only by a small colored
square with an initial letter in the bottom-left rail. Run twelve agents —
engineer, researcher, accountant, community manager — and every window looks
the same. This plugin fixes that, with zero changes to the app itself:

- **Titlebar chip** — the active profile's name, in its color, always visible
  top-center.
- **Per-profile rail icon** — replace the initial letter in the profile square
  with any image: the logo of the company that agent works with, a mascot, a
  flag. Upload or URL.
- **Per-profile chat backdrop** — a custom image (opacity slider included) or
  a soft color wash derived from the profile's color, behind the transcript.
- **Per-profile color override** — defaults to the same deterministic hue the
  rail already uses, so everything stays consistent.

All of it is configured per profile from a settings pane, persists across
restarts, and hot-reloads like any desktop plugin.

<!-- screenshots -->

## Install

One file, no build step — the app watches the folder and loads it within
seconds.

```bash
# one-liner: default Hermes home
curl -fsSL https://raw.githubusercontent.com/douglascorrea/hermes-profile-identity/main/install.sh | bash

# every profile home too (~/.hermes/profiles/<name>)
curl -fsSL https://raw.githubusercontent.com/douglascorrea/hermes-profile-identity/main/install.sh | bash -s -- --all-profiles
```

Or from a clone:

```bash
git clone https://github.com/douglascorrea/hermes-profile-identity.git
cd hermes-profile-identity
./install.sh --all-profiles
```

Then in the desktop app: **⌘K → "Reload desktop plugins"** if it doesn't
appear on its own. Manage it any time in **Settings → Plugins**.

## Usage

1. Open the **profile identity** pane (right side).
2. Switch to a profile from the rail; the pane configures that profile.
3. Set a **rail icon** (company logo works great at 20px), a **backdrop
   image**, an **opacity** level, and optionally a **color override**.
4. Repeat per profile once — every profile swap is instantly recognizable
   from then on.

Tip: turn the built-in chat backdrop off (**Settings → Appearance**) so it
doesn't stack with this plugin's layer.

## How it works

A single uncompiled ESM file using only the official
[`@hermes/plugin-sdk`](https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk)
surface plus what the SDK's security model explicitly grants (full renderer
authority):

- The chip and pane are contracted contribution areas (`titleBar.center`,
  `panes`).
- The backdrop mirrors core's own `<Backdrop/>` recipe (absolute, inset-0,
  pointer-events:none) inside each `[data-chat-surface]` container, driven by
  a `MutationObserver`, reacting to `host.state.profile` changes.
- Rail icons overlay the profile square (matched by `aria-label` + single-char
  initial) with an `<img>` that inherits the square's tint.
- Config lives in plugin-scoped storage (`hermes.plugin.profile-identity.*`);
  uploaded images are downscaled and kept in IndexedDB.

## Security

- Stored colors must match an `hsl()`/hex shape allowlist before reaching a
  style; stored image sources must be `http(s)` or `data:image/*`; opacity is
  clamped. A hand-edited storage value can't become CSS/`url()` or script
  execution.
- No network calls except loading an image URL you explicitly configured.
- No `eval`, no `innerHTML`, no third-party imports.
- Reviewed by an independent agent reviewer (fail-closed pipeline) before
  publish: no security or logic blockers.

## Limitations

- Backdrop/icon injection targets DOM internals (`data-chat-surface`,
  `data-slot="profile-rail"`) that aren't a stability contract — an app update
  could rename them; the plugin then stops painting that layer (chip and pane
  keep working) until updated.
- With tiled sessions from *other* profiles, all chat surfaces get the active
  profile's identity (tiles aren't tagged by profile in the DOM).
- The condensed profile dropdown (>13 profiles) keeps its initial letters;
  the square rail gets icons.
- macOS/Windows/Linux: anywhere the Hermes desktop app runs.

## Development

Edit `plugin.js` inside any Hermes home's
`desktop-plugins/profile-identity/` — every save hot-reloads in place. Copy it
back here and open a PR.

## License

MIT — see [LICENSE](LICENSE).
