// viewer shell: the gallery at /stages and one stage at /stage/<id>.
// the stage runs in a sandboxed frame on its own origin; everything it sends is untrusted.
const THEME_KEY = 'stage.theme';
const SEND_KEY = 'stage.send';
// the new-comment box: px from its anchor point and the page edges
const DRAFT_GAP = 8;
// a drawn area's capture or an attached image, as a data: url; the daemon caps the decoded bytes at 1 MB
const IMAGE_MAX_CHARS = 1398000;
// images attached to one comment, and the longest edge they are scaled to (what the model reads in full)
const ATTACH_MAX = 4;
const ATTACH_EDGE = 1568;
// reload this long after a thread's working window ends
const STATUS_SLACK_MS = 500;
const PANEL_KEY = 'stage.panel';
const PANEL_W_KEY = 'stage.panel-width';
const INSPECTOR_W_KEY = 'stage.inspector-width';
// a sidebar's width while dragged, px: its least, the least it leaves the frame, and an arrow key's step
const PANEL_MIN = 280;
const FRAME_MIN = 320;
const PANEL_STEP = 16;
const THEMES = ['system', 'light', 'dark'];
// the devices a page can be shown at, in CSS px portrait; responsive fills the space
const DEVICES = [
    { id: 'responsive', label: 'Responsive' },
    // snapchat shows a web lens in portrait only
    { id: 'lens', label: 'Snapchat Web Lens', w: 360, h: 640, portrait: true },
    { id: 'iphone', label: 'iPhone', w: 390, h: 844 },
    { id: 'android', label: 'Android', w: 412, h: 915 },
    { id: 'ipad', label: 'iPad', w: 820, h: 1180 }
];
const DEVICE_KEY = 'stage.device';

// snapchat's own controls over a web lens, measured from iphone 17 pro screenshots of the camera preview (920x1634,
// 9:16): faint icons drawn over the frame rather than into the page, to lay a lens out around. in the carousel the
// lens is live in the camera, under snapchat's camera and lens controls; full screen, only its close button shows
const LENS_ICONS = {
    profile: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2|M8 7a4 4 0 1 0 8 0 4 4 0 1 0-8 0',
    search: 'M3 11a8 8 0 1 0 16 0 8 8 0 1 0-16 0|m21 21-4.3-4.3',
    friend: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2|M5 7a4 4 0 1 0 8 0 4 4 0 1 0-8 0|M19 8v6|M22 11h-6',
    flip: 'm17 2 4 4-4 4|M3 11v-1a4 4 0 0 1 4-4h14|m7 22-4-4 4-4|M21 13v1a4 4 0 0 1-4 4H3',
    music: 'M9 18V5l12-2v13|M3 18a3 3 0 1 0 6 0 3 3 0 1 0-6 0|M15 16a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
    more: 'm6 9 6 6 6-6',
    lens: 'M2 12a10 10 0 1 0 20 0 10 10 0 1 0-20 0|M8 14s1.5 2 4 2 4-2 4-2|M9 9h.01|M15 9h.01',
    heart: 'M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7z',
    share: 'm15 14 5-5-5-5|M4 20v-7a4 4 0 0 1 4-4h12',
    views: 'M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7|M9 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
    create: 'M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7|M16 5h6|M19 2v6',
    close: 'M18 6 6 18|m6 6 12 12'
};
// [x, y, icon size, icon, radius of the bubble it sits on]
const lensGuides = (controls, extra = '') => `<svg viewBox="0 0 920 1634" preserveAspectRatio="none">
    ${controls
        .map(
            ([x, y, size, name, r]) =>
                `${r ? `<circle class="bubble" cx="${x}" cy="${y}" r="${r}"/>` : ''}${
                    name
                        ? `<g class="icon" transform="translate(${x - size / 2} ${y - size / 2}) scale(${size / 24})">${LENS_ICONS[
                              name
                          ]
                              .split('|')
                              .map((d) => `<path d="${d}"/>`)
                              .join('')}</g>`
                        : ''
                }`
        )
        .join('')}${extra}
</svg>`;
const LENS_GUIDES = {
    carousel: lensGuides(
        [
            [64, 57, 56, 'profile', 45],
            [173, 57, 50, 'search'],
            [745, 57, 50, 'friend'],
            [856, 57, 50, 'flip'],
            [856, 148, 46, 'music'],
            [856, 240, 40, 'more', 30],
            [64, 174, 50, 'lens', 45],
            [64, 282, 46, 'heart'],
            [64, 374, 46, 'share'],
            [64, 466, 46, 'views'],
            [7, 1415, 0, '', 57],
            [144, 1415, 56, 'lens', 57],
            [281, 1415, 56, 'lens', 57],
            [460, 1415, 64, 'lens', 80],
            [638, 1415, 56, 'lens', 57],
            [775, 1415, 56, 'lens', 57],
            [900, 1415, 56, 'lens', 57],
            [64, 1560, 52, 'create'],
            [856, 1560, 52, 'lens']
        ],
        `<text x="64" y="510" class="small">28k</text>
    <circle class="ring" cx="460" cy="1415" r="92"/>
    <rect class="bubble" x="358" y="1530" width="204" height="76" rx="38"/>
    <text x="270" y="1568">Recents</text><text x="460" y="1568">Favourites</text><text x="697" y="1568">Create with AI</text>`
    ),
    full: lensGuides([[72, 73, 52, 'close']])
};
const SNAP_VIEWS = [
    ['carousel', 'In the carousel'],
    ['full', 'Full screen'],
    ['off', 'None']
];
// px around a device frame, and the strip under it for its size
const DEVICE_PAD = 16;
const DEVICE_LABEL = 24;
const THEME_ICON = { system: 'system', light: 'sun', dark: 'moon' };
const ANCHOR_RE = /^#[A-Za-z0-9._~-]{1,200}$/;
const INSIDE_MAX = 16;
// the header's presence circle: whether an agent session linked to this stage is there to hear comments
const PRESENCE = {
    watching: ['Agent is watching', 'Comments you send to the agent reach its session right away.'],
    open: ['Agent session open, not watching', 'Comments you send to the agent reach it with your next message there.'],
    none: [
        'No agent session',
        'Paste this page’s URL into an agent session to connect it; comments you send to the agent wait until then.'
    ]
};
const SANDBOX =
    'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-pointer-lock';
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
    back: 'M15 18l-6-6 6-6',
    external: 'M14 4h6v6|M20 4l-9 9|M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
    comment: 'M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z',
    panel: 'M4 5h16v14H4z|M15 5v14',
    stats: 'M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2',
    inspect:
        'M10 9.5 8 12l2 2.5|m14 9.5 2 2.5-2 2.5|M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',

    // the scene tools of a live app
    play: 'M6 4v16l14-8z',
    pause: 'M7 4v16M17 4v16',
    step: 'M5 4v16l10-8z|M19 4v16',
    focus: 'M3 7V5a2 2 0 0 1 2-2h2|M17 3h2a2 2 0 0 1 2 2v2|M21 17v2a2 2 0 0 1-2 2h-2|M7 21H5a2 2 0 0 1-2-2v-2|M9 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
    view: 'M4 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z|M16 13l5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5',
    translate: 'M12 2v20M2 12h20m-7 7-3 3-3-3m10-10 3 3-3 3M9 5l3-3 3 3M5 15l-3-3 3-3',
    rotate: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8|M21 3v5h-5',
    scale: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
    world: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20|M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20',
    local: 'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z|m3.3 7 8.7 5 8.7-5M12 22V12',
    snap: 'm6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15|m5 8 4 4m3 3 4 4',
    grid: 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z|M3 9h18|M3 15h18|M9 3v18|M15 3v18',
    ui: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z|M2 8h20|M6 4v4|M10 4v4',
    undo: 'M9 14 4 9l5-5|M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
    redo: 'm15 14 5-5-5-5|M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
    apply: 'M18 6 7 17l-5-5|m22 10-7.5 7.5L13 16',
    sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z|M12 2.5v2|M12 19.5v2|M5.3 5.3l1.4 1.4|M17.3 17.3l1.4 1.4|M2.5 12h2|M19.5 12h2|M5.3 18.7l1.4-1.4|M17.3 6.7l1.4-1.4',
    moon: 'M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5z',
    system: 'M4 5h16v11H4z|M9 20h6|M12 16v4',
    trash: 'M4 7h16|M10 11v6|M14 11v6|M6 7l1 13h10l1-13|M9 7V4h6v3',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    close: 'M6 6l12 12|M18 6L6 18',
    reopen: 'M4 12a8 8 0 1 0 2.4-5.7L4 8.5|M4 4v4.5h4.5',
    reply: 'M9 14l-5-5 5-5|M4 9h10a6 6 0 0 1 6 6v4',
    image: 'M16 5h6|M19 2v6|M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5|m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21|M7 9a2 2 0 1 0 4 0 2 2 0 1 0-4 0',
    agent: 'M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z|M18.5 16v4|M16.5 18h4',
    logo: 'M7.55 3L16.45 8.09L7.55 13.18L7.55 10.7L12.12 8.09L7.55 5.47z|M16.45 10.82L16.45 13.3L11.88 15.91L16.45 18.53L16.45 21L7.55 15.91z'
};

// the scene tools' buttons in their groups, by the ids the frame reports; a toggle's icons are [off, on]
const TOOL_GROUPS = [
    ['play', 'step'],
    ['focus', 'view'],
    ['translate', 'rotate', 'scale'],
    ['space', 'snap', 'grid', 'ui'],
    ['undo', 'redo'],
    ['discard', 'send']
];
const TOOL_ICONS = { play: ['play'], space: ['world', 'local'], send: ['apply'], discard: ['trash'] };
const TIP_MAX = 300;

// the frame's play and step keys (Unity's), passed on when the viewer has the keyboard
const MAC = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? '');

const root = document.documentElement;
const theme = () => {
    const t = localStorage.getItem(THEME_KEY);
    return THEMES.includes(t) ? t : 'system';
};
const applyTheme = (t) => (t === 'system' ? delete root.dataset.theme : (root.dataset.theme = t));
applyTheme(theme());

const h = (tag, props = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) {
            continue;
        }
        if (k === 'class') {
            el.className = v;
        } else if (k.startsWith('on')) {
            el.addEventListener(k.slice(2), v);
        } else if (k === 'value' || k === 'checked' || k === 'disabled') {
            el[k] = v;
        } else {
            el.setAttribute(k, v === true ? '' : String(v));
        }
    }
    el.append(...kids.flat(9).filter((x) => x != null && x !== false));
    return el;
};

const icon = (name) => {
    const s = document.createElementNS(SVG_NS, 'svg');

    // the playcanvas mark is filled; every other icon is a stroke
    const paint =
        name === 'logo'
            ? { fill: 'currentColor' }
            : {
                  fill: 'none',
                  stroke: 'currentColor',
                  'stroke-width': 1.75,
                  'stroke-linecap': 'round',
                  'stroke-linejoin': 'round'
              };
    for (const [k, v] of Object.entries({
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        ...paint,
        'aria-hidden': 'true'
    })) {
        s.setAttribute(k, v);
    }
    for (const d of ICONS[name].split('|')) {
        const p = document.createElementNS(SVG_NS, 'path');
        p.setAttribute('d', d);
        s.append(p);
    }
    return s;
};

const ago = (iso) => {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (!Number.isFinite(s)) {
        return '';
    }
    if (s < 45) {
        return 'just now';
    }
    if (s < 3600) {
        return `${Math.max(1, Math.round(s / 60))}m ago`;
    }
    if (s < 86400) {
        return `${Math.round(s / 3600)}h ago`;
    }
    if (s < 7 * 86400) {
        return `${Math.round(s / 86400)}d ago`;
    }
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric'
    });
};
const time = (iso) => h('time', { datetime: iso, title: new Date(iso).toLocaleString(), 'data-ago': true }, ago(iso));
setInterval(() => document.querySelectorAll('time[data-ago]').forEach((t) => (t.textContent = ago(t.dateTime))), 30000);

const tryCatch = (p) =>
    p.then(
        (r) => [null, r],
        (e) => [e]
    );
const api = async (path, method = 'GET', body) => {
    const r = await fetch(path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body && JSON.stringify(body)
    });
    if (!r.ok) {
        throw new Error((await r.text()) || `${r.status} ${r.statusText}`);
    }
    return r.json();
};

// an image file as a webp (jpeg where the browser can't encode webp) data: url, scaled and compressed under the daemon's cap
const fit = async (file) => {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, ATTACH_EDGE / Math.max(bmp.width, bmp.height));
    const c = h('canvas', { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    for (const q of [0.92, 0.8, 0.65, 0.5]) {
        const webp = c.toDataURL('image/webp', q);
        const url = webp.startsWith('data:image/webp') ? webp : c.toDataURL('image/jpeg', q);
        if (url.length <= IMAGE_MAX_CHARS) {
            return url;
        }
    }
    throw new Error('too large');
};

const toast = (msg, kind) => {
    const t = h('div', { class: `toast${kind ? ` ${kind}` : ''}`, role: 'status' }, msg);
    document.getElementById('toasts').append(t);
    setTimeout(() => t.classList.add('out'), 2800);
    setTimeout(() => t.remove(), 3200);
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const debounce = (fn, ms) => {
    let t;
    return () => (clearTimeout(t), (t = setTimeout(fn, ms)));
};

const themePicker = (onChange) => {
    const wrap = h('div', { class: 'seg', role: 'group', 'aria-label': 'Theme' });
    const render = () =>
        wrap.replaceChildren(
            ...THEMES.map((t) =>
                h(
                    'button',
                    {
                        type: 'button',
                        class: 'seg-btn',
                        title: `${t[0].toUpperCase()}${t.slice(1)} theme`,
                        'aria-label': `${t} theme`,
                        'aria-pressed': String(theme() === t),
                        onclick: () => {
                            localStorage.setItem(THEME_KEY, t);
                            applyTheme(t);
                            render();
                            onChange?.(t);
                        }
                    },
                    icon(THEME_ICON[t])
                )
            )
        );
    render();
    return wrap;
};

const notice = (title, text, link) =>
    h(
        'div',
        { class: 'notice' },
        h('h2', {}, title),
        text && h('p', {}, text),
        link && h('a', { class: 'btn', href: '/stages' }, 'All stages')
    );

// gallery

const gallery = () => {
    document.title = 'PlayCanvas Stage';
    const grid = h('div', { class: 'grid' });
    const count = h('span', { class: 'count' });
    let confirming = null;
    let list = [];

    const card = (a) => {
        const del = () => {
            confirming = a.id;
            render();
            document.querySelector(`[data-id="${a.id}"] .btn.danger`)?.focus();
        };
        const remove = async () => {
            const [e] = await tryCatch(api(`/api/s/${a.id}`, 'DELETE'));
            if (e) {
                return toast(`Couldn’t delete: ${e.message}`, 'error');
            }
            confirming = null;
            list = list.filter((x) => x.id !== a.id);
            render();
            toast('Stage deleted');
        };
        const meta = [h('span', {}, 'Updated ', time(a.updatedAt)), h('span', {}, `v${a.seq}`)];
        if (a.openThreads) {
            meta.push(h('span', { class: 'open-count' }, icon('comment'), plural(a.openThreads, 'open comment')));
        }
        return h(
            'article',
            { class: `card${confirming === a.id ? ' confirming' : ''}`, 'data-id': a.id },
            h('div', { class: 'card-top' }, h('span', { class: 'glyph' }, a.icon || 'page')),
            h(
                'h2',
                { class: 'card-title' },
                h('a', { class: 'stretch', href: `/stage/${a.id}` }, a.title || 'Untitled')
            ),
            a.description
                ? h('p', { class: 'card-desc' }, a.description)
                : h('p', { class: 'card-desc faint' }, 'No description'),
            confirming === a.id
                ? h(
                      'div',
                      { class: 'card-foot confirm' },
                      h('span', {}, 'Delete this stage? This can’t be undone.'),
                      h(
                          'span',
                          { class: 'row' },
                          h(
                              'button',
                              { type: 'button', class: 'btn ghost', onclick: () => ((confirming = null), render()) },
                              'Cancel'
                          ),
                          h('button', { type: 'button', class: 'btn danger', onclick: remove }, 'Delete')
                      )
                  )
                : h(
                      'div',
                      { class: 'card-foot' },
                      h('span', { class: 'meta' }, meta),
                      h(
                          'button',
                          {
                              type: 'button',
                              class: 'iconbtn del',
                              title: 'Delete stage',
                              'aria-label': `Delete ${a.title}`,
                              onclick: del
                          },
                          icon('trash')
                      )
                  )
        );
    };

    const render = () => {
        count.textContent = list.length ? String(list.length) : '';
        grid.replaceChildren(
            ...(list.length ? list.map(card) : [notice('No stages yet.', 'Publish one with the Stage tool.')])
        );
        grid.classList.toggle('empty', !list.length);
    };

    const load = async () => {
        const [e, r] = await tryCatch(api('/api/stages'));
        if (e) {
            return grid.replaceChildren(notice('Couldn’t load stages', e.message));
        }
        list = r.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        if (confirming && !list.some((a) => a.id === confirming)) {
            confirming = null;
        }
        render();
    };

    document
        .getElementById('app')
        .replaceChildren(
            h(
                'header',
                { class: 'bar' },
                h('div', { class: 'brand' }, h('span', { class: 'logo' }, icon('logo')), h('h1', {}, 'Stage'), count),
                h('div', { class: 'spacer' }),
                themePicker()
            ),
            h('main', { class: 'gallery' }, grid)
        );
    load();
    const refresh = debounce(load, 150);
    const es = new EventSource('/api/events');
    for (const ev of ['version', 'comments', 'deleted']) {
        es.addEventListener(ev, refresh);
    }
};

// viewer

const str = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : undefined);
const cleanAnchor = (a) => {
    if (!a || typeof a !== 'object') {
        return undefined;
    }
    const out = { path: str(a.path, 1024), label: str(a.label, 128), snippet: str(a.snippet, 200) };
    const quote = str(a.span && a.span.quote, 512);
    if (quote) {
        out.span = { quote };
    }
    const g = a.region;
    const unit = (v) => typeof v === 'number' && v >= 0 && v <= 1;
    if (!quote && g && [g.x0, g.y0, g.x1, g.y1].every(unit) && g.x0 < g.x1 && g.y0 < g.y1) {
        out.region = { x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1 };
        const inside = Array.isArray(a.inside)
            ? a.inside
                  .map((v) => str(v, 200))
                  .filter(Boolean)
                  .slice(0, INSIDE_MAX)
            : [];
        if (inside.length) {
            out.inside = inside;
        }
    }
    if (a.at && unit(a.at.x) && unit(a.at.y)) {
        out.at = { x: a.at.x, y: a.at.y };
    }
    if (
        typeof a.image === 'string' &&
        a.image.length <= IMAGE_MAX_CHARS &&
        /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(a.image)
    ) {
        out.image = a.image;
    }
    return JSON.parse(JSON.stringify(out));
};

// more anchors Shift+clicked into one comment, each cleaned like the first
const ALSO_MAX = 8;
const cleanAlso = (v) =>
    (Array.isArray(v) ? v.slice(0, ALSO_MAX) : [])
        .map((x) => cleanAnchor(x))
        .filter((x) => x?.path)
        .map(({ path, label, snippet, image }) => JSON.parse(JSON.stringify({ path, label, snippet, image })));

// the page reports where a draft's box goes, in its own viewport px
const validAt = (a) =>
    a && Number.isFinite(a.x) && Number.isFinite(a.y) ? { x: a.x, y: a.y, shown: a.shown === true } : null;

const viewer = async (id) => {
    const app = document.getElementById('app');
    const [err, meta] = await tryCatch(api(`/api/s/${id}`));
    if (err) {
        return app.replaceChildren(notice('Stage not found', 'It may have been deleted.', true));
    }
    const devKey = `${DEVICE_KEY}:${id}`;
    const [dev, orient, zoom, guides] = (localStorage.getItem(devKey) ?? '').split(':');

    const S = {
        meta,
        view: null,
        loaded: null,
        latest: meta.ver,
        saving: new Set(),
        threads: [],
        mode: false,
        playing: false,
        panel: localStorage.getItem(PANEL_KEY),
        draft: null,
        draftText: '',
        draftAt: null,
        replies: new Map(),
        draftImages: [],
        replyImages: new Map(),
        active: null,
        confirm: null,
        showResolved: false,
        send: localStorage.getItem(SEND_KEY) !== '0',
        device: DEVICES.some((d) => d.id === dev) ? dev : 'responsive',
        land: orient === 'land',
        fit: zoom === 'fit',
        guides: SNAP_VIEWS.some(([v]) => v === guides) ? guides : 'carousel',

        // where the frame sits in its wrap and its scale, to place the comment box over it
        at: { x: 0, y: 0, s: 1 },
        gone: false
    };
    const hash = ANCHOR_RE.test(location.hash) ? location.hash : '';
    const shown = () => S.view ?? S.meta.ver;
    const seqOf = (ver) => S.meta.versions.find((v) => v.ver === ver)?.seq;

    const frame = h('iframe', {
        title: meta.title,
        sandbox: SANDBOX,
        allow: 'fullscreen; screen-wake-lock',
        referrerpolicy: 'no-referrer'
    });
    const post = (msg) => !S.gone && frame.contentWindow?.postMessage({ da: 1, ...msg }, S.meta.frameOrigin);

    // header

    const title = h('h1', { class: 'title' });
    const picker = h('select', {
        class: 'version',
        'aria-label': 'Version',
        onchange: (e) => ((S.view = e.target.value === S.meta.ver ? null : e.target.value), loadFrame())
    });
    const modeBtn = h(
        'button',
        {
            type: 'button',
            class: 'iconbtn mode',
            'aria-pressed': 'false',
            'aria-keyshortcuts': 'C',
            'aria-label': 'Comment',
            title: 'Comment: click an element or drag across an area (C)',
            onclick: () => setMode(!S.mode)
        },
        icon('comment')
    );
    const countEl = h('span', { class: 'badge-count' });
    const panelBtn = h(
        'button',
        {
            type: 'button',
            class: 'iconbtn',
            title: 'Comments',
            'aria-label': 'Toggle comments',
            'aria-pressed': 'false',
            onclick: () => setPanel(!S.panel)
        },
        icon('panel'),
        countEl
    );

    // a live app's inspector panel opens beside it, off its canvas: in a blank page on the app's origin, which the
    // panel moves into from the app's frame, so it still reads the app and a device keeps its own size. the frame
    // says when the panel can open and whether it is open; its page loads at the first open
    const inspectFrame = h('iframe', { name: 'stage-inspector', title: 'Inspector', sandbox: SANDBOX });
    const inspectPanel = h('aside', { class: 'inspector', 'aria-label': 'Inspector' }, inspectFrame);
    let inspectLoaded = false;
    const inspectBtn = h(
        'button',
        {
            type: 'button',
            class: 'iconbtn',
            title: "Inspector: the app's entities, components, assets and rendering, read-only",
            'aria-label': 'Inspector',
            'aria-pressed': 'false',
            hidden: true,
            onclick: () => {
                if (inspectLoaded) {
                    return post({ type: 'inspector' });
                }

                // a click while it loads would open the panel over the canvas, with nowhere to move to yet
                if (inspectFrame.src) {
                    return;
                }
                inspectFrame.addEventListener(
                    'load',
                    () => {
                        inspectLoaded = true;
                        post({ type: 'inspector' });
                    },
                    { once: true }
                );
                inspectFrame.src = `${S.meta.frameOrigin}/_frame/live/inspector.html`;
            }
        },
        icon('inspect')
    );

    // and its engine's mini-stats, drawn over the app's canvas
    const statsBtn = h(
        'button',
        {
            type: 'button',
            class: 'iconbtn',
            title: 'MiniStats: frame time, GPU and CPU timings, draw calls and memory',
            'aria-label': 'MiniStats',
            'aria-pressed': 'false',
            hidden: true,
            onclick: () => post({ type: 'stats' })
        },
        icon('stats')
    );
    const openLink = h(
        'a',
        {
            class: 'iconbtn',
            target: '_blank',
            rel: 'noopener noreferrer',
            title: 'Open in new tab',
            'aria-label': 'Open in new tab'
        },
        icon('external')
    );

    // one menu for the device the page shows at, scaled to fit: which device, its orientation and fit, and for a web lens
    // snapchat's own controls sketched over it; a choice resizes the page in place, without a reload, and the menu stays
    // open for the next
    const choice = (name, value, label, detail) =>
        h(
            'label',
            { class: 'menu-item' },
            h('input', {
                type: 'radio',
                name,
                value: String(value),
                checked: S[name] === value,
                onchange: () => setDevice({ [name]: value })
            }),
            h('span', {}, label),
            detail && h('span', { class: 'menu-detail' }, detail)
        );
    const [orientSet, sizeSet] = [
        h(
            'fieldset',
            {},
            h('legend', {}, 'Orientation'),
            choice('land', false, 'Portrait'),
            choice('land', true, 'Landscape')
        ),

        // actual size shrinks the device only when it does not fit; fit to screen scales it up or down to fill the space
        h(
            'fieldset',
            {},
            h('legend', {}, 'Size'),
            choice('fit', true, 'Fit to screen'),
            choice('fit', false, 'Actual size')
        )
    ];
    const snapSet = h(
        'fieldset',
        {},
        h('legend', {}, 'Overlay'),
        SNAP_VIEWS.map(([v, label]) => choice('guides', v, label))
    );
    const deviceMenu = h(
        'div',
        { id: 'device-menu', class: 'menu', popover: '', role: 'dialog', 'aria-label': 'Device' },
        h(
            'fieldset',
            {},
            h('legend', {}, 'Device'),
            DEVICES.map((d) => choice('device', d.id, d.label, d.w && `${d.w}×${d.h}`))
        ),
        orientSet,
        sizeSet,
        snapSet
    );
    const deviceBtn = h('button', {
        type: 'button',
        class: 'version',
        popovertarget: 'device-menu',
        'aria-haspopup': 'dialog',
        title: 'Device: show the page at a phone or tablet viewport'
    });
    deviceMenu.addEventListener('toggle', (e) => {
        if (e.newState !== 'open') {
            return;
        }
        const r = deviceBtn.getBoundingClientRect();
        Object.assign(deviceMenu.style, { left: `${r.left}px`, top: `${r.bottom + 4}px` });
    });
    const presenceText = h('span', { class: 'sr-only' });
    const presenceEl = h('span', { class: 'presence', role: 'status' }, icon('agent'), presenceText);
    const setPresence = (s) => {
        const [label, detail] = PRESENCE[s] ?? PRESENCE.none;
        presenceEl.dataset.state = PRESENCE[s] ? s : 'none';
        presenceEl.title = `${label}. ${detail}`;
        presenceText.textContent = label;
    };
    setPresence(meta.presence);
    const header = h(
        'header',
        { class: 'bar' },
        h('a', { class: 'iconbtn', href: '/stages', title: 'All stages', 'aria-label': 'All stages' }, icon('back')),
        h('div', { class: 'title-wrap' }, title, picker),
        h('div', { class: 'spacer' }),
        deviceBtn,
        deviceMenu,
        themePicker((t) => post({ type: 'theme', theme: t })),
        modeBtn,
        panelBtn,
        inspectBtn,
        statsBtn,
        openLink,
        presenceEl
    );

    const renderHeader = () => {
        title.textContent = S.meta.title;
        title.title = S.meta.title;
        document.title = S.meta.title;
        frame.title = S.meta.title;
        const vs = [...S.meta.versions].reverse();
        picker.replaceChildren(
            ...vs.map((v) =>
                h(
                    'option',
                    { value: v.ver },
                    [
                        `Version ${v.seq} · ${ago(v.at)}`,
                        v.label && ` — ${v.label}`,
                        v.by === 'page' && ' (saved from the page)',
                        v.ver === S.meta.ver && ' · latest'
                    ]
                        .filter(Boolean)
                        .join('')
                )
            )
        );
        picker.value = shown();
        picker.hidden = !!S.meta.live || (vs.length < 2 && !vs[0]?.label);
        openLink.href = S.meta.live ? liveSrc() : `${S.meta.frameOrigin}/v/${shown()}/`;
    };

    // frame

    const hint = h(
        'div',
        { class: 'mode-hint', hidden: true },
        'Click an element or drag across an area to comment',
        h('kbd', {}, 'C'),
        'or',
        h('kbd', {}, 'Esc'),
        'when done'
    );
    // a new comment is written in a box at its anchor in the page; the sidebar only notes the draft
    const pop = h('section', { class: 'draft-pop', hidden: true, role: 'dialog', 'aria-label': 'New comment' });
    // a live stage's dev server: a banner while it is not answering
    const liveEl = h('div', { class: 'live-state', role: 'status', hidden: true });
    let liveState = 'waiting';
    let problem = null;
    const setLive = (state = liveState) => {
        const l = S.meta.live;
        liveState = state;
        liveEl.hidden = !l || (state === 'attached' && !problem);
        if (!l) {
            return;
        }
        liveEl.dataset.state = state === 'attached' && problem ? 'problem' : state;
        liveEl.textContent =
            state === 'attached'
                ? problem
                : state === 'unreachable'
                  ? `The dev server at ${l.url} stopped answering. Start it again and the app comes back here.`
                  : `Waiting for the dev server at ${l.url}. Start it (the project's dev command) and this view attaches on its own.`;
    };
    const sizeEl = h('div', { class: 'device-size', hidden: true });
    const guidesEl = h('div', { class: 'device-guides', hidden: true, 'aria-hidden': 'true' });
    const frameWrap = h('div', { class: 'frame-wrap' }, frame, guidesEl, hint, pop, liveEl, sizeEl);

    // a live app's scene tools sit in a strip above it, off its canvas: the frame reports their state, and a click
    // goes back to it, with the keyboard, so the app's keys still work after
    const toolBtns = {};
    const toolSel = h('span', { class: 'tools-sel' });
    const toolStatus = h('span', { class: 'tools-status', role: 'status' });
    const toolsBar = h(
        'div',
        { class: 'tools-bar', role: 'toolbar', 'aria-label': 'Scene tools', hidden: true },
        TOOL_GROUPS.map((g, i) => [
            i > 0 && h('span', { class: 'tools-sep' }),
            g.map(
                (id) =>
                    (toolBtns[id] = h(
                        'button',
                        {
                            type: 'button',
                            class: 'iconbtn',
                            'data-id': id,
                            onpointerdown: (e) => e.preventDefault(),
                            onclick: () => {
                                if (toolBtns[id].getAttribute('aria-disabled') === 'true') {
                                    return;
                                }
                                if (id === 'discard') {
                                    return askDiscard();
                                }
                                post({ type: 'tool', id });
                                frame.focus();
                            }
                        },
                        (TOOL_ICONS[id] ?? [id]).map(icon),
                        id === 'send' && h('span', { class: 'tools-count' })
                    ))
            )
        ]),
        toolSel,
        toolStatus
    );
    const text = (v) => (typeof v === 'string' ? v.slice(0, TIP_MAX) : '');

    // Discard asks first: the edits are gone once the page reloads
    const discardTitle = h('span', { class: 'where' });
    const discardText = h('p', { class: 'text' });
    const discardPop = h(
        'section',
        { class: 'draft-pop tools-confirm', role: 'alertdialog', 'aria-label': 'Discard edits', hidden: true },
        h('div', { class: 'thread-head' }, discardTitle),
        discardText,
        h(
            'div',
            { class: 'editor-row' },
            h('button', { type: 'button', class: 'btn ghost', onclick: () => closeDiscard() }, 'Cancel'),
            h('div', { class: 'spacer' }),
            h(
                'button',
                {
                    type: 'button',
                    class: 'btn danger',
                    onclick: () => {
                        closeDiscard();
                        post({ type: 'tool', id: 'discard' });
                    }
                },
                'Discard'
            )
        )
    );
    const closeDiscard = () => {
        discardPop.hidden = true;
        frame.focus();
    };
    const askDiscard = () => {
        const n = Number(toolBtns.send.querySelector('.tools-count').textContent) || 0;
        discardTitle.textContent = `Discard ${n} edit${n === 1 ? '' : 's'}?`;
        discardText.textContent = `${n === 1 ? 'The entity goes' : 'The entities go'} back to where the app placed ${n === 1 ? 'it' : 'them'}, and nothing is sent to the agent.`;
        discardPop.hidden = false;
        const r = toolBtns.discard.getBoundingClientRect();
        const c = frameCol.getBoundingClientRect();
        discardPop.style.left = `${Math.max(8, Math.min(r.left - c.left, c.width - discardPop.offsetWidth - 8))}px`;
        discardPop.style.top = `${r.bottom - c.top + 6}px`;
        discardPop.querySelector('.ghost').focus({ focusVisible: false });
    };
    addEventListener('pointerdown', (e) => {
        if (!discardPop.hidden && !discardPop.contains(e.target) && !toolBtns.discard.contains(e.target)) {
            closeDiscard();
        }
    });
    const renderTools = (st) => {
        const all = st && typeof st === 'object' && st.buttons && typeof st.buttons === 'object' ? st.buttons : null;
        toolsBar.hidden = !all;

        // playing, the viewer around the app dims, as Unity's editor does, and the play button is lit
        const playing = all?.play?.pressed === 'true';
        document.body.classList.toggle('playing', playing);
        if (playing !== S.playing) {
            S.playing = playing;
            setMode(S.mode);
            sendPins();
        }
        if (!all) {
            return;
        }
        for (const [id, el] of Object.entries(toolBtns)) {
            const b = all[id] && typeof all[id] === 'object' ? all[id] : {};
            const off = b.disabled === true;
            el.hidden = b.hidden === true;
            if (b.pressed === 'true' || b.pressed === 'false') {
                el.setAttribute('aria-pressed', b.pressed);
            }
            el.setAttribute('aria-disabled', String(off));
            el.setAttribute('aria-label', text(b.label) || id);
            el.dataset.tip = [text(b.tip), off && text(b.off)].filter(Boolean).join('\n');
            const count = el.querySelector('.tools-count');
            if (count) {
                count.textContent = text(b.count);
            }
        }
        toolSel.textContent = text(st.selection);
        toolSel.title = toolSel.textContent;
        toolStatus.textContent = text(st.status);
    };
    const frameCol = h('div', { class: 'frame-col' }, toolsBar, frameWrap, discardPop);

    // the page asks for full screen; the frame goes with its tools, comment box and hint, so they still work there
    // safari before 16.4 has only the prefixed api, and an iphone has none: the frame then fills the window instead
    const native = () => (document.fullscreenElement ?? document.webkitFullscreenElement) === frameCol;
    const isFull = () => native() || frameCol.classList.contains('filled');
    const fill = (on) => {
        frameCol.classList.toggle('filled', on);
        post({ type: 'fullscreen', on });
    };
    const setFull = async (on) => {
        if (!on) {
            if (native()) {
                return tryCatch(
                    Promise.resolve((document.exitFullscreen ?? document.webkitExitFullscreen).call(document))
                );
            }
            return fill(false);
        }
        const req = frameCol.requestFullscreen ?? frameCol.webkitRequestFullscreen;
        const [e] = req ? await tryCatch(Promise.resolve(req.call(frameCol))) : [true];
        if (e) {
            fill(true);
        }
    };
    for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
        document.addEventListener(ev, () => post({ type: 'fullscreen', on: isFull() }));
    }

    // a live app sits at its own page on the frame origin; its query is the app's, so the theme goes by message only
    const liveSrc = () => {
        const u = new URL(S.meta.live.url);
        return `${S.meta.frameOrigin}${u.pathname}${u.search}${hash || u.hash}`;
    };
    const loadFrame = () => {
        const t = theme();
        S.loaded = shown();
        frame.src = S.meta.live
            ? liveSrc()
            : `${S.meta.frameOrigin}/v/${S.loaded}/${t === 'system' ? '' : `?theme=${t}`}${hash}`;
        renderHeader();
        setLive(S.meta.live?.state);
    };

    const onVersion = async (save) => {
        const own = S.saving.delete(save);
        const [e, m] = await tryCatch(api(`/api/s/${id}`));
        if (e || S.gone || m.ver === S.latest) {
            return;
        }
        S.meta = m;
        S.latest = m.ver;
        const v = m.versions.at(-1);

        // the frame already shows what it just saved
        if (own && S.view === null) {
            S.loaded = m.ver;
            renderHeader();
        } else if (S.view === null) {
            loadFrame();
            toast(
                m.live
                    ? `Attached to ${m.live.url}`
                    : `Updated to version ${v.seq}${v.by === 'page' ? ' (saved from the page)' : ''}`
            );
        } else {
            renderHeader();
            toast(`Version ${v.seq} is available`);
        }
    };

    // comments panel

    const list = h('div', { class: 'threads' });
    const panelCount = h('span', { class: 'count' });

    // a sidebar's left edge drags (or arrow keys step) its width, kept across stages, taken from the frame down to its
    // least; a double-click resets it
    const resizable = (side, key, label) => {
        const setWidth = (w) => {
            if (w == null) {
                side.style.removeProperty('--panel-w');
                localStorage.removeItem(key);
            } else {
                w = Math.round(Math.max(PANEL_MIN, Math.min(side.offsetWidth + frameCol.offsetWidth - FRAME_MIN, w)));
                side.style.setProperty('--panel-w', `${w}px`);
                localStorage.setItem(key, String(w));
            }
            grip.setAttribute('aria-valuenow', String(side.offsetWidth));
        };
        const grip = h('div', {
            class: 'panel-grip',
            role: 'separator',
            tabindex: 0,
            'aria-orientation': 'vertical',
            'aria-label': label,
            'aria-valuemin': PANEL_MIN,
            title: 'Drag to resize, double-click to reset',
            onpointerdown: (e) => {
                if (e.button !== 0) {
                    return;
                }
                e.preventDefault();
                grip.setPointerCapture(e.pointerId);
                document.body.classList.add('resizing');
            },
            onpointermove: (e) =>
                grip.hasPointerCapture(e.pointerId) && setWidth(side.getBoundingClientRect().right - e.clientX),
            onlostpointercapture: () => document.body.classList.remove('resizing'),
            ondblclick: () => setWidth(null),
            onkeydown: (e) => {
                const d = { ArrowLeft: PANEL_STEP, ArrowRight: -PANEL_STEP }[e.key];
                if (d) {
                    e.preventDefault();
                    setWidth(side.offsetWidth + d);
                }
            }
        });
        const w = Number(localStorage.getItem(key));
        if (w) {
            side.style.setProperty('--panel-w', `${w}px`);
            grip.setAttribute('aria-valuenow', String(w));
        }
        side.prepend(grip);
    };
    resizable(inspectPanel, INSPECTOR_W_KEY, 'Resize inspector');
    const panel = h(
        'aside',
        { class: 'panel', 'aria-label': 'Comments' },
        h(
            'div',
            { class: 'panel-head' },
            h('h2', {}, 'Comments'),
            panelCount,
            h('div', { class: 'spacer' }),
            h(
                'button',
                {
                    type: 'button',
                    class: 'iconbtn',
                    title: 'Close',
                    'aria-label': 'Close comments',
                    onclick: () => setPanel(false)
                },
                icon('close')
            )
        ),
        list
    );
    resizable(panel, PANEL_W_KEY, 'Resize comments');

    const sorted = () => [...S.threads].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const numbers = () => new Map(sorted().map((t, i) => [t.id, i + 1]));

    const sendPins = () => {
        const n = numbers();
        post({
            type: 'pins',
            pins:
                S.panel && !S.playing
                    ? S.threads
                          .filter((t) => !t.resolved_at && t.anchor?.path)
                          .map((t) => ({
                              tid: t.id,
                              n: n.get(t.id),
                              path: t.anchor.path,
                              region: t.anchor.region,
                              at: t.anchor.at,
                              snippet: t.anchor.snippet,
                              inside: t.anchor.inside
                          }))
                    : []
        });
    };

    const setPanel = (on) => {
        S.panel = !!on;
        localStorage.setItem(PANEL_KEY, S.panel ? '1' : '0');
        document.body.classList.toggle('panel-open', S.panel);
        panelBtn.setAttribute('aria-pressed', String(S.panel));
        sendPins();
    };

    // comment mode stays on across comments until the toggle, "Done commenting" or Esc turns it off. a live app
    // playing has the input, so comments and their pins wait for a pause
    const setMode = (on) => {
        S.mode = !!on && !S.playing;
        modeBtn.setAttribute('aria-pressed', String(S.mode));
        modeBtn.setAttribute('aria-disabled', String(S.playing));
        modeBtn.setAttribute('aria-label', S.mode ? 'Done commenting' : 'Comment');
        modeBtn.title = S.playing
            ? `Comment: pause the app first (${MAC ? '⌘P' : 'Ctrl+P'})`
            : S.mode
              ? 'Done commenting (C or Esc)'
              : 'Comment: click an element or drag across an area (C)';
        if (!S.mode && S.draft) {
            closeDraft();
        }
        hint.hidden = !S.mode;
        post({ type: 'mode', on: S.mode });
        if (S.mode) {
            setPanel(true);
        }
        renderPanel();
    };

    const focusThread = (t, scroll) => {
        S.active = t.id;
        for (const el of list.querySelectorAll('.thread')) {
            el.classList.toggle('active', el.dataset.tid === t.id);
        }
        if (t.anchor?.path) {
            post({
                type: 'focus',
                path: t.anchor.path,
                scroll,
                region: t.anchor.region,
                snippet: t.anchor.snippet,
                inside: t.anchor.inside,
                also: t.anchor.also
            });
        }
    };

    const act = async (p, ok) => {
        const [e, r] = await tryCatch(p);
        if (e) {
            toast(e.message, 'error');
            return;
        }
        if (ok) {
            toast(ok);
        }
        await loadThreads();
        return r;
    };

    const setSend = (v) => {
        S.send = v;
        localStorage.setItem(SEND_KEY, v ? '1' : '0');
    };

    // a drawn area is tagged, with what it covers in the tag's tooltip
    const areaTag = (a) => [
        a?.region &&
            h(
                'span',
                { class: 'tag', title: a.inside?.join('\n') },
                a.inside?.length ? `Area · ${plural(a.inside.length, 'element')}` : 'Area'
            ),
        a?.also?.length > 0 &&
            h(
                'span',
                { class: 'tag', title: a.also.map((x) => x.label || x.snippet || x.path).join('\n') },
                `+${a.also.length} more`
            )
    ];

    // what a drawn area looked like: a thumbnail, shown larger on hover or focus in one floating preview,
    // since the comment box and the sidebar both clip their contents
    const preview = h('img', { class: 'shot-preview', alt: '', hidden: true });
    document.body.append(preview);
    let owner = null;

    // a rerender (submitting while hovering, a comment update) drops the thumbnail without a mouseleave, so the preview goes with it
    new MutationObserver(() => owner && !owner.isConnected && ((preview.hidden = true), (owner = null))).observe(
        document.body,
        { childList: true, subtree: true }
    );
    const shot = (src, attached) => {
        const show = (e) => {
            const r = e.currentTarget.getBoundingClientRect();
            owner = e.currentTarget;
            preview.src = src;
            preview.hidden = false;
            const [w, hgt] = [preview.offsetWidth, preview.offsetHeight];
            const left =
                r.left - w - DRAFT_GAP > 0
                    ? r.left - w - DRAFT_GAP
                    : Math.min(innerWidth - w - DRAFT_GAP, r.right + DRAFT_GAP);
            Object.assign(preview.style, {
                left: `${Math.max(DRAFT_GAP, left)}px`,
                top: `${Math.max(DRAFT_GAP, Math.min(innerHeight - hgt - DRAFT_GAP, r.top))}px`
            });
        };
        const hide = () => ((preview.hidden = true), (owner = null));
        return h(
            'span',
            {
                class: 'shot',
                tabindex: 0,
                title: attached
                    ? 'An image you attached; the agent gets it'
                    : 'What you saw here; the agent gets this image',
                onmouseenter: show,
                onfocus: show,
                onmouseleave: hide,
                onblur: hide
            },
            h('img', {
                src,
                alt: attached ? 'Attached image' : 'Captured view',
                onload: (e) =>
                    e.target.parentNode.matches(':hover, :focus') && show({ currentTarget: e.target.parentNode })
            })
        );
    };

    // a comment's captures side by side: its anchor's, then one per Shift-picked object that brought one
    const shots = (srcs, attached) =>
        srcs.some(Boolean)
            ? h(
                  'div',
                  { class: 'shots' },
                  srcs.filter(Boolean).map((x) => shot(x, attached))
              )
            : '';

    // pasted, dropped or picked images onto a comment's pending list, re-encoded to fit
    const attach = async (files, urls, redraw) => {
        for (const f of files.filter((x) => x.type.startsWith('image/'))) {
            if (urls.length >= ATTACH_MAX) {
                return toast(`A comment holds at most ${ATTACH_MAX} images`, 'error');
            }
            const [e, url] = await tryCatch(fit(f));
            if (e) {
                toast(`Couldn’t attach ${f.name || 'the image'}`, 'error');
                continue;
            }
            urls.push(url);
            redraw();
        }
    };

    // a comment box's images: pasted into its textarea, dropped onto it or picked with its button, shown until it is sent
    const attachable = (box, ta, urls) => {
        const tray = h('div', { class: 'shots' });
        const redraw = () => {
            tray.hidden = !urls.length;
            tray.replaceChildren(
                ...urls.map((u, i) =>
                    h(
                        'span',
                        { class: 'attachment' },
                        shot(u, true),
                        h(
                            'button',
                            {
                                type: 'button',
                                class: 'unattach',
                                title: 'Remove image',
                                'aria-label': 'Remove image',
                                onclick: () => (urls.splice(i, 1), redraw())
                            },
                            icon('close')
                        )
                    )
                )
            );
        };
        redraw();

        // an image copied with text beside it (a spreadsheet's cells) pastes both
        ta.addEventListener('paste', (e) => {
            const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
            if (!files.length) {
                return;
            }
            if (!e.clipboardData.types.includes('text/plain')) {
                e.preventDefault();
            }
            attach(files, urls, redraw);
        });

        // handlers, not listeners: the draft box outlives its contents
        box.ondragover = (e) => e.dataTransfer.types.includes('Files') && e.preventDefault();
        box.ondrop = (e) => {
            if (!e.dataTransfer.files.length) {
                return;
            }
            e.preventDefault();
            attach([...e.dataTransfer.files], urls, redraw);
        };
        const pick = h('input', {
            type: 'file',
            accept: 'image/*',
            multiple: true,
            hidden: true,
            onchange: (e) => (attach([...e.target.files], urls, redraw), (e.target.value = ''))
        });
        const button = h(
            'button',
            {
                type: 'button',
                class: 'btn ghost attach',
                title: 'Attach images (or paste or drop them)',
                'aria-label': 'Attach images',
                onclick: () => pick.click()
            },
            icon('image')
        );
        return { tray, button: [button, pick] };
    };

    const where = (a) => {
        const bits = [];
        if (a?.span?.quote) {
            bits.push(h('blockquote', { class: 'quote' }, a.span.quote));
        }
        if (a?.snippet) {
            bits.push(h('code', { class: 'snippet', title: a.snippet }, a.snippet));
        }
        return bits;
    };

    // a textarea with a send-to-agent checkbox; keeps its text across re-renders
    const editor = ({ key, placeholder, value, images, onInput, submit, cancel, label }) => {
        const ta = h('textarea', { rows: 3, placeholder, 'data-key': key, value });
        const wrap = h('div', { class: 'editor' });
        const img = attachable(wrap, ta, images);
        const box = h('input', { type: 'checkbox', checked: S.send });
        const go = h('button', { type: 'button', class: 'btn primary' });
        const sync = () => {
            go.replaceChildren(...(box.checked ? [icon('agent'), `${label} & send to the agent`] : [label]));
            go.disabled = !ta.value.trim();
        };
        const run = async () => {
            if (!ta.value.trim() || go.disabled) {
                return;
            }
            go.disabled = true;
            await submit(ta.value, box.checked);
            go.disabled = false;
        };
        ta.addEventListener('input', () => (onInput(ta.value), sync()));
        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                run();
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                cancel();
            }
        });
        box.addEventListener('change', () => (setSend(box.checked), sync()));
        go.addEventListener('click', run);
        sync();
        wrap.append(
            ta,
            img.tray,
            h(
                'div',
                { class: 'editor-row' },
                img.button,
                h('label', { class: 'check' }, box, 'Send to Agent'),
                h('div', { class: 'spacer' }),
                h('button', { type: 'button', class: 'btn ghost', onclick: cancel }, 'Cancel'),
                go
            )
        );
        return wrap;
    };

    const draftNote = () =>
        h(
            'section',
            { class: 'composer', onclick: () => pop.querySelector('textarea')?.focus() },
            h(
                'div',
                { class: 'thread-head' },
                h('span', { class: 'num new' }, '+'),
                h('span', { class: 'where' }, S.draft.label || 'New comment'),
                h('div', { class: 'tags' }, areaTag(S.draft))
            ),
            h('p', { class: 'hint' }, 'Writing a comment in the page…')
        );

    // Enter repeats the last choice between Comment and Send to Agent; Shift+Enter is a new line; the corner grip resizes it
    const renderDraft = () => {
        post({ type: 'draft', open: !!S.draft });
        if (!S.draft) {
            return ((pop.hidden = true), pop.replaceChildren());
        }
        const ta = h('textarea', {
            rows: 3,
            placeholder: 'Leave a comment…',
            'aria-label': 'Comment',
            value: S.draftText
        });
        const plain = h('button', { type: 'button', class: `btn ${S.send ? 'ghost' : 'primary'}` }, 'Comment');
        const send = h(
            'button',
            { type: 'button', class: `btn ${S.send ? 'primary' : 'ghost'}` },
            icon('agent'),
            'Send to Agent'
        );
        const img = attachable(pop, ta, S.draftImages);
        const sync = () => (plain.disabled = send.disabled = !ta.value.trim());
        const run = async (toAgent) => {
            if (!ta.value.trim() || send.disabled) {
                return;
            }
            plain.disabled = send.disabled = true;
            setSend(toAgent);
            const { image, also, ...rest } = S.draft;
            const anchor = { ...rest, ...(also && { also: also.map(({ image: _image, ...x }) => x) }) };
            const body = {
                text: ta.value,
                anchor,
                ver: shown(),
                toAgent,
                image,
                images: S.draftImages,
                also_images: also?.map((x) => x.image ?? null)
            };
            const t = await act(api(`/api/s/${id}/comments`, 'POST', body), toAgent ? 'Sent to Agent' : undefined);
            if (!t) {
                return sync();
            }
            S.active = t.id;
            closeDraft();
        };
        ta.addEventListener('input', () => ((S.draftText = ta.value), sync()));
        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                run(S.send);
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeDraft();
            }
        });
        plain.addEventListener('click', () => run(false));
        send.addEventListener('click', () => run(true));
        pop.replaceChildren(
            h(
                'div',
                { class: 'thread-head' },
                h('span', { class: 'where' }, S.draft.label || 'New comment'),
                areaTag(S.draft)
            ),
            shots([S.draft.image, ...(S.draft.also ?? []).map((x) => x.image)]),
            ta,
            img.tray,
            h(
                'div',
                { class: 'editor-row' },
                h('button', { type: 'button', class: 'btn ghost', onclick: closeDraft }, 'Cancel'),
                img.button,
                h('div', { class: 'spacer' }),
                plain,
                send
            )
        );
        pop.hidden = false;
        placeDraft();
        sync();
        ta.focus();
    };

    // below the anchor point, flipped above it near the bottom, kept inside the page area
    // while the viewer drags the box's corner it only stays inside the page area, instead of snapping to its anchor
    let resizing = false;
    const placeDraft = () => {
        const at = S.draftAt;
        pop.style.visibility = at?.shown ? 'visible' : 'hidden';
        if (!at?.shown) {
            return;
        }
        const [w, hgt] = [frameWrap.clientWidth, frameWrap.clientHeight];
        const [pw, ph] = [pop.offsetWidth, pop.offsetHeight];
        const [ax, ay] = [S.at.x + at.x * S.at.s, S.at.y + at.y * S.at.s];
        const below = ay + DRAFT_GAP;
        const [x, y] = resizing
            ? [pop.offsetLeft, pop.offsetTop]
            : [ax, below + ph > hgt - DRAFT_GAP ? ay - ph - DRAFT_GAP : below];
        pop.style.left = `${Math.max(DRAFT_GAP, Math.min(w - pw - DRAFT_GAP, x))}px`;
        pop.style.top = `${Math.max(DRAFT_GAP, Math.min(hgt - ph - DRAFT_GAP, y))}px`;
    };
    addEventListener('resize', placeDraft);

    // the box grows after it is placed (its capture loads, the viewer resizes it), so re-place it then
    new ResizeObserver(placeDraft).observe(pop);
    pop.addEventListener('pointerdown', () => (resizing = true));
    addEventListener('pointerup', () => (resizing = false));

    // a device's frame is centered in the wrap, above its size, and scaled down when the wrap is smaller
    const fitFrame = () => {
        const d = DEVICES.find((x) => x.id === S.device);
        frameWrap.classList.toggle('device', !!d.w);
        sizeEl.hidden = !d.w;
        if (!d.w) {
            frame.removeAttribute('style');
            guidesEl.hidden = true;
            S.at = { x: 0, y: 0, s: 1 };
            post({ type: 'zoom', s: 1 });
            return placeDraft();
        }
        const [w, hgt] = S.land ? [d.h, d.w] : [d.w, d.h];
        const [aw, ah] = [
            frameWrap.clientWidth - 2 * DEVICE_PAD,
            frameWrap.clientHeight - 2 * DEVICE_PAD - DEVICE_LABEL
        ];
        const s = Math.max(0.1, Math.min(S.fit ? Infinity : 1, aw / w, ah / hgt));
        S.at = { x: (frameWrap.clientWidth - w * s) / 2, y: DEVICE_PAD + Math.max(0, (ah - hgt * s) / 2), s };

        // zoomed, not transformed: chrome loses a webgl canvas's backdrop-filter in a scaled frame. zoom scales the
        // frame's own left and top too, so they are given unzoomed
        Object.assign(frame.style, {
            width: `${w}px`,
            height: `${hgt}px`,
            left: `${S.at.x / s}px`,
            top: `${S.at.y / s}px`,
            zoom: String(s)
        });
        frame.style.setProperty('--s', String(s));
        guidesEl.hidden = !(d.id === 'lens' && !S.land && LENS_GUIDES[S.guides]);
        if (!guidesEl.hidden) {
            guidesEl.innerHTML = LENS_GUIDES[S.guides];
        }
        Object.assign(guidesEl.style, {
            width: frame.style.width,
            height: frame.style.height,
            left: `${S.at.x}px`,
            top: `${S.at.y}px`,
            transform: `scale(${s})`
        });
        post({ type: 'zoom', s });
        sizeEl.style.top = `${S.at.y + hgt * s + 6}px`;
        sizeEl.textContent = `${w} × ${hgt}${s === 1 ? '' : ` · ${Math.round(s * 100)}%`}`;
        placeDraft();
    };
    const setDevice = (patch) => {
        Object.assign(S, patch);
        const d = DEVICES.find((x) => x.id === S.device);
        if (d.portrait) {
            S.land = false;
        }
        const off = S.device === 'responsive';
        if (off) {
            localStorage.removeItem(devKey);
        } else {
            localStorage.setItem(
                devKey,
                `${S.device}:${S.land ? 'land' : 'port'}:${S.fit ? 'fit' : 'actual'}:${S.guides}`
            );
        }
        const [w, hgt] = S.land ? [d.h, d.w] : [d.w, d.h];
        deviceBtn.textContent = d.w ? `${d.label} ${w}×${hgt}` : d.label;
        orientSet.hidden = off || !!d.portrait;
        sizeSet.hidden = off;
        for (const i of deviceMenu.querySelectorAll('input')) {
            i.checked = String(S[i.name]) === i.value;
        }
        snapSet.hidden = S.device !== 'lens';
        fitFrame();
    };
    new ResizeObserver(fitFrame).observe(frameWrap);

    // the device kept from last time names the button and picks the menu's sections
    setDevice({});

    const closeDraft = () => {
        // typing in the box took keyboard focus from the page; hand it back, so its keys (a 3d camera's W/A/S/D) work again
        if (pop.contains(document.activeElement)) {
            frame.focus();
        }
        S.draft = null;
        S.draftText = '';
        S.draftImages = [];
        S.draftAt = null;
        post({ type: 'focus', path: null });
        renderDraft();
        renderPanel();
    };

    // where the agent is on a thread sent to it, as a placeholder reply until it answers: queued for a session,
    // working, or overdue
    const pendingReply = (t) => {
        const s = !t.resolved_at && t.agent?.status;
        if (!s) {
            return null;
        }
        const text =
            s === 'working' ? 'Working on it…' : s === 'queued' ? 'Queued for an agent session' : 'Hasn’t replied yet';
        return h(
            'li',
            { class: 'comment agent pending', role: 'status' },
            h('div', { class: 'comment-meta' }, h('span', { class: 'author' }, 'Agent')),
            h(
                'p',
                { class: 'text' },
                s === 'working' ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : icon('agent'),
                text
            )
        );
    };

    const threadCard = (t, n) => {
        const base = `/api/s/${id}/comments/${t.id}`;
        const lastUser = t.comments.findLast((c) => c.author === 'user');
        const canSend = !t.resolved_at && lastUser && !lastUser.to_agent_at;
        const reply = S.replies.get(t.id);
        const head = h(
            'div',
            { class: 'thread-head' },
            h('span', { class: 'num' }, String(n)),
            h('span', { class: 'where' }, t.anchor?.label || (t.anchor?.path ? 'Element' : 'Page')),
            h(
                'div',
                { class: 'tags' },
                areaTag(t.anchor),
                t.ver && t.ver !== shown() && seqOf(t.ver) && h('span', { class: 'tag' }, `v${seqOf(t.ver)}`),
                t.resolved_at &&
                    h(
                        'span',
                        { class: 'tag' },
                        icon('check'),
                        t.resolved_by === 'agent' ? 'Resolved by Agent' : 'Resolved'
                    )
            )
        );
        const comments = h(
            'ol',
            { class: 'comments' },
            t.comments.map((c) =>
                h(
                    'li',
                    { class: `comment ${c.author}` },
                    h(
                        'div',
                        { class: 'comment-meta' },
                        h('span', { class: 'author' }, c.author === 'agent' ? 'Agent' : 'You'),
                        time(c.created_at),
                        c.to_agent_at && h('span', { class: 'sent' }, icon('agent'), 'Sent to Agent')
                    ),
                    h('p', { class: 'text' }, c.text),
                    c.images &&
                        shots(
                            c.images.map((_, k) => `/api/s/${id}/comments/${t.id}/attachment/${c.id}/${k}`),
                            true
                        )
                )
            ),
            pendingReply(t)
        );
        const actions =
            S.confirm === t.id
                ? h(
                      'div',
                      { class: 'actions confirm' },
                      h('span', {}, 'Delete this thread?'),
                      h('div', { class: 'spacer' }),
                      h(
                          'button',
                          { type: 'button', class: 'btn ghost sm', onclick: () => ((S.confirm = null), renderPanel()) },
                          'Cancel'
                      ),
                      h(
                          'button',
                          {
                              type: 'button',
                              class: 'btn danger sm',
                              onclick: () => ((S.confirm = null), act(api(base, 'DELETE'), 'Thread deleted'))
                          },
                          'Delete'
                      )
                  )
                : h(
                      'div',
                      { class: 'actions' },
                      !t.resolved_at &&
                          h(
                              'button',
                              {
                                  type: 'button',
                                  class: 'act',
                                  onclick: () => (
                                      S.replies.set(t.id, reply ?? ''),
                                      renderPanel(),
                                      list.querySelector(`[data-key="r:${t.id}"]`)?.focus()
                                  )
                              },
                              icon('reply'),
                              'Reply'
                          ),
                      canSend &&
                          h(
                              'button',
                              {
                                  type: 'button',
                                  class: 'act agent',
                                  onclick: () => act(api(`${base}/send`, 'POST'), 'Sent to Agent')
                              },
                              icon('agent'),
                              'Send to Agent'
                          ),
                      h(
                          'button',
                          {
                              type: 'button',
                              class: 'act',
                              onclick: () => act(api(`${base}/resolve`, 'POST', { resolved: !t.resolved_at }))
                          },
                          icon(t.resolved_at ? 'reopen' : 'check'),
                          t.resolved_at ? 'Reopen' : 'Resolve'
                      ),
                      h('div', { class: 'spacer' }),
                      h(
                          'button',
                          {
                              type: 'button',
                              class: 'act danger',
                              title: 'Delete thread',
                              'aria-label': 'Delete thread',
                              onclick: () => ((S.confirm = t.id), renderPanel())
                          },
                          icon('trash')
                      )
                  );
        if (reply !== undefined && !S.replyImages.has(t.id)) {
            S.replyImages.set(t.id, []);
        }
        const drop = () => (S.replies.delete(t.id), S.replyImages.delete(t.id), renderPanel());
        const replyBox =
            reply !== undefined &&
            !t.resolved_at &&
            editor({
                key: `r:${t.id}`,
                label: 'Reply',
                placeholder: 'Reply…',
                value: reply,
                images: S.replyImages.get(t.id),
                onInput: (v) => S.replies.set(t.id, v),
                cancel: drop,
                submit: async (text, toAgent) => {
                    const images = S.replyImages.get(t.id);
                    const r = await act(
                        api(base, 'POST', { text, toAgent, images }),
                        toAgent ? 'Sent to Agent' : undefined
                    );
                    if (r) {
                        drop();
                    }
                }
            });
        return h(
            'article',
            {
                class: `thread${S.active === t.id ? ' active' : ''}${t.resolved_at ? ' resolved' : ''}`,
                'data-tid': t.id,
                onclick: (e) => !e.target.closest('button, textarea, input, label, a') && focusThread(t, true)
            },
            head,
            where(t.anchor),
            shots([
                t.anchor?.image && `/api/s/${id}/comments/${t.id}/image`,
                ...(t.anchor?.also ?? []).map((x, i) => x.image && `/api/s/${id}/comments/${t.id}/image/${i + 1}`)
            ]),
            comments,
            actions,
            replyBox
        );
    };

    const renderPanel = () => {
        // keep focus and caret in whichever editor the user is typing in
        const f = document.activeElement;
        const key = f?.dataset?.key;
        const sel = key && [f.selectionStart, f.selectionEnd];
        const n = numbers();
        const open = sorted().filter((t) => !t.resolved_at);
        const done = sorted().filter((t) => t.resolved_at);
        const kids = [];
        if (S.draft) {
            kids.push(draftNote());
        }
        if (S.mode && !S.draft) {
            kids.push(
                h(
                    'p',
                    { class: 'hint' },
                    'Click any element in the page, or drag across an area of it, to anchor a comment there.'
                )
            );
        }
        kids.push(...open.map((t) => threadCard(t, n.get(t.id))));
        if (!open.length && !S.draft && !S.mode) {
            kids.push(
                h(
                    'div',
                    { class: 'empty' },
                    h('p', {}, 'No open comments.'),
                    h(
                        'button',
                        { type: 'button', class: 'btn', onclick: () => setMode(true) },
                        icon('comment'),
                        'Comment on the page'
                    )
                )
            );
        }
        if (done.length) {
            const d = h(
                'details',
                { class: 'resolved-group', ontoggle: () => (S.showResolved = d.open) },
                h('summary', {}, `Resolved (${done.length})`),
                done.map((t) => threadCard(t, n.get(t.id)))
            );
            d.open = S.showResolved;
            kids.push(d);
        }
        list.replaceChildren(...kids);
        panelCount.textContent = open.length ? String(open.length) : '';
        countEl.textContent = open.length ? String(open.length) : '';
        if (key) {
            const el = list.querySelector(`[data-key="${CSS.escape(key)}"]`);
            if (el) {
                el.focus();
                el.setSelectionRange(...sel);
            }
        }
    };

    const loadThreads = async () => {
        const [e, r] = await tryCatch(api(`/api/s/${id}/comments`));
        if (e || S.gone) {
            return;
        }
        S.threads = r.threads;

        // "working" lapses to "waiting" at its deadline with no event, so reload then
        clearTimeout(S.statusTimer);
        const next = Math.min(...r.threads.map((t) => Date.parse(t.agent?.until ?? '')).filter(Number.isFinite));
        if (Number.isFinite(next)) {
            S.statusTimer = setTimeout(loadThreads, next - Date.now() + STATUS_SLACK_MS);
        }
        if (S.panel === null) {
            setPanel(r.threads.some((t) => !t.resolved_at) && innerWidth > 760);
        }
        renderPanel();
        sendPins();
    };

    // frame messages: only from this stage's origin and this frame

    addEventListener('message', (e) => {
        if (e.origin !== S.meta.frameOrigin || e.source !== frame.contentWindow) {
            return;
        }
        const m = e.data;
        if (!m || m.da !== 1 || typeof m.type !== 'string') {
            return;
        }
        if (m.type === 'ready') {
            problem = null;
            inspectBtn.hidden = statsBtn.hidden = true;
            document.body.classList.remove('inspecting');
            renderTools(null);
            post({ type: 'theme', theme: theme() });
            post({ type: 'mode', on: S.mode });
            post({ type: 'fullscreen', on: isFull() });
            post({ type: 'zoom', s: S.at?.s ?? 1 });
            sendPins();
        } else if (m.type === 'anchor') {
            const a = cleanAnchor(m.anchor);
            if (!a?.path) {
                return;
            }
            const also = cleanAlso(m.also);
            if (also.length) {
                a.also = also;
            }
            S.draft = a;
            S.draftAt = validAt(m.at) ?? S.draftAt;
            setPanel(true);
            renderPanel();
            renderDraft();
        } else if (m.type === 'at') {
            if (!S.draft) {
                return;
            }
            S.draftAt = validAt(m.at);
            placeDraft();
        } else if (m.type === 'mode') {
            setMode(!!m.on);
        } else if (m.type === 'fullscreen') {
            setFull(m.on === true);
        } else if (m.type === 'tools') {
            renderTools(m.state);
        } else if (m.type === 'inspector') {
            inspectBtn.hidden = m.available !== true;
            inspectBtn.setAttribute('aria-pressed', String(m.open === true));
            document.body.classList.toggle('inspecting', m.open === true);
        } else if (m.type === 'stats') {
            statsBtn.hidden = m.available !== true;
            statsBtn.setAttribute('aria-pressed', String(m.open === true));
        } else if (m.type === 'dismiss') {
            dismiss();
        } else if (m.type === 'pin') {
            const t = S.threads.find((x) => x.id === m.tid);
            if (!t) {
                return;
            }
            setPanel(true);
            focusThread(t, false);
            list.querySelector(`[data-tid="${t.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } else if (m.type === 'version') {
            onVersion();
        } else if (m.type === 'saving' && typeof m.save === 'string') {
            S.saving.add(m.save);
        } else if (m.type === 'live') {
            problem = typeof m.problem === 'string' ? m.problem.slice(0, 1000) : null;
            setLive();
        }
    });

    // esc closes the draft first, then leaves comment mode; C toggles it when not typing (the page sends its own)
    const dismiss = () => (!discardPop.hidden ? closeDiscard() : S.draft ? closeDraft() : S.mode && setMode(false));
    addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            return dismiss();
        }
        if (e.code === 'KeyP' && (MAC ? e.metaKey : e.ctrlKey) && !e.shiftKey && !toolsBar.hidden) {
            e.preventDefault();
            post({ type: 'tool', id: e.altKey ? 'step' : 'play' });
            return frame.focus();
        }
        if (
            e.key.toLowerCase() === 'c' &&
            !e.repeat &&
            !e.metaKey &&
            !e.ctrlKey &&
            !e.altKey &&
            !e.target.closest?.('input, textarea, select, [contenteditable]')
        ) {
            setMode(!S.mode);
        }
    });

    const es = new EventSource(`/api/events/${id}`);
    es.addEventListener('version', (e) => onVersion(JSON.parse(e.data).save));
    es.addEventListener('comments', debounce(loadThreads, 100));
    es.addEventListener('presence', (e) => setPresence(JSON.parse(e.data).state));
    es.addEventListener('live', (e) => setLive(JSON.parse(e.data).state));

    // a restarted daemon knows no sessions yet and sends no change, so reread on every (re)connect
    es.addEventListener('open', async () => {
        const [e, m] = await tryCatch(api(`/api/s/${id}`));
        if (e) {
            return;
        }
        setPresence(m.presence);
        setLive(m.live?.state);
    });
    es.addEventListener('deleted', () => {
        S.gone = true;
        es.close();
        document.title = 'Stage deleted';
        document.body.classList.remove('viewer', 'panel-open', 'inspecting');
        app.replaceChildren(notice('This stage was deleted', null, true));
    });

    document.body.classList.add('viewer');
    app.replaceChildren(header, h('main', { class: 'stage' }, frameCol, inspectPanel, panel));
    if (S.panel !== null) {
        setPanel(S.panel === '1');
    }
    loadFrame();
    renderPanel();
    loadThreads();
};

// hover tooltips for every titled control: some browsers show a title late or not at all. a title moves to
// data-tip on hover, so code that sets a title later still shows it
const TIP_DELAY = 300;
const TIP_GAP = 6;
const tips = () => {
    const tip = h('div', { class: 'tip', role: 'tooltip', hidden: true });
    document.body.append(tip);
    let timer = 0;
    let on = null;
    const take = (el) => {
        if (!el.title) {
            return;
        }
        el.dataset.tip = el.title;
        el.removeAttribute('title');
    };
    const hide = () => {
        clearTimeout(timer);
        tip.hidden = true;
        on = null;
    };
    const show = (el) => {
        take(el);
        if (!el.dataset.tip || !el.isConnected) {
            return;
        }
        tip.textContent = el.dataset.tip;
        tip.hidden = false;
        const r = el.getBoundingClientRect();
        const [w, ht] = [tip.offsetWidth, tip.offsetHeight];
        const below = r.bottom + TIP_GAP + ht <= innerHeight;
        tip.style.left = `${Math.max(TIP_GAP, Math.min(innerWidth - w - TIP_GAP, r.left + r.width / 2 - w / 2))}px`;
        tip.style.top = `${below ? r.bottom + TIP_GAP : r.top - TIP_GAP - ht}px`;
    };
    const target = (e) => e.target.closest?.('button[title], a[title], [data-tip]');
    addEventListener('pointerover', (e) => {
        const el = target(e);
        if (el === on) {
            return;
        }
        hide();
        if (!el) {
            return;
        }
        on = el;
        take(el);
        timer = setTimeout(() => show(el), TIP_DELAY);
    });
    addEventListener('pointerdown', hide, true);
    addEventListener('scroll', hide, true);
    addEventListener('focusin', (e) => {
        const el = target(e);
        if (el?.matches(':focus-visible')) {
            show(el);
        }
    });
    addEventListener('focusout', hide);
};

const boot = () => {
    tips();
    const m = location.pathname.match(/^\/stage\/([0-9a-f-]{36})\/?$/);
    if (m) {
        viewer(m[1]);
    } else {
        gallery();
    }
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}
