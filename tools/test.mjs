// Shared validation suite — run from an extension directory:  npm test
// Asserts what makes an extension loadable and honest: MV3 shape, version sync, minimal
// permissions, click-to-toggle wiring, every referenced icon present and correctly sized,
// and that the service worker parses. Acts on the current working directory (the
// extension); loadable source lives in src/. Exits non-zero on any failure (CI-friendly).

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.cwd();
const r = (...p) => join(root, ...p);

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL  ${name}\n      ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Read width/height straight from the PNG IHDR (no image library needed).
function pngSize(path) {
  const b = readFileSync(path);
  assert(b.length >= 24 && b.readUInt32BE(0) === 0x89504e47, `${path}: not a PNG`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

const manifest = JSON.parse(readFileSync(r('src', 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(r('package.json'), 'utf8'));

check('manifest is Manifest V3', () => assert(manifest.manifest_version === 3, `got ${manifest.manifest_version}`));

check('manifest.version matches package.json', () =>
  assert(manifest.version === pkg.version, `manifest ${manifest.version} != package ${pkg.version}`),
);

check('permissions are minimal [alarms, storage]', () => {
  const got = [...(manifest.permissions ?? [])].sort();
  assert(JSON.stringify(got) === JSON.stringify(['alarms', 'storage']), `got ${JSON.stringify(manifest.permissions)}`);
});

check('no host_permissions / optional permissions creep', () => {
  assert(!manifest.host_permissions, 'host_permissions present');
  assert(!manifest.optional_permissions, 'optional_permissions present');
  assert(!manifest.optional_host_permissions, 'optional_host_permissions present');
});

check('action has no default_popup (so onClicked fires)', () =>
  assert(manifest.action && manifest.action.default_popup === undefined, 'default_popup is set'),
);

check('background service worker is declared and present', () => {
  const sw = manifest.background?.service_worker;
  assert(sw === 'service-worker.js', `got ${sw}`);
  assert(existsSync(r('src', sw)), `src/${sw} missing on disk`);
});

check('every manifest-referenced icon exists', () => {
  const paths = new Set([
    ...Object.values(manifest.action?.default_icon ?? {}),
    ...Object.values(manifest.icons ?? {}),
  ]);
  for (const p of paths) assert(existsSync(r('src', p)), `missing src/${p}`);
});

check('all 8 state icons exist at correct dimensions', () => {
  for (const color of ['green', 'grey']) {
    for (const size of [16, 32, 48, 128]) {
      const p = `icons/${color}-${size}.png`;
      assert(existsSync(r('src', p)), `missing src/${p}`);
      const { w, h } = pngSize(r('src', p));
      assert(w === size && h === size, `src/${p} is ${w}x${h}, expected ${size}x${size}`);
    }
  }
});

check('service worker parses', () =>
  execFileSync('node', ['--check', r('src', 'service-worker.js')], { stdio: 'pipe' }),
);

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
