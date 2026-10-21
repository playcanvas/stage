// frame runtime: first script of every stage page on http://<uuid>.localhost:<port>.
// theme, diagnostics, window.agent capabilities, live updates, comment mode. never throws into the page.
(() => {
    const boot = () => {
        const MAX_ENTRIES = 200;
        const MAX_TEXT = 2000;
        const FLUSH_MS = 500;
        const KEEPALIVE_BYTES = 60000;
        const QUOTE_BYTES = 512;
        const DRAG_SLOP = 4;
        // a press that draws less than this, either way, is a wobbly click, not an area
        const AREA_MIN = 12;
        // a drawn area quotes at most this many covered elements, scanning at most SCAN_MAX
        const INSIDE_MAX = 16;

        // a comment holds at most this many more anchors, added with Shift+click
        const ALSO_MAX = 8;

        // a drawn area's capture from a page picker, as a data: url; the daemon caps the decoded bytes at 1 MB
        const IMAGE_MAX_CHARS = 1400000;
        const IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,/;
        const SCAN_MAX = 4096;
        const ACCENT = '#ff6600';
        // the daemon's DB_QUERY_MAX
        const ORDERED_LIMIT = 1000;

        const script = document.currentScript;
        const ds = (script && script.dataset) || {};
        let ver = ds.ver || '';
        const shell = ds.shell || '';
        const caps = (ds.caps || '').split(',').filter(Boolean);
        const root = document.documentElement;
        const framed = window.parent !== window;

        // the page may replace these later; keep the originals
        const fetch_ = window.fetch.bind(window);
        const ES = window.EventSource;
        const stringify = JSON.stringify;
        const con = {};
        for (const k of ['log', 'info', 'warn', 'error']) {
            con[k] = console[k];
        }

        const guard =
            (fn) =>
            (...a) => {
                try {
                    return fn(...a);
                } catch {}
            };

        const fire = (el, name, init) => el.dispatchEvent(new CustomEvent(`agent:${name}`, init));
        const hear = (el, name, fn) => el.addEventListener(`agent:${name}`, fn);

        const toParent = (msg) => {
            if (framed && shell) {
                guard(() => window.parent.postMessage({ da: 1, ...msg }, shell))();
            }
        };

        // theme

        const setTheme = (t) => {
            if (t === 'dark' || t === 'light') {
                root.dataset.theme = t;
            } else {
                delete root.dataset.theme;
            }
        };
        guard(() => {
            const q = new URLSearchParams(location.search);
            if (!q.has('theme')) {
                return;
            }
            setTheme(q.get('theme'));
            q.delete('theme');
            const s = q.toString();
            history.replaceState(history.state, '', location.pathname + (s ? `?${s}` : '') + location.hash);
        })();

        // fullscreen: a page asks with an `agent:fullscreen` event, detail { on }. the shell takes the whole frame full screen,
        // so its comment box stays visible; a page opened on its own takes its root. `data-fullscreen` on the root and a
        // `agent:fullscreen-change` event, detail { on }, report the state

        const setFull = (on) => {
            if (on) {
                root.dataset.fullscreen = '';
            } else {
                delete root.dataset.fullscreen;
            }
            guard(() => fire(document, 'fullscreen-change', { detail: { on } }))();
        };
        hear(
            document,
            'fullscreen',
            guard((e) => {
                const on = e.detail?.on === true;
                if (framed) {
                    return toParent({ type: 'fullscreen', on });
                }

                // safari before 16.4 has only the prefixed api, and an iphone has none: the page then just fills the window
                const req = root.requestFullscreen ?? root.webkitRequestFullscreen;
                const exit = document.exitFullscreen ?? document.webkitExitFullscreen;
                if (on && req) {
                    Promise.resolve(req.call(root)).catch(() => setFull(true));
                } else if (on) {
                    setFull(true);
                } else if (document.fullscreenElement ?? document.webkitFullscreenElement) {
                    Promise.resolve(exit.call(document)).catch(() => {});
                } else {
                    setFull(false);
                }
            })
        );
        if (!framed) {
            for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
                document.addEventListener(ev, () =>
                    setFull(!!(document.fullscreenElement ?? document.webkitFullscreenElement))
                );
            }
        }

        // diagnostics

        const queue = [];
        let recorded = 0;
        let posted = false;
        let timer;

        const show = (v) => {
            if (typeof v === 'string') {
                return v;
            }
            if (v instanceof Error) {
                return v.stack || `${v.name}: ${v.message}`;
            }
            if (v === undefined || typeof v === 'function' || typeof v === 'symbol') {
                return String(v);
            }
            try {
                return stringify(v) ?? String(v);
            } catch {
                return String(v);
            }
        };

        const post = (entries, keepalive) =>
            fetch_('/_frame/api/diag', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: stringify({ ver, entries }),
                keepalive
            }).catch(() => {});

        const flush = (keepalive) => {
            clearTimeout(timer);
            timer = undefined;
            if (posted && !queue.length) {
                return;
            }
            posted = true;
            let entries = queue.splice(0, 100);
            if (keepalive) {
                // keepalive bodies are capped at 64 KB in flight
                let n = 0;
                entries = entries.filter((e) => (n += stringify(e).length) < KEEPALIVE_BYTES);
            }
            post(entries, keepalive);
            if (queue.length && !keepalive) {
                timer = setTimeout(flush, FLUSH_MS);
            }
        };

        const record = guard((e) => {
            if (recorded >= MAX_ENTRIES) {
                return;
            }
            recorded++;
            queue.push({ ts: new Date().toISOString(), ...e, text: String(e.text).slice(0, MAX_TEXT) });
            if (!timer) {
                timer = setTimeout(flush, FLUSH_MS);
            }
        });

        for (const level of Object.keys(con)) {
            console[level] = function (...a) {
                guard(() => record({ kind: 'console', level, text: a.map(show).join(' ') }))();
                return con[level].apply(this, a);
            };
        }

        addEventListener(
            'error',
            guard((e) => {
                if (e instanceof ErrorEvent) {
                    const stack = e.error && e.error.stack;
                    const text = stack && !stack.includes(e.message) ? `${e.message}\n${stack}` : stack || e.message;
                    return record({
                        kind: 'error',
                        level: 'error',
                        text,
                        source: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined
                    });
                }
                const t = e.target;
                if (!t || t === window || !t.tagName) {
                    return;
                }
                const url = t.currentSrc || t.src || t.href || '';
                record({
                    kind: 'resource',
                    level: 'error',
                    text: `failed to load <${t.localName}> ${url}`,
                    source: url
                });
            }),
            true
        );
        addEventListener(
            'unhandledrejection',
            guard((e) => record({ kind: 'rejection', level: 'error', text: `unhandled rejection: ${show(e.reason)}` }))
        );
        addEventListener(
            'securitypolicyviolation',
            guard((e) =>
                record({
                    kind: 'csp',
                    level: 'error',
                    text: `blocked ${e.blockedURI || '(inline)'} by ${e.violatedDirective}`,
                    source: e.sourceFile ? `${e.sourceFile}:${e.lineNumber}:${e.columnNumber}` : undefined
                })
            ),
            true
        );

        // one post per load, even with no entries, marks "a viewer loaded this version"
        addEventListener('load', () => setTimeout(() => !posted && flush(), 0));
        addEventListener('pagehide', () => flush(true));

        // capabilities

        const fail = (code, message, extra) => Object.assign(new Error(message), { code }, extra);

        const call = async (path, init) => {
            const r = await fetch_(path, init).catch((e) => {
                throw fail('unavailable', String(e && e.message));
            });
            const type = r.headers.get('content-type') || '';
            const b = type.includes('json') ? await r.json() : await r.text();
            if (r.ok) {
                return b;
            }
            const tooLarge = r.status === 413 || (typeof b === 'string' && /too large/i.test(b));
            const code =
                r.status === 409
                    ? 'conflict'
                    : r.status === 403
                      ? 'not_declared'
                      : r.status === 404
                        ? 'not_found'
                        : tooLarge
                          ? 'too_large'
                          : r.status === 400 || r.status === 415
                            ? 'invalid_argument'
                            : 'internal';
            throw fail(
                code,
                typeof b === 'string' ? b : (b.error && b.error.message) || b.error || stringify(b),
                typeof b === 'object' ? { details: b } : {}
            );
        };

        // capability-call failures land in diagnostics and still reject to the caller
        const traced = (label, p) =>
            p.catch((e) => {
                record({
                    kind: 'capability',
                    level: 'error',
                    text: `${label} failed: ${e.code ? `[${e.code}] ` : ''}${e.message}`,
                    source: label.split('.')[0]
                });
                throw e;
            });

        const postJson = (path, data) =>
            call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: stringify(data) });

        const seen = new Map();
        const dbReq = (label, verb, args) =>
            traced(
                label,
                postJson('/_frame/api/db', { verb, args }).then((r) => {
                    if (r && r.error) {
                        throw fail(r.error.code, r.error.message, { current: r.error.current, index: r.index });
                    }
                    return r;
                })
            );

        const split = (path) => {
            const p = String(path);
            const i = p.lastIndexOf('/');
            if (i <= 0 || i === p.length - 1) {
                throw fail('invalid_argument', `"${p}" is not a document path: use "<collection>/<id>"`);
            }
            return [p.slice(0, i), p.slice(i + 1)];
        };

        const docSnap = (path, id, d) => {
            seen.set(path, d ? d.version : 0);
            return {
                id,
                path,
                exists: !!d,
                version: d ? d.version : undefined,
                updatedAt: d && d.updatedAt,
                data: () => (d ? d.data : undefined)
            };
        };

        // one local person: every data/users/<uid> is data/users/me
        const norm = (p) => p.replace(/^data\/users\/u_[A-Za-z0-9_]{22}(?=\/|$)/, 'data/users/me');

        const subs = new Set();
        const subscribe = (key, isDoc, get, cb, onErr) => {
            const s = {
                key: norm(key),
                isDoc,
                run: () =>
                    get().then(
                        (v) => subs.has(s) && guard(cb)(v),
                        (e) => subs.has(s) && onErr && guard(onErr)(e)
                    )
            };
            subs.add(s);
            s.run();
            return () => subs.delete(s);
        };
        const onDb = (paths) => {
            const ps = (paths || []).map(norm);
            for (const s of subs) {
                if (ps.some((p) => (s.isDoc ? p === s.key : p.slice(0, p.lastIndexOf('/')) === s.key))) {
                    s.run();
                }
            }
        };

        const docRef = (path) => {
            const [collection, id] = split(path);
            const get = () =>
                dbReq(`db.doc(${path}).get`, 'get', { collection, doc_id: id }).then((r) =>
                    docSnap(path, id, r.docs[0])
                );
            const write = (op, data) => {
                const args = { collection, doc_id: id };
                if (data !== undefined) {
                    args.data = data;
                }
                if (seen.has(path)) {
                    args.if_version = seen.get(path);
                }
                return dbReq(`db.doc(${path}).${op}`, op, args).then((r) => {
                    seen.set(path, r.version ?? 0);
                    return { path, version: r.version };
                });
            };
            return {
                id,
                path,
                get,
                set: (data) => write('set', data),
                update: (data) => write('update', data),
                delete: () => write('delete'),
                onSnapshot: (cb, onErr) => subscribe(path, true, get, cb, onErr)
            };
        };

        const queryRef = (collection, q) => {
            const get = async () => {
                const docs = [];
                let cursor;
                for (let i = 0; i < 100; i++) {
                    const query = { ...q };
                    if (cursor) {
                        query.cursor = cursor;
                    }
                    // ordered results come back in one page, so ask for the most the daemon allows
                    if (q.order_by && !q.limit) {
                        query.limit = ORDERED_LIMIT;
                    }
                    const r = await dbReq(`db.collection(${collection}).get`, 'query', { collection, query });
                    for (const d of r.docs) {
                        docs.push(docSnap(`${collection}/${d.id}`, d.id, d));
                    }
                    cursor = r.next_cursor;
                    if (!cursor || (q.limit && docs.length >= q.limit)) {
                        break;
                    }
                }
                return { docs, size: docs.length, empty: !docs.length, forEach: (f) => docs.forEach(f) };
            };
            return {
                id: collection.slice(collection.lastIndexOf('/') + 1),
                path: collection,
                doc: (id) => docRef(`${collection}/${id}`),
                where: (field, op, value) =>
                    queryRef(collection, { ...q, where: [...(q.where || []), [field, op, value]] }),
                orderBy: (field, direction = 'asc') => queryRef(collection, { ...q, order_by: { field, direction } }),
                limit: (n) =>
                    queryRef(collection, { ...q, limit: Math.max(1, Math.min(ORDERED_LIMIT, Math.floor(n) || 1)) }),
                get,
                onSnapshot: (cb, onErr) => subscribe(collection, false, get, cb, onErr)
            };
        };

        const toWrite = (w) => {
            const [collection, doc_id] = split(w.path);
            const out = { op: w.op, collection, doc_id };
            if (w.data !== undefined) {
                out.data = w.data;
            }
            if (seen.has(w.path)) {
                out.if_version = seen.get(w.path);
            }
            return out;
        };

        const db = Object.freeze({
            doc: docRef,
            collection: (name) => queryRef(String(name), {}),
            batch: (writes) =>
                Promise.resolve()
                    .then(() => (writes || []).map(toWrite))
                    .then((ws) =>
                        dbReq('db.batch', 'batch', { writes: ws }).then((r) => {
                            (writes || []).forEach((w, i) =>
                                seen.set(w.path, (r.results[i] && r.results[i].version) ?? 0)
                            );
                            return r.results;
                        })
                    )
        });

        const user = Object.freeze({ me: () => traced('user.me', call('/_frame/api/user')) });

        const assets = Object.freeze({
            upload: (file, name) =>
                traced(
                    'assets.upload',
                    call('/_frame/api/assets', {
                        method: 'POST',
                        headers: {
                            'content-type': (file && file.type) || 'application/octet-stream',
                            'x-name': encodeURIComponent(name || (file && file.name) || 'upload')
                        },
                        body: file
                    })
                ),
            list: () => traced('assets.list', call('/_frame/api/assets')),
            url: (id) => `/_blob/${encodeURIComponent(id)}`
        });

        let base = ver;
        const ownSaves = new Set();
        const stage = Object.freeze({
            publish: (html) => {
                const save = Math.random().toString(36).slice(2);
                ownSaves.add(save);
                toParent({ type: 'saving', save });
                return traced(
                    'stage.publish',
                    postJson('/_frame/api/publish', { html: String(html), baseVersion: base, save }).then((r) => {
                        ver = r.ver;
                        base = ver;
                        return { ver: r.ver, seq: r.seq };
                    })
                );
            }
        });

        const CAPS = { db, user, assets, stage };
        const use = (name) =>
            Promise.resolve().then(() => {
                if (caps.includes(name) && CAPS[name]) {
                    return CAPS[name];
                }
                record({
                    kind: 'capability',
                    level: 'warn',
                    text: `agent.use("${String(name)}") resolved null: ${CAPS[name] ? 'the page does not declare it' : 'no such capability'} (declared: ${caps.join(', ') || 'none'})`,
                    source: String(name)
                });
                return null;
            });

        // a page can resolve what is under the cursor inside one element (a 3d canvas) in comment mode:
        // pick(el, fn) with fn(clientX, clientY, { clicks }) -> { rect: {left, top, width, height}, label, snippet, image? } | null | false
        // (image: a data: url of what was clicked, as seen);
        // a hit without `rect` is highlighted by the page itself, so no box is drawn over it; null falls back to
        // the element, and false means nothing there takes a comment (no highlight, a click does nothing). to keep what a
        // comment is on highlighted, the element gets a cancelable `agent:focus` event, detail { snippet, inside }
        // or null to clear; a page that highlights it calls preventDefault(), and no box is drawn. document gets a
        // `agent:comment-mode` event, detail { on }, whenever comment mode turns on or off
        const pickers = new WeakMap();
        const pick = (el, fn) => {
            if (el instanceof Element && typeof fn === 'function') {
                pickers.set(el, fn);
            }
        };

        // and what a drawn area covers inside it: pickRect(el, fn) with fn({left, top, width, height}) in client px
        // -> { label, snippet, inside: [snippet, ...], image?: data: url of the area as drawn } | null, or a promise of it
        const areaPickers = new WeakMap();
        const pickRect = (el, fn) => {
            if (el instanceof Element && typeof fn === 'function') {
                areaPickers.set(el, fn);
            }
        };

        window.agent = Object.freeze({ use, pick, pickRect });

        // dialogs are blocked in the published viewer too; make them deterministic
        guard(() => {
            window.alert = () => {};
            window.confirm = () => false;
            window.prompt = () => null;
            window.print = () => {};
        })();

        // live updates

        guard(() => {
            if (!ES) {
                return;
            }
            const es = new ES('/_frame/events');
            let opened = false;
            es.addEventListener('open', () => {
                // after a reconnect, catch up on anything missed
                if (opened) {
                    for (const s of subs) {
                        s.run();
                    }
                }
                opened = true;
            });
            es.addEventListener(
                'version',
                guard((e) => {
                    const d = JSON.parse(e.data);

                    // a page's own save keeps it running
                    if (ownSaves.delete(d.save)) {
                        ver = d.ver;
                        base = ver;
                    } else if (framed) {
                        toParent({ type: 'version', ver: d.ver });
                    } else if (d.ver && d.ver !== ver) {
                        location.replace(`/v/${d.ver}/${location.hash}`);
                    }
                })
            );
            es.addEventListener(
                'db',
                guard((e) => onDb(JSON.parse(e.data).paths))
            );

            // a live app with no hot reload of its own: a file changed under the project
            es.addEventListener('reload', () => location.reload());
        })();

        // comment mode, focus highlight and pins, drawn in a closed shadow root

        let mode = false;
        let pins = [];
        let focusEl = null;
        let focusTimer;
        let hoverEl = null;
        let hoverRect = null;
        let focusRect = null;
        let focusRegion = null;
        let pageFocus = null;
        let drag = null;
        let swallow = false;
        let hoverSeq = 0;

        // while a comment box is open in the shell, hover highlighting waits until it closes
        let drafting = false;

        // the open comment's anchors, the first one its own; and the page elements outlined besides the focus
        let picked = [];
        let extraEls = [];

        // where the draft's comment box goes: a point as fractions of its anchor element's box, so it follows scroll
        let draftAt = null;
        let lastAt = '';
        let host = null;
        let ui = null;
        // the viewer's scale on the frame (a device fit to its space); the overlay divides its sizes by it, to keep
        // its outlines and pins at screen size
        let zoom = 1;
        let tick;
        const pinNodes = new Map();
        const cursor = guard(() => new CSSStyleSheet())();
        guard(() => cursor.replaceSync('*,*::before,*::after{cursor:crosshair!important}'))();

        const ensureHost = () => {
            if (host) {
                return;
            }
            host = document.createElement('agent-overlay');
            host.style.cssText =
                'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:block';
            host.style.setProperty('--k', String(1 / zoom));
            const sr = host.attachShadow({ mode: 'closed' });
            const style = document.createElement('style');
            style.textContent = `
                .box{position:fixed;display:none;pointer-events:none;border-radius:calc(4px * var(--k));box-sizing:border-box;transition:all .08s ease-out}
                .hover{border:calc(2px * var(--k)) solid ${ACCENT};background:rgba(255,102,0,.08)}
                .focus{border:calc(2px * var(--k)) solid ${ACCENT};box-shadow:0 0 0 calc(4px * var(--k)) rgba(255,102,0,.25);background:rgba(255,102,0,.06)}
                .area{border:calc(2px * var(--k)) dashed ${ACCENT};background:rgba(255,102,0,.1);transition:none}
                .pin{position:fixed;pointer-events:auto;cursor:pointer;min-width:22px;height:22px;padding:0 6px;box-sizing:border-box;
                    border-radius:11px 11px 11px 3px;background:${ACCENT};color:#fff;font:600 11px/22px -apple-system,BlinkMacSystemFont,sans-serif;
                    text-align:center;border:1.5px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.3);transform:translate(-4px,-100%) scale(var(--k));
                    transform-origin:4px 100%}
                .pin:hover{filter:brightness(1.1)}`;
            const hover = document.createElement('div');
            hover.className = 'box hover';
            const focus = document.createElement('div');
            focus.className = 'box focus';
            const area = document.createElement('div');
            area.className = 'box area';
            const layer = document.createElement('div');
            const extra = document.createElement('div');
            sr.append(style, hover, focus, area, extra, layer);
            ui = { hover, focus, area, extra, layer };
            root.append(host);
            tick = setInterval(guard(layout), 500);
        };

        const dropHost = () => {
            if (!host || mode || pins.length || focusEl || draftAt || extraEls.length) {
                return;
            }
            clearInterval(tick);
            host.remove();
            host = ui = null;
            pinNodes.clear();
        };

        const place = (box, el) => {
            const r = el && (el.nodeType ? el.isConnected && el.getBoundingClientRect() : el);
            if (!r || (!r.width && !r.height)) {
                return (box.style.display = 'none');
            }
            const k = 1 / zoom;
            Object.assign(box.style, {
                display: 'block',
                left: `${r.left - 2 * k}px`,
                top: `${r.top - 2 * k}px`,
                width: `${r.width + 4 * k}px`,
                height: `${r.height + 4 * k}px`
            });
        };

        const find = (path) => guard(() => document.querySelector(path))() || null;

        // a region is an area's corners as fractions of its element's box
        const unit = (v) => typeof v === 'number' && v >= 0 && v <= 1;
        const validRegion = (g) =>
            g && unit(g.x0) && unit(g.y0) && unit(g.x1) && unit(g.y1) && g.x0 < g.x1 && g.y0 < g.y1 ? g : null;
        const validAt = (a) => (a && unit(a.x) && unit(a.y) ? { x: a.x, y: a.y } : null);
        const regionRect = (el, g) => {
            const b = el.getBoundingClientRect();
            const [left, top, right, bottom] = [
                b.left + g.x0 * b.width,
                b.top + g.y0 * b.height,
                b.left + g.x1 * b.width,
                b.top + g.y1 * b.height
            ];
            return { left, top, right, bottom, width: right - left, height: bottom - top };
        };

        const layout = () => {
            if (!ui) {
                return;
            }
            place(ui.hover, mode && !drag?.rect && (hoverRect ?? hoverEl));
            place(ui.focus, focusEl && focusRegion ? regionRect(focusEl, focusRegion) : (focusRect ?? focusEl));
            place(ui.area, drag?.rect);
            while (ui.extra.children.length < extraEls.length) {
                ui.extra.append(Object.assign(document.createElement('div'), { className: 'box focus' }));
            }
            [...ui.extra.children].forEach((b, i) => (i < extraEls.length ? place(b, extraEls[i]) : b.remove()));
            const at = new Map();
            const keep = new Set();
            for (const p of pins) {
                const el = find(p.path);
                const r = el && (p.region ? regionRect(el, p.region) : el.getBoundingClientRect());
                let b = pinNodes.get(p.tid);
                if (!b) {
                    b = document.createElement('div');
                    b.className = 'pin';
                    b.title = 'Open comment';
                    b.addEventListener('click', (e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        toParent({ type: 'pin', tid: p.tid });
                    });
                    pinNodes.set(p.tid, b);
                    ui.layer.append(b);
                }
                keep.add(p.tid);
                b.textContent = String(p.n);
                const pt = el && pointOf(el, p);
                if (pt || pt === null) {
                    const off = !pt || pt.y < 0 || pt.y > innerHeight || pt.x < 0 || pt.x > innerWidth;
                    Object.assign(
                        b.style,
                        off ? { display: 'none' } : { display: 'block', left: `${pt.x}px`, top: `${pt.y}px` }
                    );
                    continue;
                }
                if (!r || (!r.width && !r.height) || r.bottom < 0 || r.top > innerHeight) {
                    b.style.display = 'none';
                    continue;
                }
                const n = at.get(el) || 0;
                const k = 1 / zoom;
                at.set(el, n + 1);
                Object.assign(b.style, {
                    display: 'block',
                    left: `${Math.max(4 * k, Math.min(innerWidth - 30 * k, r.right + (n * 26 - 18) * k))}px`,
                    top: `${Math.max(26 * k, r.top + 4 * k)}px`
                });
            }
            for (const [tid, b] of pinNodes) {
                if (!keep.has(tid)) {
                    b.remove();
                    pinNodes.delete(tid);
                }
            }
            const d = atOf();
            const k = d && `${d.x},${d.y},${d.shown}`;
            if (d && k !== lastAt) {
                toParent({ type: 'at', at: d });
            }
            lastAt = k || '';
        };

        const atOf = () => {
            const el = draftAt?.el;
            const pt = el?.isConnected && pointOf(el, draftAt);
            if (!pt) {
                return el?.isConnected ? { x: 0, y: 0, shown: false } : null;
            }
            const [x, y] = [Math.round(pt.x), Math.round(pt.y)];
            return { x, y, shown: x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight };
        };

        // where a comment sits: a page that draws its own scene answers agent:pin on its element with client
        // px (or hidden: true when the spot is off screen); otherwise the click, as fractions of the element's box
        const pointOf = (el, p) => {
            if (pickers.has(el) || areaPickers.has(el)) {
                const d = { snippet: p.snippet || '', inside: p.inside || [], x: null, y: null, hidden: false };
                guard(() => fire(el, 'pin', { detail: d }))();
                if (d.hidden === true) {
                    return null;
                }
                if (Number.isFinite(d.x) && Number.isFinite(d.y)) {
                    return { x: d.x, y: d.y };
                }
            }
            if (!p.at) {
                return undefined;
            }
            const b = el.getBoundingClientRect();
            return { x: b.left + p.at.x * b.width, y: b.top + p.at.y * b.height };
        };

        let raf = 0;
        const schedule = () => {
            if (ui && !raf) {
                raf = requestAnimationFrame(() => ((raf = 0), guard(layout)()));
            }
        };
        addEventListener('scroll', schedule, { capture: true, passive: true });

        // a page whose content moves without scrolling (a 3d camera) asks for pins to follow; laid out at once,
        // so they move in the same frame the page draws
        hear(document, 'layout', guard(layout));
        addEventListener('resize', schedule, { passive: true });

        const setMode = (on) => {
            const was = mode;
            mode = !!on;
            hoverEl = null;
            hoverRect = null;
            drag = null;
            if (mode !== was) {
                guard(() => fire(document, 'comment-mode', { detail: { on: mode } }))();
            }
            if (cursor) {
                const rest = document.adoptedStyleSheets.filter((s) => s !== cursor);
                document.adoptedStyleSheets = mode ? [...rest, cursor] : rest;
            }
            if (mode) {
                ensureHost();
            }
            schedule();
            dropHost();
        };

        // a picker element that draws the focus itself; true when it took it
        const focusPage = (el, detail) => {
            if (pageFocus && pageFocus !== el) {
                fire(pageFocus, 'focus', { detail: null });
            }
            pageFocus = null;
            if (!el || !detail || !(pickers.has(el) || areaPickers.has(el))) {
                return false;
            }
            if (fire(el, 'focus', { detail, cancelable: true })) {
                return false;
            }
            pageFocus = el;
            return true;
        };
        const detailOf = (a) => ({
            snippet: typeof a?.snippet === 'string' ? a.snippet : '',
            inside: Array.isArray(a?.inside) ? a.inside.filter((v) => typeof v === 'string').slice(0, INSIDE_MAX) : []
        });

        const setFocus = (path, scroll, region, detail) => {
            clearTimeout(focusTimer);
            draftAt = null;
            picked = [];
            focusEl = path ? find(path) : null;
            focusRect = null;
            focusRegion = validRegion(region);

            // a thread's extra anchors: a page draws its own among them, the rest get boxes
            const also = (Array.isArray(detail?.also) ? detail.also : [])
                .map((a) => ({ el: find(a?.path), snippet: typeof a?.snippet === 'string' ? a.snippet : '' }))
                .filter((a) => a.el);
            extraEls = also.filter((a) => a.el !== focusEl).map((a) => a.el);
            const inside = [
                ...(detailOf(detail).inside || []),
                ...also.filter((a) => a.el === focusEl).map((a) => a.snippet)
            ];
            const byPage = guard(focusPage)(
                focusEl,
                focusEl && { snippet: detailOf(detail).snippet, inside: inside.slice(0, INSIDE_MAX + ALSO_MAX) }
            );
            if (focusEl) {
                ensureHost();
                if (scroll) {
                    focusEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
                }
                if (byPage) {
                    focusEl = null;
                }
                focusTimer = setTimeout(
                    () => ((focusEl = null), (extraEls = []), guard(focusPage)(null), schedule(), dropHost()),
                    4000
                );
            }
            schedule();
            dropHost();
        };

        const clipBytes = (s, n) => {
            const b = new TextEncoder().encode(s);
            return b.length <= n ? s : new TextDecoder().decode(b.slice(0, n)).replace(/�+$/, '');
        };
        const squash = (s) => (s || '').replace(/\s+/g, ' ').trim();

        const cssPath = (el) => {
            const parts = [];
            for (let e = el; e && e.nodeType === 1 && parts.length < 10; e = e.parentElement) {
                if (e === root) {
                    parts.unshift('html');
                    break;
                }
                if (e.id) {
                    const s = `#${CSS.escape(e.id)}`;
                    if (document.querySelectorAll(s).length === 1) {
                        parts.unshift(s);
                        break;
                    }
                }
                const did = e.getAttribute('data-id');
                if (did) {
                    const s = `[data-id="${CSS.escape(did)}"]`;
                    if (document.querySelectorAll(s).length === 1) {
                        parts.unshift(s);
                        break;
                    }
                }
                const tag = CSS.escape(e.localName);
                let i = 1;
                let dup = false;
                for (let s = e.previousElementSibling; s; s = s.previousElementSibling) {
                    if (s.localName === e.localName) {
                        i++;
                    }
                }
                for (let s = e.nextElementSibling; s && !dup; s = s.nextElementSibling) {
                    dup = s.localName === e.localName;
                }
                parts.unshift(i > 1 || dup ? `${tag}:nth-of-type(${i})` : tag);
            }
            return parts.join(' > ');
        };

        const HEADINGS = 'h1,h2,h3,h4,h5,h6,[role=heading]';
        const labelOf = (el) => {
            const hs = document.querySelectorAll(HEADINGS);
            for (let i = hs.length - 1; i >= 0; i--) {
                const h = hs[i];
                if (h === el || h.contains(el) || h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
                    const t = squash(h.textContent);
                    if (t) {
                        return t.slice(0, 128);
                    }
                }
            }
            return undefined;
        };

        const snippetOf = (el) => {
            const open = el.cloneNode(false).outerHTML.replace(/<\/[^>]+>$/, '');
            return `${open}${squash(el.textContent)}`.slice(0, 200);
        };

        const anchorOf = (target) => {
            let el = target;
            let quote;
            const sel = getSelection();
            if (sel && !sel.isCollapsed && sel.rangeCount) {
                const c = sel.getRangeAt(0).commonAncestorContainer;
                const ce = c.nodeType === 1 ? c : c.parentElement;
                if (ce && (el.contains(ce) || ce.contains(el))) {
                    el = ce;
                    quote = clipBytes(squash(sel.toString()), QUOTE_BYTES) || undefined;
                }
            }
            if (el === document.body || el === root) {
                el = target;
            }
            const a = { path: cssPath(el), snippet: snippetOf(el) };
            const label = labelOf(el);
            if (label) {
                a.label = label;
            }
            if (quote) {
                a.span = { quote };
            }
            return { el, anchor: a };
        };

        const inside = (e) => host && e.composedPath && e.composedPath().includes(host);

        const pickerOf = (el, map = pickers) => {
            for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
                if (map.has(n)) {
                    return [n, map.get(n)];
                }
            }
            return [];
        };
        const finite = (n) => typeof n === 'number' && Number.isFinite(n);
        const rectOf = (r) => {
            const b = r && r.rect;
            return b && [b.left, b.top, b.width, b.height].every(finite)
                ? { left: b.left, top: b.top, width: b.width, height: b.height }
                : null;
        };
        const text = (v, max) => (typeof v === 'string' && v ? clipBytes(squash(v), max) : undefined);
        // how.clicks: 0 for a hover, else the click count, so a double-click can mean something narrower
        const resolve = (fn, x, y, clicks = 0) => Promise.resolve(guard(fn)(x, y, { clicks })).catch(() => null);

        addEventListener(
            'mousemove',
            guard((e) => {
                if (!mode || drafting || inside(e) || drag?.rect) {
                    return;
                }
                const [pel, fn] = pickerOf(e.target);
                if (fn) {
                    const seq = ++hoverSeq;
                    resolve(fn, e.clientX, e.clientY).then((r) => {
                        if (seq !== hoverSeq) {
                            return;
                        }

                        // a hit without a rect is the page's to highlight; null outlines the element, false nothing
                        hoverRect = rectOf(r);
                        hoverEl = r === false || (r && !hoverRect) ? null : pel;
                        schedule();
                    });
                    return;
                }
                hoverSeq++;
                hoverRect = null;
                if (e.target !== hoverEl && e.target.nodeType === 1) {
                    hoverEl = e.target;
                    schedule();
                }
            }),
            { capture: true, passive: true }
        );
        addEventListener(
            'mouseout',
            (e) => {
                if (e.relatedTarget) {
                    return;
                }
                hoverEl = null;
                hoverRect = null;
                schedule();
            },
            { passive: true }
        );

        // comment mode: a drag that starts on text selects it for a quote; one anywhere else draws an area

        const onText = (x, y) => {
            const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
            const p = !r && document.caretPositionFromPoint ? document.caretPositionFromPoint(x, y) : null;
            const n = r ? r.startContainer : p && p.offsetNode;
            if (!n || n.nodeType !== 3 || !n.textContent.trim()) {
                return false;
            }
            const t = document.createRange();
            t.selectNodeContents(n);
            return [...t.getClientRects()].some((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom);
        };
        const covers = (b, r) =>
            b.left <= r.left + 1 && b.top <= r.top + 1 && b.right >= r.right - 1 && b.bottom >= r.bottom - 1;
        const overlap = (b, r) =>
            Math.max(0, Math.min(b.right, r.right) - Math.max(b.left, r.left)) *
            Math.max(0, Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top));
        const regionOf = (el, r) => {
            const b = el.getBoundingClientRect();
            const f = (v, o, n) => Math.round(Math.min(1, Math.max(0, n ? (v - o) / n : 0)) * 1000) / 1000;
            return validRegion({
                x0: f(r.left, b.left, b.width),
                y0: f(r.top, b.top, b.height),
                x1: f(r.right, b.left, b.width),
                y1: f(r.bottom, b.top, b.height)
            });
        };

        // the outermost elements at least half inside the area, in page order
        const coveredBy = (el, r, skip = () => false) => {
            const out = [];
            let n = 0;
            for (const c of el.querySelectorAll('*')) {
                if (++n > SCAN_MAX || out.length >= INSIDE_MAX) {
                    break;
                }
                if (c === host || skip(c) || out.some((o) => o.contains(c))) {
                    continue;
                }
                const b = c.getBoundingClientRect();
                if (b.width * b.height && overlap(b, r) >= (b.width * b.height) / 2) {
                    out.push(c);
                }
            }
            return out;
        };

        // the open comment gains anchors after its first (toggle: a second Shift+click takes one out); all stay outlined
        const extend = (items, toggle = false) => {
            for (const it of items) {
                const i = picked.findIndex(
                    (x) => x.anchor.path === it.anchor.path && x.anchor.snippet === it.anchor.snippet
                );
                if (i > 0 && toggle) {
                    picked = picked.filter((_, k) => k !== i);
                } else if (i < 0 && picked.length <= ALSO_MAX) {
                    picked.push(it);
                }
            }
            const [first, ...rest] = picked;
            const own = rest.filter((x) => x.el === first.el && (pickers.has(x.el) || areaPickers.has(x.el)));
            extraEls = rest.filter((x) => !own.includes(x)).map((x) => x.el);
            if (own.length || pageFocus === first.el) {
                guard(focusPage)(first.el, {
                    snippet: first.anchor.snippet,
                    inside: [...(first.anchor.inside || []), ...own.map((x) => x.anchor.snippet)]
                });
            }
            ensureHost();
            schedule();
            toParent({ type: 'anchor', anchor: first.anchor, also: rest.map((x) => x.anchor), at: atOf() });
        };

        // `pt` is where the comment box opens: the click, or an area's bottom-left corner
        const mark = (el, region, anchor, rect, pt, add) => {
            // Shift+click adds to the open comment, or takes out what it already holds
            if (add && picked.length) {
                return extend([{ el, anchor }], true);
            }
            picked = [{ el, anchor }];
            extraEls = [];
            const byPage = guard(focusPage)(el, detailOf(anchor));
            focusEl = byPage ? null : el;
            focusRect = byPage ? null : rect;
            focusRegion = region;
            clearTimeout(focusTimer);
            const b = el.getBoundingClientRect();
            const f = (v, o, n) => (n ? Math.min(1, Math.max(0, (v - o) / n)) : 0);
            // an area's box opens at its corner, not at the scene point its pin uses
            draftAt = {
                el,
                at: { x: f(pt.x, b.left, b.width), y: f(pt.y, b.top, b.height) },
                snippet: region ? '' : anchor.snippet,
                inside: region ? [] : anchor.inside
            };
            anchor.at = { x: Math.round(draftAt.at.x * 1000) / 1000, y: Math.round(draftAt.at.y * 1000) / 1000 };
            const at = atOf();
            lastAt = at ? `${at.x},${at.y},${at.shown}` : '';
            ensureHost();
            schedule();
            toParent({ type: 'anchor', anchor, at });
        };

        // Shift+drag adds what the area covers to the open comment instead of starting a new one. an area is about what
        // shows at its centre: a canvas's scene (its pin in the scene), or the page's html, such as a hud over the canvas
        // (its pin on the page); either way the canvas under it gives the capture
        const drawn = (r, add) => {
            const [cx, cy] = [r.left + r.width / 2, r.top + r.height / 2];
            const hit = document.elementFromPoint(cx, cy);
            const [cel, cfn] =
                document
                    .elementsFromPoint(cx, cy)
                    .map((n) => pickerOf(n, areaPickers))
                    .find((p) => p[0]) || [];
            const scene = cel && pickerOf(hit, areaPickers)[0] === cel;

            // the page's visible html in the area, not the canvas nor stage's own (a live app's hud, inspector, stats)
            const ours = globalThis[Symbol.for('playcanvas.stage')]?.gate?.ui;
            const skip = (n) =>
                (cel && n.contains(cel)) ||
                ours?.has(n) ||
                n.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) === false;

            // the area as far as it lies over the canvas, for the canvas's picker
            const b = cel && cel.getBoundingClientRect();
            const [left, top, right, bottom] = b
                ? [
                      Math.max(r.left, b.left),
                      Math.max(r.top, b.top),
                      Math.min(r.right, b.right),
                      Math.min(r.bottom, b.bottom)
                  ]
                : [];
            const c = b && { left, top, right, bottom, width: right - left, height: bottom - top };
            const over = c && c.width > 0 && c.height > 0;
            const ask = () =>
                over
                    ? Promise.resolve(guard(cfn)({ left, top, width: c.width, height: c.height })).catch(() => null)
                    : Promise.resolve(null);
            const imageOf = (res) => {
                const img = res && res.image;
                return typeof img === 'string' && img.length <= IMAGE_MAX_CHARS && IMAGE_RE.test(img) ? img : undefined;
            };
            const anchorsOf = (els) =>
                els.map((n) => ({
                    el: n,
                    anchor: JSON.parse(JSON.stringify({ path: cssPath(n), snippet: snippetOf(n), label: labelOf(n) }))
                }));

            if (scene) {
                const region = over && regionOf(cel, c);
                if (!region) {
                    return;
                }
                const ui = coveredBy(root, c, skip);
                return ask().then((res) => {
                    const a = { path: cssPath(cel), snippet: text(res && res.snippet, 200) || snippetOf(cel), region };
                    const label = text(res && res.label, 128) || labelOf(cel);
                    const ins = (Array.isArray(res && res.inside) ? res.inside : [])
                        .map((v) => text(v, 200))
                        .filter(Boolean);
                    const img = imageOf(res);
                    if (label) {
                        a.label = label;
                    }
                    if (ui.length || ins.length) {
                        a.inside = [...ui.map(snippetOf), ...ins].slice(0, INSIDE_MAX);
                    }
                    if (img) {
                        a.image = img;
                    }
                    // added objects share the area's capture: it rides on the first of them
                    if (add && picked.length) {
                        return extend(
                            [
                                ...anchorsOf(ui),
                                ...ins.map((snippet) => ({ el: cel, anchor: { path: a.path, snippet } }))
                            ].map((x, i) => (i === 0 && img ? { ...x, anchor: { ...x.anchor, image: img } } : x))
                        );
                    }
                    mark(cel, region, a, null, { x: left, y: bottom });
                });
            }
            let el = hit;
            while (el && el !== root && !covers(el.getBoundingClientRect(), r)) {
                el = el.parentElement;
            }
            el = el || root;
            const region = regionOf(el, r);
            if (!region) {
                return;
            }
            const a = { path: cssPath(el), snippet: snippetOf(el), region };
            const label = labelOf(el);
            const covered = coveredBy(el, r, skip);
            if (add && picked.length) {
                return extend(anchorsOf(covered));
            }
            if (label) {
                a.label = label;
            }
            if (covered.length) {
                a.inside = covered.map(snippetOf);
            }
            return ask().then((res) => {
                const img = imageOf(res);
                if (img) {
                    a.image = img;
                }
                mark(el, region, a, null, { x: r.left, y: r.bottom });
            });
        };

        addEventListener(
            'pointerdown',
            guard((e) => {
                if (!mode || inside(e) || e.button !== 0) {
                    return;
                }
                // with Shift held, text is picked like any element rather than selected
                if (
                    !e.shiftKey &&
                    !pickerOf(e.target)[0] &&
                    !pickerOf(e.target, areaPickers)[0] &&
                    onText(e.clientX, e.clientY)
                ) {
                    return;
                }

                // the page never sees presses in comment mode: no camera orbit, no button press. that also keeps the
                // browser from focusing the page, so it takes focus itself and its keys (a 3d camera's W/A/S/D) still work
                guard(() => window.focus())();
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                if (e.pointerType === 'touch') {
                    return;
                }
                drag = { x: e.clientX, y: e.clientY, rect: null };
            }),
            true
        );
        addEventListener(
            'pointermove',
            guard((e) => {
                if (!drag || (!drag.rect && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_SLOP)) {
                    return;
                }

                // capture only once it is a drag, so the release lands here even outside the page; a plain
                // click stays uncaptured, or the browser would retarget it to <html>
                if (!drag.rect) {
                    guard(() => root.setPointerCapture(e.pointerId))();
                }
                const [left, top, right, bottom] = [
                    Math.min(drag.x, e.clientX),
                    Math.min(drag.y, e.clientY),
                    Math.max(drag.x, e.clientX),
                    Math.max(drag.y, e.clientY)
                ];
                drag.rect = { left, top, right, bottom, width: right - left, height: bottom - top };
                schedule();
            }),
            { capture: true, passive: true }
        );
        addEventListener(
            'pointerup',
            guard((e) => {
                const d = drag;
                drag = null;
                schedule();
                if (!d || !d.rect) {
                    return;
                }

                // the click that follows a drag lands on <html> (the capture), so the drag answers for it
                swallow = true;
                setTimeout(() => (swallow = false), 0);
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                if (d.rect.width >= AREA_MIN && d.rect.height >= AREA_MIN) {
                    drawn(d.rect, e.shiftKey);
                } else {
                    point(document.elementFromPoint(d.x, d.y), d.x, d.y, 1, e.shiftKey);
                }
            }),
            true
        );
        addEventListener('pointercancel', () => ((drag = null), schedule()), true);

        const point = (target, x, y, clicks, add) => {
            if (!target) {
                return;
            }
            const [pel, fn] = pickerOf(target);
            if (fn) {
                resolve(fn, x, y, clicks).then((r) => {
                    if (r === false) {
                        return;
                    }
                    const a = { path: cssPath(pel), snippet: text(r && r.snippet, 200) || snippetOf(pel) };
                    const label = text(r && r.label, 128) || labelOf(pel);
                    const img = r && r.image;
                    if (label) {
                        a.label = label;
                    }
                    if (typeof img === 'string' && img.length <= IMAGE_MAX_CHARS && IMAGE_RE.test(img)) {
                        a.image = img;
                    }
                    mark(pel, null, a, rectOf(r), { x, y }, add);
                });
                return;
            }
            const { el, anchor } = anchorOf(target);
            mark(el, null, anchor, null, { x, y }, add);
        };

        addEventListener(
            'click',
            guard((e) => {
                if (!mode || inside(e)) {
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                if (swallow) {
                    return (swallow = false);
                }
                point(e.target, e.clientX, e.clientY, e.detail || 1, e.shiftKey);
            }),
            true
        );

        addEventListener(
            'keydown',
            guard((e) => {
                if (e.key !== 'Escape' || !mode) {
                    return;
                }
                e.preventDefault();
                e.stopPropagation();

                // the shell decides: close an open draft, or leave comment mode
                toParent({ type: 'dismiss' });
            }),
            true
        );

        // C toggles comment mode, unless the page took the key or it was typed into a field
        addEventListener(
            'keydown',
            guard((e) => {
                if (
                    e.defaultPrevented ||
                    e.repeat ||
                    e.metaKey ||
                    e.ctrlKey ||
                    e.altKey ||
                    e.key.toLowerCase() !== 'c'
                ) {
                    return;
                }
                const t = e.composedPath()[0];
                if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) {
                    return;
                }
                toParent({ type: 'mode', on: !mode });
            })
        );

        // a live app's attach module says what keeps the scene tools off it, or null once they are on
        hear(
            document,
            'live',
            guard((e) =>
                toParent({ type: 'live', problem: typeof e.detail?.problem === 'string' ? e.detail.problem : null })
            )
        );

        // and a live app's mini-stats, asking when they open and told on each change, divide it out the same way:
        // `agent:zoom`, detail { s }
        const tellZoom = guard(() => fire(document, 'zoom', { detail: { s: zoom } }));
        hear(document, 'zoom-ask', tellZoom);

        // a live app's scene tools say whether its inspector panel can open and whether it is open
        hear(
            document,
            'inspector',
            guard((e) =>
                toParent({ type: 'inspector', available: e.detail?.available === true, open: e.detail?.open === true })
            )
        );

        // and whether its mini-stats can show and whether they do
        hear(
            document,
            'stats',
            guard((e) =>
                toParent({ type: 'stats', available: e.detail?.available === true, open: e.detail?.open === true })
            )
        );

        // a live app's scene tools report their toolbar's state, for the viewer to draw it off the app's canvas
        hear(
            document,
            'tools',
            guard((e) => e.detail && typeof e.detail === 'object' && toParent({ type: 'tools', state: e.detail }))
        );

        // messages from the shell

        addEventListener(
            'message',
            guard((e) => {
                if (!framed || e.source !== window.parent || e.origin !== shell) {
                    return;
                }
                const m = e.data;
                if (!m || m.da !== 1) {
                    return;
                }
                if (m.type === 'theme') {
                    setTheme(m.theme);
                } else if (m.type === 'mode') {
                    setMode(m.on);
                } else if (m.type === 'fullscreen') {
                    setFull(m.on === true);
                } else if (m.type === 'zoom' && typeof m.s === 'number' && m.s > 0 && Number.isFinite(m.s)) {
                    zoom = m.s;
                    host?.style.setProperty('--k', String(1 / zoom));
                    schedule();
                    tellZoom();
                } else if (m.type === 'inspector') {
                    guard(() => fire(document, 'inspector-toggle'))();
                } else if (m.type === 'stats') {
                    guard(() => fire(document, 'stats-toggle'))();
                } else if (m.type === 'tool' && typeof m.id === 'string') {
                    guard(() => fire(document, 'tool', { detail: { id: m.id } }))();
                } else if (m.type === 'draft') {
                    drafting = m.open === true;
                    hoverSeq++;
                    hoverEl = hoverRect = null;
                    schedule();
                    guard(() => fire(document, 'draft', { detail: { open: drafting } }))();
                } else if (m.type === 'focus') {
                    setFocus(typeof m.path === 'string' ? m.path : null, m.scroll !== false, m.region, m);
                } else if (m.type === 'pins') {
                    pins = Array.isArray(m.pins)
                        ? m.pins
                              .filter((p) => p && typeof p.path === 'string')
                              .slice(0, 200)
                              .map((p) => ({ ...p, region: validRegion(p.region), at: validAt(p.at) }))
                        : [];
                    if (pins.length) {
                        ensureHost();
                    }
                    schedule();
                    dropHost();
                }
            })
        );

        toParent({ type: 'ready', ver });
    };

    try {
        boot();
    } catch {}
})();
