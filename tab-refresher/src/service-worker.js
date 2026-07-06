// Tab Refresher — Manifest V3 service worker (shared timer, per-tab on/off).
//
// Refresh is toggled PER TAB and OFF by default. Clicking the toolbar icon turns the
// current tab ON (green icon + green countdown badge) or OFF (grey icon, no badge), with
// no effect on any other tab. All ON tabs share ONE alarm and reload together every
// PERIOD_MINUTES; a tab armed mid-cycle joins the next shared tick. State is the set of
// ON tab ids in browser.storage.session; the single alarm runs while that set is non-empty.
//
// Permissions: "alarms" (the shared timer) and "storage" (persist the ON-tab set).
// browser.tabs.reload(), browser.action.* (always per tabId), the tabs events
// (onRemoved/onActivated/onReplaced), and windows.onFocusChanged all work without any
// tabs/host permission, so none are requested. See README.md.
//
// APIs are called via the cross-browser `browser` namespace — identical to `chrome` in
// Chrome (available since 148, our declared minimum) and portable to other engines.

const ALARM_NAME = 'tab-refresh';
const PERIOD_MINUTES = 1; // 60s. Chrome's minimum is 0.5 (30s). Change this one constant to retune.
const BADGE_BG = '#43A047'; // same green as the ON icon (keep in sync with COLORS.green in tools/make-icons.mjs).
const BADGE_TEXT = '#FFFFFF'; // badge digits pinned white rather than trusting Chrome's auto-contrast.
const BYPASS_CACHE = false; // true = hard refresh: every tick skips the HTTP cache (like Shift+Reload).

// Smooth per-second countdown. ON by default: while any tab is refreshing, the worker stays
// resident and ticks the visible tab's badge every second — each tick's chrome API call
// resets the ~30s idle kill, at a small always-on cost. Set false to let the worker sleep
// between events; the badge then updates only on toggle, tab/window focus, and each refresh,
// so the number may sit then jump.
const KEEP_ALIVE = true;

const ICON = {
  on:  { 16: 'icons/green-16.png', 32: 'icons/green-32.png', 48: 'icons/green-48.png', 128: 'icons/green-128.png' },
  off: { 16: 'icons/grey-16.png',  32: 'icons/grey-32.png',  48: 'icons/grey-48.png',  128: 'icons/grey-128.png' },
};
const TITLE = {
  on:  'Tab Refresher: ON — refreshing this tab (click to stop)',
  off: 'Tab Refresher: OFF (click to refresh this tab)',
};

// Serialize every read-modify-write of the ON-tab set. Clicks, the alarm fire, tab closes
// and focus changes can all interleave within one worker lifetime; chaining them keeps a
// concurrent change from clobbering the set (e.g. dropping a tab). Each listener returns
// this promise so the set is fully settled before the next event's work begins.
let chain = Promise.resolve();
const serialize = (fn) => (chain = chain.then(fn, fn).catch(() => {}));

async function getOnTabs() {
  const { tabIds = [] } = await browser.storage.session.get('tabIds');
  return new Set(tabIds);
}
const setOnTabs = (set) => browser.storage.session.set({ tabIds: [...set] });

// Seconds until the next shared refresh, read from the one alarm (null if none).
async function secondsLeft() {
  const alarm = await browser.alarms.get(ALARM_NAME);
  return alarm ? Math.max(0, Math.round((alarm.scheduledTime - Date.now()) / 1000)) : null;
}

// Per-tab toolbar state. ALWAYS scoped with tabId — a tabId-less call would set the global
// default and bleed green/badge onto tabs the user never turned on. Tabs without an override
// fall back to the manifest's grey default_icon, so green shows only on ON tabs.
async function applyState(tabId, on) {
  try {
    // One round trip's latency instead of three — this is the user-visible feedback path.
    await Promise.all([
      browser.action.setIcon({ tabId, path: on ? ICON.on : ICON.off }),
      browser.action.setTitle({ tabId, title: on ? TITLE.on : TITLE.off }),
      on
        ? Promise.all([
            browser.action.setBadgeBackgroundColor({ tabId, color: BADGE_BG }),
            browser.action.setBadgeTextColor({ tabId, color: BADGE_TEXT }),
          ]).then(() => drawBadge(tabId))
        : browser.action.setBadgeText({ tabId, text: '' }),
    ]);
  } catch {
    // Tab is gone — nothing to update.
  }
}

async function drawBadge(tabId) {
  const s = await secondsLeft();
  try {
    await browser.action.setBadgeText({ tabId, text: s == null ? '' : String(s) });
  } catch {
    // Tab is gone.
  }
}

// Toolbar click: toggle just the clicked tab. Arm the shared alarm when the set goes from
// empty to non-empty; clear it when the last tab turns off. In both branches the icon flip
// (applyState) runs BEFORE the storage write, so the visible response never waits on
// persistence — only on the alarm, which the ON badge needs for its countdown.
browser.action.onClicked.addListener((tab) => {
  if (tab?.id == null) return;
  return serialize(async () => {
    const on = await getOnTabs();
    if (on.has(tab.id)) {
      await applyState(tab.id, false);
      on.delete(tab.id);
      await setOnTabs(on);
      if (on.size === 0) await browser.alarms.clear(ALARM_NAME);
    } else {
      if (on.size === 0) await browser.alarms.create(ALARM_NAME, { periodInMinutes: PERIOD_MINUTES });
      await applyState(tab.id, true);
      on.add(tab.id);
      await setOnTabs(on);
      maybeKeepAlive();
    }
  });
});

// Shared timer fires: reload every ON tab; drop any that fail (closed/restricted); refresh
// the countdown on the rest. Clear the alarm if the set ends up empty. Reloads run in
// PARALLEL — everything here holds the serialize chain, so a sequential walk would make a
// click landing mid-tick wait for every reload in turn.
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  return serialize(async () => {
    const on = await getOnTabs();
    if (on.size === 0) { await browser.alarms.clear(ALARM_NAME); return; }
    const failed = (await Promise.all([...on].map((tabId) =>
      // reload() needs no permission; rejects if the tab is gone/not reloadable.
      browser.tabs.reload(tabId, { bypassCache: BYPASS_CACHE }).then(() => null, () => tabId),
    ))).filter((tabId) => tabId != null);
    for (const tabId of failed) {
      on.delete(tabId);
      await applyState(tabId, false);
    }
    await setOnTabs(on);
    if (on.size === 0) { await browser.alarms.clear(ALARM_NAME); return; }
    await Promise.all([...on].map((tabId) => drawBadge(tabId))); // reset countdowns to the new shared period.
  });
});

// A closed tab drops out of the set; clear the alarm if it was the last one.
browser.tabs.onRemoved.addListener((closedId) => serialize(async () => {
  const on = await getOnTabs();
  if (on.delete(closedId)) {
    await setOnTabs(on);
    if (on.size === 0) await browser.alarms.clear(ALARM_NAME);
  }
}));

// Chrome sometimes swaps a tab's id while keeping "the tab" (prerender activation). Without
// this, the old id fails its next reload and the tab silently turns itself off.
browser.tabs.onReplaced.addListener((addedId, removedId) => serialize(async () => {
  const on = await getOnTabs();
  if (on.delete(removedId)) {
    on.add(addedId);
    await setOnTabs(on);
    await applyState(addedId, true);
  }
}));

// Switching tabs: resync the now-visible tab's countdown to the shared clock. OFF tabs need
// nothing — their badge was cleared when they turned off.
browser.tabs.onActivated.addListener(({ tabId }) => serialize(async () => {
  const on = await getOnTabs();
  if (on.has(tabId)) await drawBadge(tabId);
}));

// Switching windows: onActivated only fires within a window, so resync the newly focused
// window's active tab too (otherwise its badge shows the count from when it was last seen).
browser.windows.onFocusChanged.addListener((windowId) => serialize(async () => {
  if (windowId === browser.windows.WINDOW_ID_NONE) return;
  const on = await getOnTabs();
  if (on.size === 0) return;
  const [active] = await browser.tabs.query({ active: true, windowId });
  if (active && on.has(active.id)) await drawBadge(active.id);
}));

// ON does not survive a browser restart — and needs no cleanup code to guarantee it: the set
// lives in storage.session, which Chrome clears when the browser restarts or the extension is
// disabled/reloaded/updated. Only the alarm is cleared defensively here.
const reset = () => serialize(async () => {
  await browser.alarms.clear(ALARM_NAME);
});
browser.runtime.onStartup.addListener(reset);
browser.runtime.onInstalled.addListener(reset);

// Smooth countdown (see KEEP_ALIVE). The 1s tick itself makes the chrome API calls
// that keep the worker awake, and only touches the visible tab's badge — O(1) per tick.
let ticker = null;
function maybeKeepAlive() {
  if (!KEEP_ALIVE || ticker) return;
  ticker = setInterval(() => serialize(async () => {
    const on = await getOnTabs();
    if (on.size === 0) { clearInterval(ticker); ticker = null; return; }
    const [active] = await browser.tabs.query({ active: true, currentWindow: true });
    if (active && on.has(active.id)) await drawBadge(active.id);
  }), 1000);
}

// A toolbar click isn't the only way this worker starts — the alarm or a tab event can wake
// it after an idle kill — so re-arm the keep-alive on every start while any tab is still ON.
serialize(async () => {
  if ((await getOnTabs()).size > 0) maybeKeepAlive();
});
