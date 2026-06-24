# Tab Refresher

[![CI](https://github.com/shsu/chrome-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/shsu/chrome-extensions/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](../../LICENSE)

> Part of the [**chrome-extensions**](../../README.md) monorepo. This directory is a self-contained extension.

A minimal Google Chrome extension (Manifest V3) that auto-refreshes tabs on a timer. Refresh is
**toggled per tab and off by default**; the **entire UI is the toolbar icon**: click it to turn the
current tab **ON** (green recycling icon + a live countdown badge) or **OFF** (grey recycling icon),
with no effect on any other tab. All ON tabs share **one timer**, so they reload **together** every
60 seconds. There are no other settings.

| State (per tab) | Icon | Badge | Behavior |
|-----------------|------|-------|----------|
| ON    | 🟢 green recycling | 🟢 green countdown (e.g. `42`) | Reloads on the next shared 60-second tick |
| OFF   | ⚪ grey recycling  | none | Does nothing |

The badge counts down the seconds to the next shared refresh — the same value on every ON tab — and is
the same green as the icon.

---

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the `plugins/tab-refresher` folder.
4. The grey recycling icon appears in the toolbar. Pin it if you don't see it.

## Usage

- **Start:** on any tab, click the toolbar icon. It turns **green**, a green countdown badge
  appears, and *that* tab reloads every 60 seconds.
- **More tabs:** switch to another tab and click again — it joins the shared cycle and reloads
  together with the others. Repeat for as many tabs as you like.
- **Stop:** click the icon on a refreshing tab. It turns **grey**, its badge clears, and only that
  tab stops; the others keep going.
- Hover the icon to see this tab's state and time-to-next-refresh in the tooltip.

---

## Permissions — and why this set is minimal

```json
"permissions": ["alarms", "storage"]
```

Only **two** permissions, both non-sensitive, and **zero host permissions**. The extension never
reads page content, URLs, titles, or your browsing history.

| Permission | Why it's needed |
|------------|-----------------|
| `alarms`   | A Manifest V3 service worker is terminated after ~30s idle, so `setInterval` can't drive a reliable periodic timer. `chrome.alarms` is the supported way to fire on a schedule — here, **one shared alarm** (`tab-refresh`) that runs while any tab is ON. |
| `storage`  | Persists the **set of refreshing tab ids** so the ephemeral service worker can survive being shut down and restarted between alarm firings. |

### Permissions we deliberately do **not** request

| Not requested | Why we can avoid it |
|---------------|---------------------|
| `tabs`        | `chrome.tabs.reload(tabId)` reloads a tab without any permission. The `tabs` permission only unlocks reading sensitive fields (`url`, `title`, `favIconUrl`, `pendingUrl`) — which we never do. |
| `activeTab`   | We get the tab to pin directly from the `chrome.action.onClicked` callback argument, so no separate grant is needed. |
| Host permissions (`<all_urls>` etc.) | Reloading a tab requires no host access. The extension cannot see or modify any page. |
| `scripting` / content scripts | We never inject code into pages — we only ask Chrome to reload them. |

> This is the smallest permission set that still allows reliable per-tab background timers. The
> countdown badge uses `chrome.action.setBadgeText` / `setBadgeBackgroundColor` (per tab), which need
> no permission, and keeping the worker awake for the countdown uses only already-granted APIs — so
> the feature set grows without the permission set growing.

---

## Design decisions

Every choice and its rationale (per the project requirement to document all decisions):

- **Manifest V3.** Manifest V2 is fully deprecated; MV3 is the only target Chrome supports in 2026.

- **`minimum_chrome_version: "88"`.** Chrome 88 is where MV3, the `chrome.action` API, and
  `chrome.action.setIcon({ path })` from a service worker all became available — the genuine floor for
  this extension. Nothing here needs a newer release (the 60s interval sits above the 30s alarm floor
  that arrived in Chrome 120), so 88 is declared rather than an inflated version that would block
  browsers where it would actually run.

- **No popup — the toolbar icon *is* the control.** Because no `default_popup` is declared,
  `chrome.action.onClicked` fires on click, letting us toggle directly. This removes all popup
  HTML/CSS/JS, keeping the surface (and attack surface) as small as possible and matching the
  "the icon shows the state" requirement exactly.

- **ON/OFF is per tab; the timer is shared.** Clicking ON arms the tab you're on; clicking it again
  disarms only that tab — switching tabs never moves or steals a refresh. All ON tabs run off **one**
  shared 60-second timer, so they reload together. A tab turned on mid-cycle joins the next shared tick
  (its first reload is the time left on the clock, then every 60s after). If a refreshing tab is
  closed, just that tab drops out.
  - *Why per-tab ON/OFF and not one global switch?* You choose exactly which tabs refresh, one click
    each — never a blanket reload of tabs you didn't pick.
  - *Why a shared timer and not one-per-tab?* A single alarm wakes the worker once per cycle no matter
    how many tabs are on (one alarm vs N), and "every 60s" is all the feature promises — lockstep is
    the cheaper, simpler behavior. The only cost is that all ON tabs reload at the same instant (a
    synchronized burst, not a staggered trickle) — negligible for a handful of tabs.

- **Refresh interval: 60 seconds, hardcoded.** The request asked for no extra configuration, so there
  is no settings UI. The interval lives in one constant, `PERIOD_MINUTES`, in `service-worker.js`.
  Chrome's minimum alarm period is 30 seconds (`0.5`); values below that are ignored.

- **`chrome.alarms` for timing** (not `setInterval`), **one shared alarm `tab-refresh`.** It's created
  when the first tab turns ON and cleared when the last turns OFF. On fire, `onAlarm` reloads every tab
  in the set. The service worker is killed when idle; the alarm is what wakes it back up.

- **A live countdown badge, same green as the icon.** Each ON tab shows a badge counting the seconds to
  the next shared refresh (`chrome.action.setBadgeText`, per tab) on a `#43A047` background that matches
  the recycle glyph (Chrome auto-picks contrasting text). Because the timer is shared, it's **one value
  shown identically on every ON tab**, computed from the single alarm's `scheduledTime`. It clears when
  the tab turns off.
  - *The cost:* a smooth per-second countdown needs the worker awake. **By default the keep-alive is
    off** — the badge is set on toggle, on tab-focus, and on each fire (cheap; the worker sleeps
    between, so the number may sit and then jump). Flipping the keep-alive constant keeps the worker
    resident and ticks the visible tab's badge every second.

- **State in `chrome.storage.local`.** Key: `tabIds` (`number[]` — the set of ON tabs; empty is the
  default, all off). Local, not `sync`, because tab ids are specific to this machine/session. Clicks,
  the alarm fire, and tab closes all mutate this one set, so every read-modify-write is serialized to
  keep a concurrent change from dropping a tab.

- **ON does not survive a browser restart — by design.** Tab ids are not stable across a restart, and
  the alarm is not persisted across sessions, so remembered state would point at tabs that no longer
  exist. On `onStartup`/`onInstalled` the extension clears the `tab-refresh` alarm and resets to an
  empty set. Re-arm with one click per tab after a restart.

- **Icons: a circular two-arrow recycle/refresh loop**, green for ON and grey for OFF, swapped per tab
  at runtime via `chrome.action.setIcon` — tabs with no override fall back to the grey `default_icon`,
  so green appears only on ON tabs. Generated by `tools/make-icons.mjs` (dev-only; see below).

## How it works — behavior & architecture

**Behavior.** Refresh is **per-tab and off by default**. Click the toolbar icon to turn the current
tab ON (green icon + green countdown badge) or OFF (grey, no badge), independently of every other tab.
All ON tabs share **one 60-second timer** and reload **together** each cycle; a tab enabled mid-cycle
joins the next shared tick (so its first reload is whatever time is left on the clock). The countdown
shows the seconds to that tick and reads the same on every ON tab.

**Architecture.** One shared alarm `tab-refresh` drives the cycle; the only state is the set of ON tab
ids in `chrome.storage.local` (`tabIds`, default empty).

```
toolbar click ─ onClicked(tab) ─▶ tab ON? ─ no ─▶ add id; if set was empty, create the 60s alarm; green icon + badge
                                     └─ yes ─▶ remove id; grey icon, clear badge; if set now empty, clear the alarm

alarm tab-refresh fires (every 60s) ─▶ reload EVERY tab in the set ─▶ drop any that fail (closed/restricted)
tab closed ───────────────▶ remove id from set (clear the alarm if it empties)
browser startup / install ─▶ clear the alarm, reset the set to empty
```

- **One shared alarm, not one-per-tab** — the worker wakes once per cycle regardless of tab count
  (O(1) alarms; the O(n) cost is the reloads themselves, which is inherent).
- **Per-tab icon/badge** via `chrome.action.set*({ tabId })`; every call carries a `tabId`, so green
  and the badge never leak onto tabs you didn't turn on (those fall back to the grey default).
- **Countdown** from the single alarm's `scheduledTime` — one value for all ON tabs; refreshed on
  toggle / tab-focus / fire by default, or ticked every second behind the opt-in keep-alive.
- **Serialized state** — clicks, the fire, and tab-closes all mutate the one set, so every
  read-modify-write is chained to stop a concurrent change from dropping a tab.

All logic lives in `service-worker.js` (no DOM, no dependencies).

## Limitations

- Cannot refresh restricted pages (`chrome://*`, the Chrome Web Store, etc.). On those, the reload
  call fails and that tab safely turns itself OFF — other tabs are unaffected.
- Fastest possible interval is 30 seconds (Chrome's alarm floor).
- The per-second countdown is smooth only while the worker is kept awake (any tab refreshing). With
  keep-alive off it still refreshes on time, but the badge ticks coarsely between minutes.
- ON state resets when Chrome restarts (see decisions above) — re-arm each tab with one click.

## Customize

- **Change the interval:** edit `PERIOD_MINUTES` in `service-worker.js` (`1` = 60s; minimum `0.5` = 30s),
  then reload the extension at `chrome://extensions`.
- **Change the icon / badge color:** edit `COLORS` in `tools/make-icons.mjs` (re-run it, below) — the
  countdown badge reads the same green, so both stay in sync.
- **Smooth the countdown:** the worker-keep-alive that ticks the badge every second is **off by
  default** (the badge updates on toggle, tab-focus, and each refresh); flip the keep-alive constant in
  `service-worker.js` (documented inline) to make it count down live, at the cost of a resident worker.

## Developer scripts (npm)

No runtime dependencies — the scripts use Node built-ins, `zip`, and the `gh` CLI.

| Command | What it does |
|---------|--------------|
| `npm test` | Validates the extension without a browser: MV3 shape, version sync, minimal permissions, no `default_popup`, every referenced icon present and correctly sized, and that all JS/shell sources parse. |
| `npm run build` | Packages `dist/tab-refresher-<version>.zip` (the Web Store / Release artifact). `dist/` is gitignored. |
| `npm run release` | Runs the tests, builds the zip, then creates or updates the GitHub Release for the current version tag (idempotent). Requires `gh` authenticated. |
| `npm run icons` | Regenerates the committed green/grey recycle PNGs (e.g. after changing colors). |

> **Version is sourced from `manifest.json`.** `package.json`'s `version` must match it — `npm test`
> fails if they drift, so bump both when cutting a new release.

## Releasing (GitHub + Chrome Web Store)

Releases are cut by pushing a version tag. `.github/workflows/release.yml` then runs `npm test`,
builds the zip, publishes a **GitHub Release**, and (optionally) uploads to the **Chrome Web Store**:

```bash
# bump version in BOTH manifest.json and package.json, commit, then:
git tag v1.1.0 && git push origin v1.1.0
```

GitHub publishing is immediate. Chrome Web Store publishing is **opt-in and asynchronous** (Google
reviews every update before it goes live):

1. One-time: register on the [Web Store dashboard](https://chrome.google.com/webstore/devconsole)
   ($5), upload the first build and complete the listing manually, then create a Google Cloud OAuth
   client + refresh token for the Chrome Web Store API.
2. Add repo **secrets** `CWS_EXTENSION_ID`, `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`.
3. Add repo **variable** `PUBLISH_WEBSTORE=true` to enable the Web Store step.

Until step 3 the workflow publishes to GitHub only. Locally, `npm run release` publishes to GitHub only.

## File layout

```
chrome-tab-refresher/
├── .github/workflows/
│   ├── ci.yml           # run npm test on every push / PR
│   └── release.yml      # tag push -> GitHub Release + (opt-in) Web Store upload
├── .githooks/pre-push   # gitleaks secret scan (enable: npm run hooks)
├── manifest.json        # MV3 manifest: permissions, no-popup action, service worker
├── service-worker.js    # all runtime logic (toggle, alarm, reload, icon/state)
├── icons/               # green-* (ON) and grey-* (OFF) recycle icons, 16/32/48/128 px
├── package.json         # npm scripts (build / test / release / icons / hooks)
├── tools/               # dev-only, not loaded by Chrome
│   ├── make-icons.mjs   #   regenerate the icons
│   ├── pack.sh          #   build dist/<...>.zip
│   ├── test.mjs         #   validate the extension
│   └── release.sh       #   build + publish a GitHub Release
├── dist/                # build output (gitignored)
├── CHANGELOG.md
├── LICENSE
├── .editorconfig
└── README.md
```

---

## Verified Chrome API facts

Confirmed against the official Chrome for Developers docs (2026):

- `chrome.tabs.reload(tabId)` requires no permission (not `tabs`, host, or `activeTab`).
- The `tabs` permission only gates `url` / `title` / `favIconUrl` / `pendingUrl`.
- `chrome.alarms` minimum period is 30 seconds; default alarms are not persisted across restarts.
- `chrome.action.onClicked` fires only when no `default_popup` is set.
- `chrome.action.setIcon({ path })` swaps the toolbar icon at runtime (unpacked extensions must use PNG).
- `chrome.action.setIcon` / `setBadgeText` / `setBadgeBackgroundColor` all accept a `tabId` to scope the
  icon and countdown badge to a single tab; none require a permission, and badge text-contrast is chosen
  by Chrome automatically (no `setBadgeTextColor`, so `minimum_chrome_version` stays 88).
- `chrome.alarms.get(name)` returns the next `scheduledTime`; with one shared `tab-refresh` alarm,
  that single value is what every ON tab's countdown badge counts down to.
- `chrome.storage` (`storage` permission) is non-sensitive — no extra Web Store review or user warning.
- `chrome.tabs.onRemoved` needs no permission: by the gating rule above it carries only `tabId` and
  `removeInfo` (none of `url`/`title`/`favIconUrl`/`pendingUrl`), so the auto-stop-on-close listener
  works without the `tabs` permission.

## Security

A committed pre-push hook (`.githooks/pre-push`) runs [gitleaks](https://github.com/gitleaks/gitleaks)
to block any push that contains a secret. Enable it once per clone:

```bash
npm run hooks            # points git's core.hooksPath at .githooks
brew install gitleaks    # the hook warns and skips if gitleaks isn't installed
```

The extension ships no network code, no secrets, and no host access. Release credentials live only in
GitHub repo secrets (never committed), and `*.pem` signing keys are gitignored.

## License

[MIT](LICENSE) © 2026 Steven Hsu
