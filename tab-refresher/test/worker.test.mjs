// Behavior test for service-worker.js — loads the REAL file in a vm with a mocked
// `chrome` API and a fake clock, then drives events and asserts the shared-timer design:
//   - refresh is per-tab and OFF by default; toggling one tab never touches another
//   - all ON tabs share ONE alarm and reload together; a tab armed mid-cycle shows the
//     time left on the shared clock (e.g. 45s after 15s elapsed)
//   - every chrome.action.* call carries a tabId (so green/badge never leak to other tabs)
// Run: node test/worker.test.mjs   (also wired into `npm test`)

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CODE = readFileSync(join(HERE, '..', 'src', 'service-worker.js'), 'utf8');
const MIN = 60_000;

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

// Build a fresh mocked environment + load the worker into it. seedStore pre-populates
// chrome.storage.local, simulating a worker woken after a kill with state already persisted.
function load(seedStore) {
  const clock = { now: 1_000_000 };
  const L = {};                       // captured listeners by event name
  const store = { ...seedStore };     // chrome.storage.local backing
  const alarms = new Map();           // name -> { name, periodInMinutes, scheduledTime }
  const restricted = new Set();       // tabIds whose reload() should throw
  let activeTab = null;
  const calls = { reload: [], setIcon: [], setBadgeText: [], setBadgeBg: [], setBadgeTextColor: [], setTitle: [], noTabId: [] };

  const reg = (key) => ({ addListener: (fn) => { L[key] = fn; } });
  const guardTabId = (kind, o) => { if (!o || o.tabId == null) calls.noTabId.push({ kind, o }); };

  const chrome = {
    storage: { session: {
      async get(keys) {
        const ks = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys || {});
        const out = {};
        for (const k of ks) if (k in store) out[k] = store[k];
        return out;
      },
      async set(obj) { Object.assign(store, obj); },
    } },
    alarms: {
      async create(name, info) {
        alarms.set(name, { name, periodInMinutes: info.periodInMinutes, scheduledTime: clock.now + info.periodInMinutes * MIN });
      },
      async clear(name) { return alarms.delete(name); },
      async get(name) { return alarms.get(name); },
      async getAll() { return [...alarms.values()]; },
      onAlarm: reg('onAlarm'),
    },
    tabs: {
      async reload(tabId, opts) { if (restricted.has(tabId)) throw new Error('not reloadable'); calls.reload.push({ t: clock.now, tabId, opts }); },
      async query() { return activeTab == null ? [] : [{ id: activeTab, active: true }]; },
      onRemoved: reg('onRemoved'),
      onActivated: reg('onActivated'),
      onReplaced: reg('onReplaced'),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: reg('onFocusChanged'),
    },
    action: {
      async setIcon(o) { guardTabId('setIcon', o); calls.setIcon.push({ ...o }); },
      async setTitle(o) { guardTabId('setTitle', o); calls.setTitle.push({ ...o }); },
      async setBadgeText(o) { guardTabId('setBadgeText', o); calls.setBadgeText.push({ ...o }); },
      async setBadgeBackgroundColor(o) { guardTabId('setBadgeBg', o); calls.setBadgeBg.push({ ...o }); },
      async setBadgeTextColor(o) { guardTabId('setBadgeTextColor', o); calls.setBadgeTextColor.push({ ...o }); },
      onClicked: reg('onClicked'),
    },
    runtime: { onStartup: reg('onStartup'), onInstalled: reg('onInstalled') },
  };

  // Capturing interval fake: lets tests fire the keep-alive tick by hand via tick().
  const intervals = new Map();
  let nextIntervalId = 0;
  const ctx = {
    chrome, browser: chrome, console, Date: { now: () => clock.now },
    setInterval: (fn) => { intervals.set(++nextIntervalId, fn); return nextIntervalId; },
    clearInterval: (id) => { intervals.delete(id); },
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);

  // Fire any alarms due within the advance window, rescheduling periodic ones.
  async function advance(ms) {
    const target = clock.now + ms;
    while (true) {
      let due = null;
      for (const a of alarms.values()) if (a.scheduledTime <= target && (!due || a.scheduledTime < due.scheduledTime)) due = a;
      if (!due) break;
      clock.now = due.scheduledTime;
      due.scheduledTime += due.periodInMinutes * MIN;
      if (L.onAlarm) await L.onAlarm({ name: due.name });
    }
    clock.now = target;
  }

  const isGreen = (c) => c.path && /green/.test(c.path['16'] ?? '');
  const lastIcon = (tabId) => [...calls.setIcon].reverse().find((c) => c.tabId === tabId);
  const lastBadge = (tabId) => [...calls.setBadgeText].reverse().find((c) => c.tabId === tabId)?.text ?? '';

  return {
    L, store, alarms, calls, clock, advance, isGreen, lastIcon, lastBadge, intervals,
    tick: async () => { for (const fn of [...intervals.values()]) await fn(); },
    setActive: (id) => { activeTab = id; },
    restrict: (id) => restricted.add(id),
    click: (id) => L.onClicked({ id }),
    activate: (id) => L.onActivated({ tabId: id }),
    closeTab: (id) => L.onRemoved(id),
    replaceTab: (addedId, removedId) => L.onReplaced(addedId, removedId),
    focusWindow: (windowId) => L.onFocusChanged(windowId),
    install: () => L.onInstalled(),
    // Chrome clears storage.session at browser restart — the mock does the same before onStartup.
    startup: () => { for (const k of Object.keys(store)) delete store[k]; return L.onStartup(); },
  };
}

async function run() {
  // --- registration: the design needs a per-tab focus listener too ----------------
  {
    const w = load();
    check('registers onClicked / onAlarm / onRemoved / onActivated', !!(w.L.onClicked && w.L.onAlarm && w.L.onRemoved && w.L.onActivated));
    check('registers onReplaced / windows.onFocusChanged', !!(w.L.onReplaced && w.L.onFocusChanged));
    check('registers onStartup / onInstalled', !!(w.L.onStartup && w.L.onInstalled));
  }

  // --- turn on A, switch to B (OFF): B must show off, A only must be green ---------
  {
    const w = load();
    await w.install();
    w.setActive(1);
    await w.click(1);                  // A on
    w.setActive(2);
    await w.activate(2);               // look at B (never armed)
    check('A icon went green', w.isGreen(w.lastIcon(1) ?? {}));
    check('B never got a green icon (shows OFF)', !w.calls.setIcon.some((c) => c.tabId === 2 && w.isGreen(c)));
    check('B has no countdown badge', (w.lastBadge(2) || '') === '');
    check('one shared alarm exists', w.alarms.size === 1 && w.alarms.has('tab-refresh'));
    check('A badge digits pinned white', w.calls.setBadgeTextColor.some((c) => c.tabId === 1 && /^#fff/i.test(c.color)));
  }

  // --- shared timer: B armed at +15s shows ~45 and joins the SAME alarm ------------
  {
    const w = load();
    await w.install();
    w.setActive(1); await w.click(1);                 // t=0  A on, alarm fires at t=60
    await w.advance(15_000);                          // t=15
    w.setActive(2); await w.click(2);                 // t=15 B on
    check('still exactly one shared alarm (B did not add its own)', w.alarms.size === 1);
    check('B badge shows ~45s left on the shared clock', w.lastBadge(2) === '45', `got ${w.lastBadge(2)}`);
    w.setActive(1); await w.activate(1);              // focusing A resyncs its badge to the shared value
    check('focusing A resyncs its badge to the same ~45', w.lastBadge(1) === '45', `got ${w.lastBadge(1)}`);

    // tab C (id 3) stays OFF. Fire the shared tick.
    await w.advance(45_000);                          // t=60 -> shared fire
    const reloaded = new Set(w.calls.reload.map((r) => r.tabId));
    check('shared fire reloaded A and B', reloaded.has(1) && reloaded.has(2));
    check('OFF tab C was never reloaded', !reloaded.has(3));
    check('reloads carry the BYPASS_CACHE option (off)', w.calls.reload.every((r) => r.opts?.bypassCache === false));
    check('after fire, badges reset toward 60', w.lastBadge(1) === '60' && w.lastBadge(2) === '60', `A=${w.lastBadge(1)} B=${w.lastBadge(2)}`);
  }

  // --- per-tab OFF: turning A off keeps B going; last off clears the alarm ---------
  {
    const w = load();
    await w.install();
    w.setActive(1); await w.click(1);
    w.setActive(2); await w.click(2);
    await w.click(1);                                  // A off
    check('A turned grey', !w.isGreen(w.lastIcon(1) ?? { path: {} }));
    check('alarm still running (B on)', w.alarms.has('tab-refresh'));
    const before = w.calls.reload.length;
    await w.advance(60_000);
    const after = w.calls.reload.slice(before).map((r) => r.tabId);
    check('next fire reloads only B', after.length === 1 && after[0] === 2, `got ${after}`);
    await w.click(2);                                  // B off -> last one
    check('alarm cleared when last tab turns off', w.alarms.size === 0);
  }

  // --- a reload failure (restricted page) drops just that tab ----------------------
  {
    const w = load();
    await w.install();
    w.setActive(1); await w.click(1);
    w.setActive(2); await w.click(2);
    w.restrict(1);                                    // A becomes unreloadable
    await w.advance(60_000);
    check('restricted tab A removed, B still reloads', w.calls.reload.some((r) => r.tabId === 2));
    const mark = w.clock.now;
    await w.advance(60_000);
    check('A no longer attempted after removal', !w.calls.reload.some((r) => r.tabId === 1 && r.t >= mark));
    check('B still the only ON tab', w.alarms.has('tab-refresh'));
  }

  // --- tab replaced by Chrome (prerender swap): refresh follows the new id ---------
  {
    const w = load();
    await w.install();
    w.setActive(1); await w.click(1);
    await w.replaceTab(9, 1);                         // Chrome swaps tab 1 -> tab 9
    await w.advance(60_000);
    const reloaded = w.calls.reload.map((r) => r.tabId);
    check('replaced tab keeps refreshing under its new id', reloaded.includes(9), `got ${reloaded}`);
    check('old id is never reloaded after the swap', !reloaded.includes(1));
    check('new id shows green', w.isGreen(w.lastIcon(9) ?? {}));
    check('replacing an OFF tab changes nothing', (await (async () => { await w.replaceTab(7, 5); return w.store.tabIds.length; })()) === 1);
  }

  // --- window focus change resyncs the visible tab's badge to the shared clock -----
  {
    const w = load();
    await w.install();
    w.setActive(1); await w.click(1);                 // t=0, badge 60
    await w.advance(20_000);                          // t=20, worker slept: badge still says 60
    await w.focusWindow(5);                           // focus returns to this tab's window
    check('focus change resyncs badge to time left (40)', w.lastBadge(1) === '40', `got ${w.lastBadge(1)}`);
    await w.focusWindow(-1);                          // WINDOW_ID_NONE: focus left Chrome
    check('losing focus does not touch the badge', w.lastBadge(1) === '40');
  }

  // --- keep-alive ticker: armed on ON, follows the clock, self-clears when empty ---
  {
    const w = load();
    await w.install();
    w.setActive(1); await w.click(1);
    check('keep-alive ticker armed on first ON', w.intervals.size === 1);
    await w.advance(5_000);
    await w.tick();
    check('each tick redraws the visible badge (55)', w.lastBadge(1) === '55', `got ${w.lastBadge(1)}`);
    await w.click(1);                                 // last tab off
    await w.tick();                                   // next tick notices the empty set
    check('ticker self-clears when the set empties', w.intervals.size === 0);
  }

  // --- worker restart with tabs still ON: keep-alive re-arms without a click -------
  {
    const w = load({ tabIds: [1] });                  // storage as left behind by a killed worker
    await new Promise((r) => setImmediate(r));        // let the load-time re-arm settle
    check('keep-alive re-arms on worker start', w.intervals.size === 1);
  }

  // --- restart/install resets to empty --------------------------------------------
  {
    const w = load();
    w.setActive(1); await w.click(1);
    await w.startup();
    check('startup cleared the alarm', w.alarms.size === 0);
    check('session store empty after restart (cleared by the platform)', (w.store.tabIds ?? []).length === 0, `tabIds=${JSON.stringify(w.store.tabIds)}`);
  }

  // --- global invariant across everything above: no action call without a tabId ----
  {
    const w = load();
    await w.install();
    w.setActive(1); await w.click(1);
    w.setActive(2); await w.click(2);
    await w.advance(60_000);
    await w.click(1);
    w.closeTab(2);
    check('every chrome.action.* call carried a tabId', w.calls.noTabId.length === 0, `${w.calls.noTabId.length} call(s) missing tabId`);
  }

  console.log(`\n${fail ? 'FAILED' : 'All passed'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
