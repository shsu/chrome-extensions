# Tab Refresher

[![CI](https://github.com/shsu/chrome-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/shsu/chrome-extensions/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](../LICENSE)

> Part of the [**chrome-extensions**](../README.md) monorepo. This directory is a self-contained extension.

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
3. Click **Load unpacked** and select the `tab-refresher/src` folder.
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
| `storage`  | Persists the **set of refreshing tab ids** so the ephemeral service worker can survive being shut down and restarted between alarm firings — in `storage.session`, whose lifetime matches exactly: survives worker kills, cleared by Chrome with the browser session. |

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

- **`minimum_chrome_version: "148"`.** The code's hard floor is Chrome 111: the worker is written
  promise-first (`await chrome.storage…`, `await chrome.alarms…`), and promise support landed
  per-API — `chrome.storage` in 95, most of `chrome.alarms` in 91, `chrome.alarms.create` in 111.
  (An 88 floor would be flattering but broken: on 88–94, callback-less `storage.get` throws and every
  listener dies.) On top of that floor we declare current stable: Chrome auto-updates, so this only
  excludes long-unpatched browsers, and it keeps the declared surface to the Chrome the extension is
  actually tested against.

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
  the next shared refresh (`action.setBadgeText`, per tab) on a `#43A047` background that matches the
  recycle glyph, with the digits pinned white (`action.setBadgeTextColor`) rather than trusting
  auto-contrast. Because the timer is shared, it's **one value shown identically on every ON tab**,
  computed from the single alarm's `scheduledTime`. It clears when the tab turns off.
  - *The cost:* a smooth per-second countdown needs the worker awake. **The keep-alive is on by
    default** — while any tab is refreshing, the worker stays resident and ticks the visible tab's
    badge every second, re-arming itself whenever the worker restarts with tabs still ON. Set
    `KEEP_ALIVE = false` to let the worker sleep between events (the badge then updates on toggle,
    tab- or window-focus, and each fire, so it may sit and then jump).

- **State in `browser.storage.session`.** Key: `tabIds` (`number[]` — the set of ON tabs; empty is
  the default, all off). Session — not `local` or `sync` — because the state's lifetime *is* the
  browser session: it survives service-worker kills (its purpose in MV3), and Chrome itself clears it
  when the browser restarts or the extension is disabled/reloaded/updated, so stale tab ids are
  impossible by construction rather than by cleanup code. Clicks, the alarm fire, and tab closes all
  mutate this one set, so every read-modify-write is serialized to keep a concurrent change from
  dropping a tab.

- **ON does not survive a browser restart — by design.** Tab ids are not stable across a restart, so
  remembered state would point at tabs that no longer exist. The set lives in `storage.session`,
  which Chrome clears at browser restart and on extension reload/update; `onStartup`/`onInstalled`
  only clear the `tab-refresh` alarm defensively. Re-arm with one click per tab after a restart.

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
ids in `browser.storage.session` (`tabIds`, default empty).

```
toolbar click ─ onClicked(tab) ─▶ tab ON? ─ no ─▶ add id; if set was empty, create the 60s alarm; green icon + badge
                                     └─ yes ─▶ remove id; grey icon, clear badge; if set now empty, clear the alarm

alarm tab-refresh fires (every 60s) ─▶ reload EVERY tab in the set, in parallel ─▶ drop any that fail (closed/restricted)
tab closed ───────────────▶ remove id from set (clear the alarm if it empties)
tab id replaced by Chrome ─▶ swap the old id for the new one (refresh follows the tab)
browser startup / install ─▶ clear the alarm (Chrome empties storage.session itself)
```

- **One shared alarm, not one-per-tab** — the worker wakes once per cycle regardless of tab count
  (O(1) alarms; the O(n) cost is the reloads themselves, which is inherent).
- **Per-tab icon/badge** via `chrome.action.set*({ tabId })`; every call carries a `tabId`, so green
  and the badge never leak onto tabs you didn't turn on (those fall back to the grey default).
- **Countdown** from the single alarm's `scheduledTime` — one value for all ON tabs; ticked every
  second by the default keep-alive (which re-arms on worker start), or refreshed only on toggle /
  tab-focus / window-focus / fire when that's disabled.
- **Serialized state** — clicks, the fire, and tab-closes all mutate the one set, so every
  read-modify-write is chained to stop a concurrent change from dropping a tab.

All logic lives in `service-worker.js` (no DOM, no dependencies).

## Limitations

- The first *arming* click after ~30s with no tab refreshing can lag a beat (~100–300 ms): MV3
  terminates the idle service worker, and Chrome must cold-start it before the click handler runs.
  While any tab is ON, the keep-alive holds the worker resident, so every further click is instant.
- Cannot refresh restricted pages (`chrome://*`, the Chrome Web Store, etc.). On those, the reload
  call fails and that tab safely turns itself OFF — other tabs are unaffected.
- Fastest possible interval is 30 seconds (Chrome's alarm floor).
- The per-second countdown is smooth only while the worker is kept awake (the default while any tab
  is refreshing). With `KEEP_ALIVE = false` it still refreshes on time, but the badge ticks coarsely
  between minutes.
- ON state resets when Chrome restarts (see decisions above) — re-arm each tab with one click.

## Customize

- **Change the interval:** edit `PERIOD_MINUTES` in `service-worker.js` (`1` = 60s; minimum `0.5` = 30s),
  then reload the extension at `chrome://extensions`.
- **Hard refresh:** set `BYPASS_CACHE = true` in `service-worker.js` to make every tick skip the HTTP
  cache (like Shift+Reload) — useful when the page itself caches too aggressively. Off by default.
- **Change the icon / badge color:** edit `COLORS` in `tools/make-icons.mjs` (re-run it, below) — the
  countdown badge reads the same green, so both stay in sync.
- **Lighten the worker:** the keep-alive that ticks the badge every second is **on by default** (a
  resident worker while any tab refreshes); set `KEEP_ALIVE = false` in `service-worker.js`
  (documented inline) to let the worker sleep between events at the cost of a coarser countdown.

## Developer scripts (npm)

No runtime dependencies — the scripts use Node built-ins and `zip`. They call the shared tooling in
`../tools/`, which acts on this extension directory.

| Command | What it does |
|---------|--------------|
| `npm test` | Validates the extension without a browser: MV3 shape, version sync, minimal permissions, no `default_popup`, every referenced icon present and correctly sized, the service worker parses — then runs the mocked-`chrome` behavior test (`test/worker.test.mjs`). |
| `npm run pack` | Builds `dist/tab-refresher-<git-hash>.zip` (and a `.crx` if a local Chrome is found). `dist/` is gitignored. |
| `npm run icons` | Regenerates the committed green/grey recycle PNGs (e.g. after changing colors). |
| `npm run hooks` | Points `core.hooksPath` at `.githooks` (gitleaks pre-push scan). |

> **Version is sourced from `manifest.json`.** `package.json`'s `version` must match it — `npm test`
> fails if they drift, so bump both when cutting a new release.

## Packaging (no automated publishing)

There is no release workflow — `npm run pack` builds the artifacts locally (see the
[monorepo README](../README.md#packaging-no-publishing) for details). Publishing to the
[Chrome Web Store](https://chrome.google.com/webstore/devconsole) is a manual step: the store wants a
root-level zip of `src/`, uploaded through the dashboard.

## File layout

```
tab-refresher/               # self-contained extension inside the monorepo
├── src/                     # what Chrome loads
│   ├── manifest.json        #   MV3 manifest: permissions, no-popup action, service worker
│   ├── service-worker.js    #   all runtime logic (toggle, alarm, reload, icon/state)
│   └── icons/               #   green-* (ON) and grey-* (OFF) recycle icons, 16/32/48/128 px
├── test/worker.test.mjs     # behavior test: real worker + mocked chrome + fake clock
├── package.json             # npm scripts (test / pack / icons / hooks) -> ../tools/
├── dist/                    # build output (gitignored)
├── CHANGELOG.md
└── README.md
```

Shared, repo-level pieces live one directory up: `tools/` (validator, packager, icon generator),
`.github/workflows/ci.yml`, `.githooks/pre-push`, `LICENSE`, `.editorconfig`.

---

## Verified Chrome API facts

Confirmed against the official Chrome for Developers docs (2026):

- `chrome.tabs.reload(tabId)` requires no permission (not `tabs`, host, or `activeTab`).
- The `tabs` permission only gates `url` / `title` / `favIconUrl` / `pendingUrl`.
- `chrome.alarms` minimum period is 30 seconds; default alarms are not persisted across restarts.
- `chrome.action.onClicked` fires only when no `default_popup` is set.
- `chrome.action.setIcon({ path })` swaps the toolbar icon at runtime (unpacked extensions must use PNG).
- `action.setIcon` / `setBadgeText` / `setBadgeBackgroundColor` / `setBadgeTextColor` (Chrome 110+) all
  accept a `tabId` to scope the icon and countdown badge to a single tab; none require a permission.
- Since Chrome 148, every extension API is also exposed under the cross-browser `browser` namespace —
  identical objects to `chrome.*` in Chrome. This worker uses `browser.*` throughout.
- Promise (callback-less) support is per-API: `chrome.storage` since Chrome 95, `chrome.alarms.get`/`clear`
  since 91, `chrome.alarms.create` since 111 — the hard floor for this promise-first worker
  (`minimum_chrome_version` declares 148; see design decisions).
- `chrome.tabs.onReplaced` and `chrome.windows.onFocusChanged` need no permission — used to follow a
  prerender-swapped tab id and to resync the countdown badge when window focus changes.
- `chrome.alarms.get(name)` returns the next `scheduledTime`; with one shared `tab-refresh` alarm,
  that single value is what every ON tab's countdown badge counts down to.
- `chrome.storage` (`storage` permission) is non-sensitive — no extra Web Store review or user warning.
- `storage.session` (Chrome 102+) is in-memory: it survives service-worker restarts and is cleared
  when the browser restarts or the extension is disabled/reloaded/updated; the `storage` permission
  covers it (10 MB quota).
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

The extension ships no network code, no secrets, and no host access. `*.pem` signing keys are
gitignored.

## License

[MIT](../LICENSE) © 2026 Steven Hsu
