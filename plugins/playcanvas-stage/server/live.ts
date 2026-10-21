// a live stage: the project's own dev server, started outside stage, proxied on the stage's frame origin
import { existsSync, realpathSync, statSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { request } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, join, normalize, sep } from 'node:path';
import type { Duplex, Transform } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

import { CDN_SCRIPT_HOSTS } from './constants.ts';
import { injectRuntime } from './wrap.ts';

export type Live = { url: string; root: string; allow?: string[] };
export type State = 'waiting' | 'attached' | 'unreachable';

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const ALLOW_MAX = 16;
const PROBE_MS = 1500;
const RELOAD_MS = 150;
const MAX_HTML = 32 * 1024 * 1024;

// hop-by-hop headers stay on their own hop; accept-encoding is dropped so html arrives plain for injection
const HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-connection',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'accept-encoding',
    'host'
]);

// the app's own framing and isolation headers would refuse the viewer; ours replace them
const DROP = new Set([
    ...HOP,
    'content-security-policy',
    'content-security-policy-report-only',
    'x-frame-options',
    'cross-origin-opener-policy',
    'cross-origin-embedder-policy',
    'content-length',
    'content-encoding'
]);

const DECODE: Record<string, () => Transform> = {
    gzip: createGunzip,
    'x-gzip': createGunzip,
    deflate: createInflate,
    br: createBrotliDecompress
};

/** checks a publish's live fields; an error message, or the stored form */
export const checkLive = (v: unknown, daemonPort: number): string | Live => {
    const l = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    const u = typeof l.url === 'string' ? URL.parse(l.url) : null;
    if (!u || u.protocol !== 'http:') {
        return 'url: pass the running dev server’s http:// page url';
    }
    if (!LOOPBACK.includes(u.hostname) || u.username || u.password) {
        return `url: ${u.host} is not a loopback host — Stage attaches only to a dev server on localhost, 127.0.0.1 or [::1]`;
    }
    if (Number(u.port || 80) === daemonPort) {
        return 'url: that is the stage server itself, not the project’s dev server';
    }
    if (typeof l.root !== 'string' || !isAbsolute(l.root) || !existsSync(l.root) || !statSync(l.root).isDirectory()) {
        return 'root: pass the project directory as an absolute path to an existing directory';
    }
    const allow = l.allow ?? [];
    if (
        !Array.isArray(allow) ||
        allow.length > ALLOW_MAX ||
        allow.some(
            (o) =>
                typeof o !== 'string' ||
                !/^(https?|wss?):$/.test(URL.parse(o)?.protocol ?? '') ||
                URL.parse(o)!.origin !== o
        )
    ) {
        return `allow: pass up to ${ALLOW_MAX} origins such as http://localhost:3000, with no path`;
    }
    return { url: u.href, root: l.root, ...(allow.length && { allow }) };
};

/** a live stage's page: its path and query on the server, which together with root identify the stage */
export const pageOf = (url: string) => {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
};

// modules we serve find the app's engine through one bridge module, which the attach module fills in
const BRIDGE = '/_frame/live/engine.mjs';
const IMPORT_RE = /(?<![@\w$.])import\s*(?:\*\s*as\s+([\w$]+)|\{([^}]*)\})\s*from\s*(['"])playcanvas\3\s*;?/g;

/** rewrites `import … from 'playcanvas'` to read the bridge; `@import` in doc comments is left alone */
export const rewriteImports = (src: string) => {
    let n = 0;
    return src.replace(IMPORT_RE, (_m, ns: string | undefined, names: string | undefined) => {
        if (ns) {
            return `import ${ns} from '${BRIDGE}';`;
        }
        const v = `__pc${n++}`;
        const list = names!
            .split(',')
            .map((x) => x.trim().replace(/^([\w$]+)\s+as\s+([\w$]+)$/, '$1: $2'))
            .filter(Boolean);
        return `import ${v} from '${BRIDGE}'; const { ${list.join(', ')} } = ${v};`;
    });
};

const INSPECTOR = join(import.meta.dirname, '..', 'web', 'live', 'inspector');

/** a file of the inspector: the app's own installed or linked copy when it has one, else the vendored one */
export const inspectorFile = (root: string, rel: string) => {
    if (rel !== 'package.json' && !rel.startsWith('src/')) {
        return undefined;
    }
    const own = join(root, 'node_modules', '@playcanvas', 'inspector');
    const base = existsSync(join(own, 'package.json')) ? realpathSync(own) : INSPECTOR;
    const f = normalize(join(base, rel));
    return f.startsWith(base + sep) && existsSync(f) && statSync(f).isFile() ? f : undefined;
};

export const liveCsp = (allow: string[] = []) => {
    const a = allow.map((o) => ` ${o}`).join('');
    return [
        `default-src 'self'${a}`,
        `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: ${CDN_SCRIPT_HOSTS.join(' ')}${a}`,
        `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com${a}`,
        `img-src 'self' data: blob:${a}`,
        `font-src 'self' data: https://fonts.gstatic.com${a}`,
        `media-src 'self' data: blob:${a}`,
        `connect-src 'self'${a} data: blob:`,
        "worker-src 'self' blob:",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'self'"
    ].join('; ');
};

const target = (url: string) => {
    const u = new URL(url);
    return {
        host: u.hostname.replace(/^\[|\]$/g, ''),
        port: Number(u.port || 80),
        origin: u.origin,
        hostHeader: u.host
    };
};

const forward = (h: IncomingHttpHeaders, drop: Set<string>) =>
    Object.fromEntries(Object.entries(h).filter(([k]) => !drop.has(k)));

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

const waitingPage = (tag: string, url: string) =>
    injectRuntime(
        `<!doctype html><html><head><meta charset="utf-8"><title>Waiting for the dev server</title><style>body{margin:0;display:grid;place-items:center;height:100vh;font:14px system-ui,sans-serif;color:#666}</style></head><body><p>Waiting for the dev server at ${esc(url)}</p><script>setInterval(()=>fetch('/_frame/live/status').then((r)=>r.json()).then((s)=>s.state==='attached'&&location.reload()).catch(()=>{}),1000)</script></body></html>`,
        tag
    );

export const createLive = (opts: {
    headers: (live: Live) => Record<string, string>;
    onState: (id: string, state: State, live: Live) => void;
    onError: (id: string, text: string) => void;
    onReload: (id: string) => void;
}) => {
    const states = new Map<string, State>();
    const sockets = new Map<string, number>();
    const watchers = new Map<string, { w: FSWatcher; n: number; t?: NodeJS.Timeout }>();

    const state = (id: string) => states.get(id) ?? 'waiting';
    const set = (id: string, live: Live, up: boolean) => {
        const prev = states.get(id);
        const next: State = up ? 'attached' : prev === 'attached' || prev === 'unreachable' ? 'unreachable' : 'waiting';
        states.set(id, next);
        if (next !== prev) {
            opts.onState(id, next, live);
        }
    };

    /** whether the server answers at all; any status counts */
    const probe = (id: string, live: Live) =>
        new Promise<boolean>((ok) => {
            const t = target(live.url);
            const r = request({ host: t.host, port: t.port, path: pageOf(live.url), headers: { host: t.hostHeader } });
            r.setTimeout(PROBE_MS, () => r.destroy());
            r.on('response', (res) => {
                res.resume();
                r.destroy();
                set(id, live, true);
                ok(true);
            });
            r.on('error', () => {
                set(id, live, false);
                ok(false);
            });
            r.end();
        });

    const proxy = (req: IncomingMessage, res: ServerResponse, id: string, live: Live, tag: string) => {
        const t = target(live.url);
        const up = request(
            {
                host: t.host,
                port: t.port,
                method: req.method,
                path: req.url,
                headers: { ...forward(req.headers, HOP), host: t.hostHeader }
            },
            (r) => {
                set(id, live, true);
                const h = forward(r.headers, DROP) as Record<string, string | string[]>;
                const loc = r.headers.location && URL.parse(r.headers.location, live.url);
                if (loc && loc.origin === t.origin) {
                    h.location = `${loc.pathname}${loc.search}${loc.hash}`;
                }
                Object.assign(h, opts.headers(live));
                const html = /text\/html/i.test(String(r.headers['content-type'])) && req.method !== 'HEAD';
                const dec = DECODE[String(r.headers['content-encoding'] ?? '').toLowerCase()];
                if (!html) {
                    for (const k of ['content-length', 'content-encoding']) {
                        if (r.headers[k]) {
                            h[k] = r.headers[k]!;
                        }
                    }
                    res.writeHead(r.statusCode ?? 502, h);
                    return void r.pipe(res);
                }
                const src = dec ? r.pipe(dec()) : r;
                const chunks: Buffer[] = [];
                let n = 0;
                src.on('data', (c: Buffer) => {
                    n += c.length;
                    if (n > MAX_HTML) {
                        return src.destroy(new Error('html page too large to inject into'));
                    }
                    chunks.push(c);
                });
                src.on('error', (e: Error) => {
                    opts.onError(id, `proxy ${req.url}: ${e.message}`);
                    if (!res.headersSent) {
                        res.writeHead(502).end(e.message);
                    } else {
                        res.destroy();
                    }
                });
                src.on('end', () => {
                    const body = Buffer.from(injectRuntime(Buffer.concat(chunks).toString('utf8'), tag));
                    res.writeHead(r.statusCode ?? 200, { ...h, 'content-length': String(body.length) }).end(body);
                });
            }
        );
        up.on('error', (e: NodeJS.ErrnoException) => {
            set(id, live, false);
            if (e.code !== 'ECONNREFUSED') {
                opts.onError(id, `proxy ${req.url}: ${e.message}`);
            }
            if (res.headersSent) {
                return void res.destroy();
            }
            const nav = req.method === 'GET' && /text\/html/.test(String(req.headers.accept ?? ''));
            if (nav || req.url === pageOf(live.url)) {
                return void res
                    .writeHead(503, {
                        ...opts.headers(live),
                        'content-type': 'text/html; charset=utf-8',
                        'cache-control': 'no-store'
                    })
                    .end(waitingPage(tag, live.url));
            }
            res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end(
                `the dev server at ${t.origin} is not answering`
            );
        });
        req.pipe(up);
    };

    // websockets (a dev server's hmr) are piped both ways once the server switches protocols
    const upgrade = (req: IncomingMessage, sock: Duplex, head: Buffer, id: string, live: Live) => {
        const t = target(live.url);
        const up = request({
            host: t.host,
            port: t.port,
            method: req.method,
            path: req.url,
            headers: { ...forward(req.headers, new Set(['host'])), host: t.hostHeader }
        });
        up.on('upgrade', (r, us, uh) => {
            set(id, live, true);
            const lines = [];
            for (let i = 0; i < r.rawHeaders.length; i += 2) {
                lines.push(`${r.rawHeaders[i]}: ${r.rawHeaders[i + 1]}`);
            }
            sock.write(`HTTP/1.1 101 ${r.statusMessage || 'Switching Protocols'}\r\n${lines.join('\r\n')}\r\n\r\n`);
            if (uh.length) {
                sock.write(uh);
            }
            if (head.length) {
                us.write(head);
            }
            sockets.set(id, (sockets.get(id) ?? 0) + 1);
            let open = true;
            const done = () => {
                if (!open) {
                    return;
                }
                open = false;
                sockets.set(id, (sockets.get(id) ?? 1) - 1);
                us.destroy();
                sock.destroy();
            };
            // either side ending ends the tunnel; half-open sockets would otherwise linger
            for (const x of [us, sock]) {
                x.on('end', done).on('close', done).on('error', done);
            }
            us.pipe(sock).pipe(us);
        });
        up.on('response', (r) => {
            sock.end(`HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\n\r\n`);
            r.resume();
        });
        up.on('error', () => {
            set(id, live, false);
            sock.destroy();
        });
        sock.on('error', () => up.destroy());
        up.end();
    };

    /** watches root while a frame is open; a change reloads frames, unless the app keeps a websocket (its hmr) */
    const watchRoot = (id: string, root: string) => {
        let x = watchers.get(id);
        if (!x) {
            const w = watch(root, { recursive: true }, (_e, f) => {
                const parts = String(f ?? '').split(/[\\/]/);
                if (parts.some((p) => p === 'node_modules' || p.startsWith('.'))) {
                    return;
                }
                if (sockets.get(id)) {
                    return;
                }
                clearTimeout(x!.t);
                x!.t = setTimeout(() => opts.onReload(id), RELOAD_MS);
            });
            w.on('error', () => w.close());
            x = { w, n: 0 };
            watchers.set(id, x);
        }
        x.n++;
        const held = x;
        return () => {
            if (--held.n > 0) {
                return;
            }
            clearTimeout(held.t);
            held.w.close();
            if (watchers.get(id) === held) {
                watchers.delete(id);
            }
        };
    };

    /** starts over at waiting: a new url, or a deleted stage */
    const forget = (id: string) => states.delete(id);

    const close = () => {
        for (const x of watchers.values()) {
            clearTimeout(x.t);
            x.w.close();
        }
        watchers.clear();
    };

    return { state, probe, proxy, upgrade, watchRoot, forget, close };
};
