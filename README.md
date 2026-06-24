# chrome-extensions

A monorepo of minimal, least-privilege Google Chrome extensions (Manifest V3). Each extension is a
top-level directory with its loadable source in `<name>/src/` and builds in `<name>/dist/`. The
build/test tooling is shared at the repo root in `tools/` and is generic — it acts on whichever
extension directory you run it from.

## Extensions

| Extension | Description |
|-----------|-------------|
| [tab-refresher](tab-refresher) | Per-tab toolbar toggle that auto-refreshes each chosen tab every 60 seconds, with a live green countdown badge. Run several at once. |

## Repo layout

```
chrome-extensions/
├── tools/                     # shared, generic: make-icons.mjs, pack.sh, test.mjs
├── tab-refresher/             # a self-contained MV3 extension
│   ├── src/                   #   what Chrome loads: manifest.json, service-worker.js, icons/
│   ├── package.json  README.md  CHANGELOG.md
│   └── dist/                  #   built zip/crx (gitignored)
├── .github/workflows/ci.yml   # matrix: runs each extension's `npm test` on push / PR
├── .githooks/pre-push         # gitleaks secret scan
├── .editorconfig  .gitignore  LICENSE
```

## Working on an extension

```bash
cd tab-refresher
npm test         # validate this extension (MV3 shape, permissions, icons, syntax)
npm run pack     # build dist/<name>-<git-hash>.{zip,crx}
npm run icons    # regenerate src/icons
```

The scripts call the shared tools in `../tools/`, which act on the current extension directory. Load
it unpacked from `tab-refresher/src/` (`chrome://extensions` → Developer mode → Load unpacked).

## Packaging (no publishing)

`npm run pack` builds two artifacts in `<name>/dist/` (gitignored):

- **`<name>-<git-hash>.zip`** — wraps a `<name>-<git-hash>/` directory, so it extracts cleanly.
- **`<name>-<git-hash>.crx`** — signed with `key.pem` (generated on first run, gitignored; keep it
  safe — it fixes the extension ID). Needs a local Chrome; override its path with `CHROME=...`.

No automated publishing. (A `.crx` isn't installable by normal users outside the Web Store — it's for
self-/enterprise distribution. The Web Store wants a root-level zip, not the wrapper-dir zip above.)

## Adding an extension

Create `<name>/` with `src/` (manifest + assets), a `package.json` whose scripts call `../tools/…`
(copy tab-refresher's), `README.md`, and `CHANGELOG.md`. CI discovers it automatically (any top-level
dir with `src/manifest.json`).

## Security

A pre-push hook (`.githooks/pre-push`) runs [gitleaks](https://github.com/gitleaks/gitleaks) to block
pushes that contain a secret. Enable it once per clone:

```bash
git config core.hooksPath .githooks   # or, from an extension: npm run hooks
brew install gitleaks                 # the hook warns and skips if gitleaks isn't installed
```

## License

[MIT](LICENSE) © 2026 Steven Hsu
