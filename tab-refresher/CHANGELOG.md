# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-07-06

### Changed
- Worker keep-alive is **on by default** (`KEEP_ALIVE` in `service-worker.js`): while any tab is
  refreshing, the worker stays resident and ticks the visible tab's badge every second; it re-arms
  itself when the worker restarts with tabs still ON, which also removes the cold-start click lag
  while anything is refreshing.
- Snappier toolbar click: the icon flip paints before the storage write, its `action.*` calls run in
  parallel, and the alarm tick reloads all ON tabs concurrently so a click landing mid-tick no longer
  waits for every reload in turn. (The occasional beat of lag on the first *arming* click after ~30s
  idle is the MV3 service-worker cold start — inherent.)
- Extension APIs are called via the cross-browser `browser.*` namespace (available since Chrome 148,
  the declared minimum).
- Badge digits pinned white via `action.setBadgeTextColor` instead of relying on auto-contrast.
- ON-tab state moved from `storage.local` to `storage.session` (Chrome 102+): its lifetime matches
  the design exactly — survives service-worker kills, cleared by Chrome at browser restart and on
  extension reload/update — so the startup handler now only clears the alarm.

### Added
- `BYPASS_CACHE` constant (default off): flip to make every refresh skip the HTTP cache
  (like Shift+Reload).
- Behavior tests for the keep-alive ticker (arming, per-second redraw, self-clear, re-arm on worker
  start), tab replacement, window-focus resync, and reload options.

### Fixed
- `minimum_chrome_version` raised from `88` to `148`: the promise-first worker's hard floor is
  Chrome 111 (`chrome.storage` promises since 95, `chrome.alarms.create` since 111 — on 88–94 every
  listener threw before doing anything), and current stable is declared on top of that floor.
- A tab whose id Chrome swaps in place (prerender activation) now keeps refreshing under its new id
  (`tabs.onReplaced`) instead of silently turning itself off on the next tick.
- The countdown badge now also resyncs when switching between Chrome windows
  (`windows.onFocusChanged`), not just between tabs.

## [1.1.0] - 2026-06-24

### Changed
- Refresh is now **per-tab on/off** (default off) instead of one pinned tab — toggling a tab no longer
  moves or steals the refresh from another, so several tabs can run at once.
- All ON tabs share **one 60-second timer** and reload together; a tab enabled mid-cycle joins the next
  shared tick.
- Brighter, bolder recycle icon (green `#43A047`).

### Added
- Live countdown badge on each ON tab (same green as the icon) showing seconds to the next refresh;
  resyncs on tab focus. Smooth per-second ticking is opt-in via `KEEP_ALIVE` in `service-worker.js`.
- Service-worker behavior test (mocked `chrome` + fake clock), wired into `npm test`.

## [1.0.0] - 2026-06-23

### Added
- Initial release: one-click toolbar toggle that auto-refreshes the pinned tab every 60 seconds
  (green recycle icon ON, grey OFF); auto-stops when the tab is closed or on a restricted page.
- Minimal permissions — `alarms` and `storage` only; no host, `tabs`, or `activeTab` permissions.
- `minimum_chrome_version: "88"`.
- Dependency-free icon generator (`tools/make-icons.mjs`).
- Validation suite (`npm test`), package build (`npm run build`), and release (`npm run release`) scripts.
- GitHub Actions: CI on every push/PR, and a tag-triggered release workflow that publishes a GitHub
  Release and (opt-in) uploads to the Chrome Web Store.

[1.2.0]: https://github.com/shsu/chrome-extensions/releases/tag/v1.2.0
[1.1.0]: https://github.com/shsu/chrome-extensions/releases/tag/v1.1.0
[1.0.0]: https://github.com/shsu/chrome-extensions/releases/tag/v1.0.0
