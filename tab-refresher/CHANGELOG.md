# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.1.0]: https://github.com/shsu/chrome-extensions/releases/tag/v1.1.0
[1.0.0]: https://github.com/shsu/chrome-tab-refresher/releases/tag/v1.0.0
