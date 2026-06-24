// Renders the add-on catalog from addons.json.
// Only entries with `published: true` are shown — that flag is the single switch that
// advertises an add-on. CTA derives from the data: a Web Store URL becomes "Add to
// Chrome"; otherwise we link to the GitHub install. Adding an add-on = one JSON entry.

const REPO = 'https://github.com/shsu/chrome-extensions';
const grid = document.getElementById('addon-grid');
const countEl = document.getElementById('addon-count');

const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) {
    if (child != null) node.append(child);
  }
  return node;
};

function emptyState(message, linkText = 'Browse the repo', href = REPO) {
  return el('div', { className: 'empty' }, [
    el('p', { textContent: message }),
    el('a', { href, textContent: `${linkText} →` }),
  ]);
}

function card(addon, index) {
  const onStore = Boolean(addon.webStoreUrl);

  const icon = el('img', {
    className: 'card__icon',
    src: addon.icon,
    alt: '',
    width: 52,
    height: 52,
    loading: 'lazy',
  });

  const status = el('span', {
    className: 'status',
    title: onStore ? 'Live on the Chrome Web Store' : 'Published — install from GitHub',
  }, [el('span', { className: 'dot dot--live' }), onStore ? 'on store' : 'live']);

  const chips = el('ul', { className: 'chips', 'aria-label': 'Permissions requested' },
    [el('li', { className: 'chips__label', textContent: 'asks for' })].concat(
      (addon.permissions ?? []).map((p) => el('li', { className: 'chip', textContent: p })),
    ),
  );

  const primary = onStore
    ? el('a', { className: 'btn btn--primary', href: addon.webStoreUrl, textContent: 'Add to Chrome' })
    : el('a', { className: 'btn btn--primary', href: addon.installUrl ?? addon.githubUrl, textContent: 'Install' });

  const foot = el('div', { className: 'card__foot' }, [
    primary,
    addon.githubUrl ? el('a', { className: 'btn btn--ghost', href: addon.githubUrl, textContent: 'Source' }) : null,
    addon.version ? el('span', { className: 'ver', textContent: `v${addon.version}` }) : null,
  ]);

  const note = onStore ? null : el('p', { className: 'cta-note', textContent: 'not on the Web Store yet — load unpacked or grab a release' });

  const article = el('article', { className: 'card reveal' }, [
    el('div', { className: 'card__top' }, [icon, status]),
    el('h3', { className: 'card__name', textContent: addon.name }),
    el('p', { className: 'card__tagline', textContent: addon.tagline }),
    chips,
    foot,
    note,
  ]);
  article.style.animationDelay = `${index * 70}ms`;
  return article;
}

async function load() {
  let addons;
  try {
    const res = await fetch('addons.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    addons = await res.json();
    if (!Array.isArray(addons)) throw new Error('addons.json is not an array');
  } catch (err) {
    console.error('Tab Refresher site: could not load addons.json —', err);
    grid.replaceChildren(emptyState("Couldn't load the add-on list. Reload the page, or browse the source."));
    return;
  }

  const published = addons.filter((a) => a && a.published === true);

  if (published.length === 0) {
    grid.replaceChildren(emptyState('No add-ons published yet. Star the repo and check back.', 'Star the repo'));
    return;
  }

  grid.replaceChildren(...published.map(card));
  if (countEl) countEl.textContent = `(${published.length})`;
}

load();
