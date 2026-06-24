// Tab Refresher — Manifest V3 service worker (shared timer, per-tab on/off).
//
// Refresh is toggled PER TAB and OFF by default. Clicking the toolbar icon turns the
// current tab ON (green icon + green countdown badge) or OFF (grey icon, no badge), with
// no effect on any other tab. All ON tabs share ONE alarm and reload together every
// PERIOD_MINUTES; a tab armed mid-cycle joins the next shared tick. State is the set of
// ON tab ids in chrome.storage.local; the single alarm runs while that set is non-empty.
//
// Permissions: "alarms" (the shared timer) and "storage" (persist the ON-tab set).
// chrome.tabs.reload(), chrome.action.* (always per tabId), and tabs.onRemoved/onActivated
// all work without any tabs/host permission, so none are requested. See README.md.

const ALARM_NAME = 'tab-refresh';
const PERIOD_MINUTES = 1; // 60s. Chrome's minimum is 0.5 (30s). Change this one constant to retune.
const BADGE_BG = '#43A047'; // same green as the ON icon (keep in sync with COLORS.green in tools/make-icons.mjs).

// Smooth per-second countdown. OFF by default: the badge is set on toggle, on tab focus,
// and on each refresh — cheap, but the worker sleeps between, so the number may sit then
// jump. Set KEEP_ALIVE = true to keep the worker resident and tick the visible tab's badge
// every second (a small always-on cost while any tab is refreshing).
const KEEP_ALIVE = false;

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
  const { tabIds = [] } = await chrome.storage.local.get('tabIds');
  return new Set(tabIds);
}
const setOnTabs = (set) => chrome.storage.local.set({ tabIds: [...set] });

// Seconds until the next shared refresh, read from the one alarm (null if none).
async function secondsLeft() {
  const alarm = await chrome.alarms.get(ALARM_NAME);
  return alarm ? Math.max(0, Math.round((alarm.scheduledTime - Date.now()) / 1000)) : null;
}

// Per-tab toolbar state. ALWAYS scoped with tabId — a tabId-less call would set the global
// default and bleed green/badge onto tabs the user never turned on. Tabs without an override
// fall back to the manifest's grey default_icon, so green shows only on ON tabs.
async function applyState(tabId, on) {
  try {
    await chrome.action.setIcon({ tabId, path: on ? ICON.on : ICON.off });
    await chrome.action.setTitle({ tabId, title: on ? TITLE.on : TITLE.off });
    if (on) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_BG });
      await drawBadge(tabId);
    } else {
      await chrome.action.setBadgeText({ tabId, text: '' });
    }
  } catch {
    // Tab is gone — nothing to update.
  }
}

async function drawBadge(tabId) {
  const s = await secondsLeft();
  try {
    await chrome.action.setBadgeText({ tabId, text: s == null ? '' : String(s) });
  } catch {
    // Tab is gone.
  }
}

// Toolbar click: toggle just the clicked tab. Arm the shared alarm when the set goes from
// empty to non-empty; clear it when the last tab turns off.
chrome.action.onClicked.addListener((tab) => {
  if (tab?.id == null) return;
  return serialize(async () => {
    const on = await getOnTabs();
    if (on.has(tab.id)) {
      on.delete(tab.id);
      await setOnTabs(on);
      if (on.size === 0) await chrome.alarms.clear(ALARM_NAME);
      await applyState(tab.id, false);
    } else {
      if (on.size === 0) await chrome.alarms.create(ALARM_NAME, { periodInMinutes: PERIOD_MINUTES });
      on.add(tab.id);
      await setOnTabs(on);
      await applyState(tab.id, true);
      maybeKeepAlive();
    }
  });
});

// Shared timer fires: reload every ON tab; drop any that fail (closed/restricted); refresh
// the countdown on the rest. Clear the alarm if the set ends up empty.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  return serialize(async () => {
    const on = await getOnTabs();
    if (on.size === 0) { await chrome.alarms.clear(ALARM_NAME); return; }
    for (const tabId of [...on]) {
      try {
        await chrome.tabs.reload(tabId); // needs no permission; throws if the tab is gone/not reloadable.
      } catch {
        on.delete(tabId);
        await applyState(tabId, false);
      }
    }
    await setOnTabs(on);
    if (on.size === 0) { await chrome.alarms.clear(ALARM_NAME); return; }
    for (const tabId of on) await drawBadge(tabId); // reset countdowns to the new shared period.
  });
});

// A closed tab drops out of the set; clear the alarm if it was the last one.
chrome.tabs.onRemoved.addListener((closedId) => serialize(async () => {
  const on = await getOnTabs();
  if (on.delete(closedId)) {
    await setOnTabs(on);
    if (on.size === 0) await chrome.alarms.clear(ALARM_NAME);
  }
}));

// Switching tabs: resync the now-visible tab's countdown to the shared clock. OFF tabs need
// nothing — their badge was cleared when they turned off.
chrome.tabs.onActivated.addListener(({ tabId }) => serialize(async () => {
  const on = await getOnTabs();
  if (on.has(tabId)) await drawBadge(tabId);
}));

// ON does not survive a browser restart: tab ids are stale and the alarm isn't persisted,
// so reconcile to a clean empty set.
const reset = () => serialize(async () => {
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.storage.local.set({ tabIds: [] });
});
chrome.runtime.onStartup.addListener(reset);
chrome.runtime.onInstalled.addListener(reset);

// Opt-in smooth countdown (see KEEP_ALIVE). The 1s tick itself makes the chrome API calls
// that keep the worker awake, and only touches the visible tab's badge — O(1) per tick.
let ticker = null;
function maybeKeepAlive() {
  if (!KEEP_ALIVE || ticker) return;
  ticker = setInterval(() => serialize(async () => {
    const on = await getOnTabs();
    if (on.size === 0) { clearInterval(ticker); ticker = null; return; }
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active && on.has(active.id)) await drawBadge(active.id);
  }), 1000);
}
