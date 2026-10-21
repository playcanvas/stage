// the local stand-in for claude.ai: serves the viewer shell, each stage on its own
// <uuid>.localhost origin, and the agent api the mcp server calls. single writer of state.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, extname, join } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
    ANCHOR_ALSO_MAX,
    API_VERSION,
    ASSET_ID_RE,
    CAPABILITIES,
    COMMENT_ATTACHMENTS_MAX,
    FILE_TYPES,
    FRAME_CSP,
    HOME,
    HOST,
    MAX_PAGE_BYTES,
    PERMISSIONS_POLICY,
    PORT,
    PRESENCE_MS,
    PRESENCE_TTL_MS,
    REGION_INSIDE_MAX,
    UUID_RE,
    VER_RE
} from './constants.ts';
import * as db from './db.ts';
import { checkLive, createLive, inspectorFile, liveCsp, pageOf, rewriteImports } from './live.ts';
import * as S from './store.ts';
import { findTitle, injectRuntime, wrapHtml } from './wrap.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const LIVE_WEB = join(WEB, 'live');
const LIVE_FILE_RE = /^\/_frame\/live\/([a-z-]+\.m?js)$/;
const MAX_BODY = 128 * 1024 * 1024;
// the viewer's inspector frame beside a live app: a blank page on the app's origin that its inspector panel moves into
const INSPECTOR_PAGE =
    '<!doctype html><html style="height:100%"><title>Inspector</title><body style="margin:0;height:100%;background:#182022;overflow:hidden"></body></html>';

// how often open live stages are checked for their dev server coming and going
const LIVE_POLL_MS = 2000;

type Req = IncomingMessage & { body?: Buffer };
type Sse = { res: ServerResponse; id: string };

export const startDaemon = (opts: { port?: number; token?: string } = {}) => {
    const token = opts.token ?? randomBytes(24).toString('hex');
    const shellSse = new Set<Sse>();
    const frameSse = new Set<Sse>();
    let port = opts.port ?? PORT;

    const shellOrigin = () => `http://localhost:${port}`;
    const frameOrigin = (id: string) => `http://${id}.localhost:${port}`;
    const urlOf = (id: string) => `${shellOrigin()}/stage/${id}`;

    const emit = (set: Set<Sse>, id: string, event: string, data: unknown) => {
        for (const c of set) {
            if (c.id === id || c.id === '*') {
                c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            }
        }
    };

    // sessions by host pid: the stages each published or read, when its mcp server and its comment monitor last checked in
    const hosts = new Map<number, { ids: string[]; at: number; watch?: number }>();
    const shown = new Map<string, string>();
    const fresh = (t?: number) => !!t && Date.now() - t < PRESENCE_TTL_MS;
    const presence = (id: string) => {
        let s = 'none';
        for (const x of hosts.values()) {
            if (fresh(x.at) && x.ids.includes(id)) {
                if (fresh(x.watch)) {
                    return 'watching';
                }
                s = 'open';
            }
        }
        return s;
    };

    // tells open viewers when a stage's presence changes, including sessions that went quiet
    const sweep = () => {
        for (const [k, x] of hosts) {
            if (!fresh(x.at) && !fresh(x.watch)) {
                hosts.delete(k);
            }
        }
        for (const id of new Set([...shown.keys(), ...[...hosts.values()].flatMap((x) => x.ids)])) {
            const s = presence(id);
            if ((shown.get(id) ?? 'none') === s) {
                continue;
            }
            if (s === 'none') {
                shown.delete(id);
            } else {
                shown.set(id, s);
            }
            emit(shellSse, id, 'presence', { state: s });
        }
    };
    const sweeper = setInterval(sweep, PRESENCE_MS);
    sweeper.unref();

    const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
        const buf = Buffer.isBuffer(body)
            ? body
            : typeof body === 'string'
              ? Buffer.from(body)
              : Buffer.from(JSON.stringify(body));
        res.writeHead(status, {
            'content-type':
                typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json' : 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer',
            ...headers
        });
        res.end(buf);
    };
    const json = (res: ServerResponse, body: unknown, status = 200) => send(res, status, body);
    const notFound = (res: ServerResponse) => send(res, 404, 'not found');

    const readBody = (req: Req) =>
        new Promise<Buffer>((ok, bad) => {
            const chunks: Buffer[] = [];
            let n = 0;
            req.on('data', (c: Buffer) => {
                n += c.length;
                if (n > MAX_BODY) {
                    bad(Object.assign(new Error('body too large'), { status: 413 }));
                    req.destroy();
                } else {
                    chunks.push(c);
                }
            });
            req.on('end', () => ok(Buffer.concat(chunks)));
            req.on('error', bad);
        });
    const body = async (req: Req) => {
        const b = await readBody(req);
        if (!b.length) {
            return {};
        }
        const [e, v] = S.attempt(() => JSON.parse(b.toString('utf8')));
        return e ? S.refuse(400, 'the body is not JSON') : v;
    };

    const sse = (req: Req, res: ServerResponse, set: Set<Sse>, id: string) => {
        res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
            connection: 'keep-alive'
        });
        res.write(': ok\n\n');
        const c = { res, id };
        set.add(c);
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);

        // an open frame of a live stage watches the project for changes
        const root = set === frameSse && S.exists(id) ? S.meta(id).live?.root : undefined;
        const release = root && live.watchRoot(id, root);
        req.on('close', () => {
            clearInterval(ping);
            set.delete(c);
            if (release) {
                release();
            }
        });
    };

    const serveFile = (res: ServerResponse, file: string, type?: string, headers: Record<string, string> = {}) => {
        if (!existsSync(file) || !statSync(file).isFile()) {
            return notFound(res);
        }
        res.writeHead(200, {
            'content-type': type ?? FILE_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            ...headers
        });
        createReadStream(file).pipe(res);
    };

    // only the viewer shell may frame a page; opening it in its own tab still works
    const frameHeaders = (csp = FRAME_CSP) => ({
        'content-security-policy': `${csp}; frame-ancestors ${shellOrigin()}`,
        'permissions-policy': PERMISSIONS_POLICY,
        'referrer-policy': 'no-referrer'
    });

    // a live stage's frame: both views and its diagnostics hear of its dev server coming and going
    const note = (id: string, kind: string, level: string, text: string) =>
        S.exists(id) && S.addDiag(id, S.meta(id).ver, [{ ts: new Date().toISOString(), kind, level, text }]);
    const STATE_TEXT = {
        waiting: (u: string) => `the dev server at ${u} is not answering yet; this view attaches when it starts`,
        attached: (u: string) => `attached to the dev server at ${u}`,
        unreachable: (u: string) => `the dev server at ${u} is not answering any more (it was attached)`
    };
    const live = createLive({
        headers: (l) => frameHeaders(liveCsp(l.allow)),
        onState: (id, state, l) => {
            emit(shellSse, id, 'live', { state });
            emit(frameSse, id, 'live', { state });
            note(id, 'live', state === 'attached' ? 'info' : 'warn', STATE_TEXT[state](l.url));
        },
        onError: (id, text) => note(id, 'proxy', 'error', text),
        onReload: (id) => emit(frameSse, id, 'reload', {})
    });
    const poller = setInterval(() => {
        for (const id of new Set([...shellSse, ...frameSse].map((c) => c.id))) {
            const l = S.exists(id) ? S.meta(id).live : undefined;
            if (l) {
                live.probe(id, l);
            }
        }
    }, LIVE_POLL_MS);
    poller.unref();

    const tokenOk = (req: Req) => {
        const h = req.headers.authorization ?? '';
        const a = Buffer.from(h.replace(/^Bearer /, ''));
        const b = Buffer.from(token);
        return a.length === b.length && timingSafeEqual(a, b);
    };

    // db verbs shared by the agent api and the page's `db` capability
    const dbCall = (id: string, verb: string, a: db.Write & { query?: db.Query; writes?: db.Write[] }) => {
        switch (verb) {
            case 'whoami':
                return { user: S.me() };
            case 'get': {
                const d = db.get(id, a.collection, a.doc_id);
                return { docs: d ? [d] : [] };
            }
            case 'list':
            case 'query':
                return db.query(id, a.collection, a.query ?? {});
            case 'batch': {
                const writes = a.writes ?? [];
                const r = db.batch(id, writes);
                if (!('error' in r)) {
                    emit(frameSse, id, 'db', { paths: db.changed(writes) });
                }
                return r;
            }
            case 'set':
            case 'update':
            case 'delete':
            case 'str_replace': {
                const w = { ...a, op: verb };
                const r = db.write(id, w);
                if (!('error' in r)) {
                    emit(frameSse, id, 'db', { paths: db.changed(w) });
                }
                return r;
            }
        }
        return { error: { code: 'invalid_argument', message: `unknown verb ${verb}` } };
    };

    // `save` echoes a page's own save id back to it, so the page and its viewer keep running instead of reloading
    const doPublish = (p: S.PublishInput & { baseVersion?: string; force?: boolean; save?: string }) => {
        const prev = p.id ? S.meta(p.id) : undefined;
        if (prev && !!prev.live !== !!p.live) {
            return {
                status: 400,
                body: {
                    error: prev.live
                        ? 'a live stage shows its dev server and has no page to save'
                        : 'this stage is a published page, not a live app'
                }
            };
        }
        if (prev && !p.live && p.baseVersion && p.baseVersion !== prev.ver && !p.force) {
            const live = prev.versions.at(-1)!;
            return { status: 409, body: { error: 'conflict', live: { ver: live.ver, seq: live.seq, by: live.by } } };
        }
        const same =
            prev &&
            (p.live
                ? JSON.stringify(prev.live) === JSON.stringify(p.live)
                : S.page(prev.id) === p.html && !p.files && p.capabilities === undefined) &&
            p.label === undefined &&
            (p.title ?? prev.title) === prev.title &&
            (p.description ?? prev.description) === prev.description &&
            (p.icon ?? prev.icon) === prev.icon;
        if (same) {
            return {
                status: 200,
                body: { id: prev.id, ver: prev.ver, seq: prev.seq, unchanged: true, url: urlOf(prev.id), meta: prev }
            };
        }
        const r = S.publish(p);
        emit(shellSse, r.meta.id, 'version', { ver: r.meta.ver, seq: r.meta.seq, by: p.by ?? 'agent', save: p.save });
        emit(frameSse, r.meta.id, 'version', { ver: r.meta.ver, save: p.save });
        return {
            status: 200,
            body: {
                id: r.meta.id,
                ver: r.meta.ver,
                seq: r.meta.seq,
                created: !prev,
                url: urlOf(r.meta.id),
                frame: `${frameOrigin(r.meta.id)}${p.live ? pageOf(p.live.url) : `/v/${r.meta.ver}/`}`,
                written: r.written,
                removed: r.removed,
                carried: r.carried,
                meta: r.meta
            }
        };
    };

    const decodeFiles = (files?: Record<string, { b64: string; contentType: string } | null>) =>
        files &&
        Object.fromEntries(
            Object.entries(files).map(([k, v]) => [
                k,
                v && { data: Buffer.from(v.b64, 'base64'), contentType: v.contentType }
            ])
        );

    // /_agent/*: the mcp server and hooks, bearer token only
    const agent = async (req: Req, res: ServerResponse, parts: string[], q: URLSearchParams) => {
        if (parts[1] === 'health') {
            return json(res, { ok: true, pid: process.pid, port });
        }
        if (!tokenOk(req)) {
            return send(res, 401, 'unauthorized');
        }
        const m = req.method;
        if (parts[1] === 'publish' && m === 'POST') {
            const b = await body(req);
            if (b.id && !S.exists(b.id)) {
                return json(res, { error: 'not_found' }, 404);
            }
            if (b.live === undefined) {
                const r = doPublish({ ...b, live: undefined, files: decodeFiles(b.files) });
                return json(res, r.body, r.status);
            }

            // a live publish names the dev server; the same project page (root, path and query) is the same stage
            const l = checkLive(b.live, port);
            if (typeof l === 'string') {
                return json(res, { error: 'invalid_argument', message: l }, 400);
            }
            const id =
                b.id ?? S.list().find((x) => x.live?.root === l.root && pageOf(x.live.url) === pageOf(l.url))?.id;
            const r = doPublish({
                id,
                title: b.title,
                description: b.description,
                icon: b.icon,
                label: b.label,
                html: '',
                live: l
            });
            if (r.status !== 200) {
                return json(res, r.body, r.status);
            }
            const done = r.body as { id: string; unchanged?: boolean };
            if (!done.unchanged) {
                live.forget(done.id);
            }
            return json(res, { ...done, reachable: await live.probe(done.id, l) });
        }
        if (parts[1] === 'stages' && m === 'GET') {
            return json(
                res,
                S.list().map((a) => ({ ...summary(a), url: urlOf(a.id) }))
            );
        }
        if (parts[1] === 'presence' && m === 'POST') {
            const b = await body(req);
            const k = Number(b.host);
            if (!Number.isInteger(k) || k <= 1) {
                return send(res, 400, 'host required');
            }
            const ids = (Array.isArray(b.stages) ? b.stages : []).filter(
                (x: unknown) => typeof x === 'string' && UUID_RE.test(x)
            );

            // merged, so a reloaded mcp server (same host, empty memory) keeps its session's links
            const prev = hosts.get(k);
            hosts.set(k, { ...prev, ids: [...new Set([...(prev?.ids ?? []), ...ids])], at: Date.now() });
            sweep();
            return json(res, { ok: true });
        }
        if (parts[1] === 'pending' && m === 'POST') {
            const b = await body(req);
            const k = Number(b.host);

            // the monitor's poll is its heartbeat; the prompt hook's is not
            if (k > 1 && b.watch) {
                hosts.set(k, { ids: [], at: 0, ...hosts.get(k), watch: Date.now() });
                sweep();
            }

            // a known session hears only of its own stages; an unknown caller (no mcp check-in) of all
            const x = hosts.get(k);
            const p = S.pending(x && fresh(x.at) ? x.ids : undefined);
            for (const a of p) {
                emit(shellSse, a.id, 'comments', {});
            }
            return json(
                res,
                p.map((a) => ({ ...a, url: urlOf(a.id) }))
            );
        }
        if (parts[1] !== 's' || !S.exists(parts[2])) {
            return json(res, { error: 'not_found' }, 404);
        }
        const id = parts[2];
        const sub = parts[3];
        if (!sub && m === 'GET') {
            const meta = S.meta(id);
            const ver = q.get('ver') ?? meta.ver;
            if (!meta.versions.some((v) => v.ver === ver)) {
                return json(res, { error: 'no such version' }, 404);
            }
            if (meta.live) {
                await live.probe(id, meta.live);
                return json(res, {
                    meta,
                    html: '',
                    url: urlOf(id),
                    frame: `${frameOrigin(id)}${pageOf(meta.live.url)}`,
                    state: live.state(id)
                });
            }
            return json(res, { meta, html: S.page(id, ver), url: urlOf(id), frame: `${frameOrigin(id)}/v/${ver}/` });
        }
        if (!sub && m === 'DELETE') {
            S.remove(id);
            live.forget(id);
            emit(shellSse, id, 'deleted', {});
            emit(frameSse, id, 'deleted', {});
            return json(res, { deleted: true });
        }
        if (sub === 'file' && m === 'GET') {
            const meta = S.meta(id);
            const ver = q.get('ver') ?? meta.ver;
            const path = q.get('path') ?? '';
            const entry = meta.versions.find((v) => v.ver === ver)?.files.find((f) => f.path === path);
            if (!entry) {
                return json(res, { error: 'not_found' }, 404);
            }
            const data = readFileSync(join(S.versionDir(id, ver), path));
            return json(res, { ...entry, b64: data.toString('base64') });
        }
        if (sub === 'assets') {
            const aid = parts[4];
            if (!aid && m === 'GET') {
                return json(res, S.assets(id));
            }
            if (!aid && m === 'POST') {
                const b = await body(req);
                return json(res, S.addAsset(id, b.name, b.contentType, Buffer.from(b.b64, 'base64')));
            }
            if (aid && ASSET_ID_RE.test(aid)) {
                const a = S.assets(id).find((x) => x.id === aid);
                if (m === 'GET') {
                    return a
                        ? json(res, { ...a, b64: readFileSync(S.assetPath(id, aid)).toString('base64') })
                        : json(res, { error: 'not_found' }, 404);
                }
                if (m === 'DELETE') {
                    return json(res, { deleted: S.deleteAsset(id, aid) });
                }
            }
        }
        if (sub === 'comments') {
            if (!parts[4] && m === 'GET') {
                S.ack(id);
                if (S.markSeen(id)) {
                    emit(shellSse, id, 'comments', {});
                }
                return json(res, { threads: S.threads(id) });
            }
            const tid = parts[4];
            if (parts[5] === 'image' && m === 'GET') {
                const img = S.threadImage(id, tid, Number(parts[6] ?? 0) || 0);
                return img
                    ? json(res, { type: img.type, b64: readFileSync(img.file).toString('base64') })
                    : json(res, { error: 'not_found' }, 404);
            }
            if (parts[5] === 'attachment' && m === 'GET') {
                const img = S.commentAttachment(id, tid, parts[6], Number(parts[7]) || 0);
                return img
                    ? json(res, { type: img.type, b64: readFileSync(img.file).toString('base64') })
                    : json(res, { error: 'not_found' }, 404);
            }
            if (parts[5] === 'reply' && m === 'POST') {
                const b = await body(req);
                const r = S.addComment(id, tid, 'agent', b.text);
                if (!r) {
                    return json(res, { error: 'not_found' }, 404);
                }
                emit(shellSse, id, 'comments', {});
                return json(res, { thread_id: tid, comment_id: r.comment.id });
            }
            if (parts[5] === 'resolve' && m === 'POST') {
                const t = S.resolveThread(id, tid, true, 'agent');
                if (!t) {
                    return json(res, { error: 'not_found' }, 404);
                }
                emit(shellSse, id, 'comments', {});
                return json(res, { thread_id: tid, resolved: true });
            }
        }
        if (sub === 'db' && m === 'POST') {
            const b = await body(req);
            return json(res, dbCall(id, b.verb, b.args ?? {}));
        }
        if (sub === 'diag' && m === 'GET') {
            const ver = parts[4];
            if (!VER_RE.test(ver ?? '')) {
                return notFound(res);
            }
            const d = S.diag(id, ver);
            return d ? json(res, d) : json(res, { error: 'no_row' }, 404);
        }
        return notFound(res);
    };

    const summary = (a: S.Meta) => {
        const t = S.threads(a.id);
        return {
            id: a.id,
            title: a.title,
            description: a.description,
            icon: a.icon,
            updatedAt: a.updatedAt,
            createdAt: a.createdAt,
            ver: a.ver,
            seq: a.seq,
            files: a.versions.at(-1)?.files.length ?? 0,
            openThreads: t.filter((x) => !x.resolved_at).length
        };
    };

    // /api/*: the viewer shell on localhost; writes must come from the shell origin
    const shellApi = async (req: Req, res: ServerResponse, parts: string[]) => {
        const m = req.method;
        if (m !== 'GET' && req.headers.origin !== shellOrigin()) {
            return send(res, 403, 'cross-origin write refused');
        }
        if (parts[1] === 'stages' && m === 'GET') {
            return json(res, S.list().map(summary));
        }
        if (parts[1] === 'events') {
            const id = parts[2] ?? '*';
            if (id !== '*' && !S.exists(id)) {
                return notFound(res);
            }
            return sse(req, res, shellSse, id);
        }
        if (parts[1] !== 's' || !S.exists(parts[2])) {
            return notFound(res);
        }
        const id = parts[2];
        const sub = parts[3];
        if (!sub && m === 'GET') {
            const meta = S.meta(id);
            if (meta.live) {
                await live.probe(id, meta.live);
            }
            return json(res, {
                ...meta,
                ...(meta.live && { live: { ...meta.live, state: live.state(id) } }),
                frameOrigin: frameOrigin(id),
                me: S.me(),
                presence: presence(id)
            });
        }
        if (!sub && m === 'DELETE') {
            S.remove(id);
            live.forget(id);
            emit(shellSse, id, 'deleted', {});
            emit(frameSse, id, 'deleted', {});
            return json(res, { deleted: true });
        }
        if (sub !== 'comments') {
            return notFound(res);
        }
        const tid = parts[4];
        const changed = (x: unknown) => {
            emit(shellSse, id, 'comments', {});
            return x ? json(res, x) : notFound(res);
        };
        if (!tid && m === 'GET') {
            return json(res, { threads: S.threads(id).map((t) => ({ ...t, agent: S.agentStatus(t) })), me: S.me() });
        }
        if (tid && parts[5] === 'image' && m === 'GET') {
            const img = S.threadImage(id, tid, Number(parts[6] ?? 0) || 0);
            return img ? serveFile(res, img.file, img.type) : notFound(res);
        }
        if (tid && parts[5] === 'attachment' && m === 'GET') {
            const img = S.commentAttachment(id, tid, parts[6], Number(parts[7]) || 0);
            return img ? serveFile(res, img.file, img.type) : notFound(res);
        }

        // images the person attached to a comment; the viewer re-encodes them to fit, so a bad one is refused, not dropped
        const attached = (v: unknown) => {
            const all = Array.isArray(v) ? v : [];
            const imgs = all.length <= COMMENT_ATTACHMENTS_MAX ? all.map(S.commentImage) : [undefined];
            return imgs.every(Boolean) ? (imgs as { type: string; data: Buffer }[]) : undefined;
        };
        const badImages = `images: at most ${COMMENT_ATTACHMENTS_MAX} png, jpeg or webp images, each at most 1 MB`;
        if (!tid && m === 'POST') {
            const b = await body(req);
            if (typeof b.text !== 'string' || !b.text.trim()) {
                return send(res, 400, 'text required');
            }
            const images = attached(b.images);
            if (!images) {
                return send(res, 400, badImages);
            }
            // anchor text reaches the model, so keep only known, bounded fields
            const s = (v: unknown, n: number) => (typeof v === 'string' && v ? v.slice(0, n) : undefined);
            const a = b.anchor && typeof b.anchor === 'object' ? b.anchor : undefined;
            const quote = s(a?.span?.quote, 512);
            const path = s(a?.path, 1024);

            // a drawn area: corners as fractions of the anchored element, x0 < x1 and y0 < y1; a text quote wins
            const g = a?.region;
            const k = (v: unknown) => (typeof v === 'number' && v >= 0 && v <= 1 ? Math.round(v * 1000) / 1000 : NaN);
            const box = g && typeof g === 'object' && { x0: k(g.x0), y0: k(g.y0), x1: k(g.x1), y1: k(g.y1) };
            const region = path && !quote && box && box.x0 < box.x1 && box.y0 < box.y1 ? box : undefined;
            const inside =
                region && Array.isArray(a.inside)
                    ? a.inside
                          .map((v: unknown) => s(v, 200))
                          .filter(Boolean)
                          .slice(0, REGION_INSIDE_MAX)
                    : [];

            // more elements Shift+clicked into the same comment
            const also =
                path && Array.isArray(a.also)
                    ? a.also
                          .map(
                              (x: Record<string, unknown> | null) =>
                                  x &&
                                  typeof x === 'object' && {
                                      path: s(x.path, 1024),
                                      label: s(x.label, 128),
                                      snippet: s(x.snippet, 200)
                                  }
                          )
                          .filter((x: { path?: unknown } | null | false) => x && x.path)
                          .slice(0, ANCHOR_ALSO_MAX)
                          .map((x: object) => JSON.parse(JSON.stringify(x)))
                    : [];

            // where the comment was placed, as fractions of the anchored element's box; places its pin
            const at = a?.at && typeof a.at === 'object' && { x: k(a.at.x), y: k(a.at.y) };
            const anchor = a && {
                path,
                label: s(a.label, 128),
                snippet: s(a.snippet, 200),
                ...(quote && { span: { quote } }),
                ...(region && { region }),
                ...(inside.length && { inside }),
                ...(also.length && { also }),
                ...(path && at && Number.isFinite(at.x) && Number.isFinite(at.y) && { at })
            };
            const meta = S.meta(id);
            const ver = meta.versions.some((v) => v.ver === b.ver) ? b.ver : meta.ver;
            const r = S.newThread(id, b.text, anchor, ver, images);

            // a drawn area or a clicked object can bring a capture of it as the viewer saw it (a 3d scene's canvas)
            const img = path && S.commentImage(b.image);
            if (r && img) {
                S.setThreadImage(id, r.thread.id, img);
            }

            // and each Shift-picked anchor its own, in the order of `also`
            for (const [i, v] of (Array.isArray(b.also_images) ? b.also_images.slice(0, also.length) : []).entries()) {
                const x = S.commentImage(v);
                if (r && x) {
                    S.setThreadImage(id, r.thread.id, x, i + 1);
                }
            }
            if (r && b.toAgent) {
                S.sendToAgent(id, r.thread.id);
            }
            return changed(r && S.threads(id).find((t) => t.id === r.thread.id));
        }
        if (tid && !parts[5] && m === 'POST') {
            const b = await body(req);
            if (typeof b.text !== 'string' || !b.text.trim()) {
                return send(res, 400, 'text required');
            }
            const images = attached(b.images);
            if (!images) {
                return send(res, 400, badImages);
            }
            return changed(S.addComment(id, tid, 'user', b.text, !!b.toAgent, images)?.thread);
        }
        if (tid && !parts[5] && m === 'DELETE') {
            S.deleteThread(id, tid);
            return changed({ deleted: true });
        }
        if (parts[5] === 'send' && m === 'POST') {
            return changed(S.sendToAgent(id, tid));
        }
        if (parts[5] === 'resolve' && m === 'POST') {
            const b = await body(req);
            return changed(S.resolveThread(id, tid, b.resolved !== false, 'user'));
        }
        return notFound(res);
    };

    // <uuid>.localhost: the stage page, its files and assets, and the page runtime api
    const frame = async (req: Req, res: ServerResponse, id: string, path: string) => {
        if (!S.exists(id)) {
            return notFound(res);
        }
        const meta = S.meta(id);
        const m = req.method;
        const caps = Object.keys(meta.capabilities ?? {}).filter((c) => CAPABILITIES.includes(c));
        const tag = (ver: string) =>
            `<script src="/_frame/runtime.js" data-id="${id}" data-ver="${ver}" data-caps="${caps.join(',')}" data-shell="${shellOrigin()}"${meta.live ? ' data-live="1"' : ''}></script>${meta.live ? '<script src="/_frame/live/hook.js"></script><script type="module" src="/_frame/live/attach.mjs"></script>' : ''}`;

        // a live stage is its dev server at the root of the frame origin, around our own /_frame/ routes
        if (meta.live && !path.startsWith('/_frame/') && !path.startsWith('/_blob/')) {
            return live.proxy(req, res, id, meta.live, tag(meta.ver));
        }
        if (path === '/' || path === '') {
            return send(res, 302, '', { location: `/v/${meta.ver}/` });
        }
        if (path === '/_frame/runtime.js') {
            return serveFile(res, join(WEB, 'runtime.js'), 'text/javascript', frameHeaders());
        }
        if (path.startsWith('/_blob/')) {
            const aid = path.slice(7);
            const a = ASSET_ID_RE.test(aid) && S.assets(id).find((x) => x.id === aid);
            return a ? serveFile(res, S.assetPath(id, aid), a.contentType, frameHeaders()) : notFound(res);
        }
        if (path.startsWith('/_frame/')) {
            if (m !== 'GET' && req.headers.origin !== frameOrigin(id)) {
                return send(res, 403, 'cross-origin write refused');
            }
            const need = (c: string) =>
                caps.includes(c) || (send(res, 403, `the page does not declare the ${c} capability`), false);
            if (path === '/_frame/events') {
                return sse(req, res, frameSse, id);
            }
            if (path === '/_frame/live/status' && meta.live) {
                await live.probe(id, meta.live);
                return json(res, { state: live.state(id) });
            }
            if (path === '/_frame/live/inspector.html' && meta.live) {
                return send(res, 200, INSPECTOR_PAGE, {
                    ...frameHeaders(liveCsp(meta.live.allow)),
                    'content-type': 'text/html; charset=utf-8'
                });
            }

            // the inspector panel, importing the app's engine through the bridge
            const ins = meta.live && /^\/_frame\/live\/inspector\/([\w./-]+\.(?:js|json))$/.exec(path)?.[1];
            if (ins) {
                const file = inspectorFile(meta.live!.root, ins);
                if (!file) {
                    return notFound(res);
                }
                const src = readFileSync(file, 'utf8');
                const js = ins.endsWith('.js');
                return send(res, 200, js ? rewriteImports(src) : src, {
                    ...frameHeaders(liveCsp(meta.live!.allow)),
                    'content-type': js ? 'text/javascript; charset=utf-8' : 'application/json'
                });
            }

            // the scene tools and the engine scripts they use, importing the app's engine through the bridge
            const lf = meta.live && LIVE_FILE_RE.exec(path)?.[1];
            if (lf) {
                const file = join(LIVE_WEB, lf);
                if (!existsSync(file)) {
                    return notFound(res);
                }
                const src = readFileSync(file, 'utf8');
                return send(res, 200, lf.endsWith('.mjs') ? rewriteImports(src) : src, {
                    ...frameHeaders(liveCsp(meta.live!.allow)),
                    'content-type': 'text/javascript; charset=utf-8'
                });
            }
            if (path === '/_frame/api/diag' && m === 'POST') {
                const b = await body(req);
                if (Array.isArray(b.entries)) {
                    S.addDiag(id, b.ver, b.entries.slice(0, 100));
                }
                return json(res, { ok: true });
            }
            if (path === '/_frame/api/user' && need('user')) {
                return json(res, S.me());
            }

            // Apply: one message to the agent, through the comment channel, with every pending edit of a live app
            if (path === '/_frame/api/apply' && m === 'POST' && meta.live) {
                const v = (x: unknown) => (Array.isArray(x) ? x.slice(0, 3).map(Number).join(', ') : '?');
                const edits = db
                    .query(id, 'edits', { limit: 1000 })
                    .docs.map((d) => d.data as { path?: unknown; pos?: unknown; rot?: unknown; scale?: unknown })
                    .filter((d) => typeof d.path === 'string')
                    .sort((a, b) => String(a.path).localeCompare(String(b.path)));
                if (!edits.length) {
                    return send(res, 400, 'no pending edits');
                }
                const text = [
                    `Apply ${edits.length} viewer edit${edits.length > 1 ? 's' : ''} to the project's source (local position, euler rotation in degrees, scale):`,
                    ...edits.map(
                        (d) =>
                            `- ${String(d.path).slice(0, 512)} — pos ${v(d.pos)} · rot ${v(d.rot)} · scale ${v(d.scale)}`
                    ),
                    'Fold each into the code that creates or places that entity, then delete its doc from StageData collection "edits" once the app has reloaded with it.'
                ].join('\n');
                const r = S.newThread(id, text, undefined, meta.ver);
                if (r) {
                    S.sendToAgent(id, r.thread.id);
                }
                emit(shellSse, id, 'comments', {});
                return json(res, { thread_id: r?.thread.id, count: edits.length });
            }
            if (path === '/_frame/api/db' && m === 'POST' && need('db')) {
                const b = await body(req);
                if (b.verb === 'whoami' && !caps.includes('user')) {
                    return send(res, 403, 'the page does not declare the user capability');
                }
                return json(res, dbCall(id, b.verb, b.args ?? {}));
            }
            if (path === '/_frame/api/assets' && need('assets')) {
                if (m === 'GET') {
                    return json(
                        res,
                        S.assets(id).map((a) => ({ ...a, url: `/_blob/${a.id}` }))
                    );
                }
                if (m === 'POST') {
                    const data = await readBody(req);
                    const name = decodeURIComponent(String(req.headers['x-name'] ?? 'upload'));
                    const a = S.addAsset(
                        id,
                        name,
                        String(req.headers['content-type'] ?? 'application/octet-stream'),
                        data
                    );
                    return json(res, { ...a, url: `/_blob/${a.id}` });
                }
            }
            if (path === '/_frame/api/publish' && m === 'POST' && need('stage')) {
                const b = await body(req);
                // a page that sends its live DOM would otherwise carry the injected runtime tag
                const html = wrapHtml(
                    String(b.html ?? '').replace(/<script src="\/_frame\/runtime\.js"[^>]*><\/script>/g, '')
                );
                if (Buffer.byteLength(html) > MAX_PAGE_BYTES) {
                    return send(res, 413, `too large: a page is at most ${MAX_PAGE_BYTES / 1024 / 1024}MB`);
                }
                const save = typeof b.save === 'string' ? b.save.slice(0, 64) : undefined;
                const r = doPublish({
                    id,
                    title: findTitle(html) ?? meta.title,
                    html,
                    by: 'page',
                    baseVersion: b.baseVersion,
                    save
                });
                return json(res, r.body, r.status);
            }
            return res.headersSent ? undefined : notFound(res);
        }
        const v = path.match(/^\/v\/([0-9a-f]{12})\/(.*)$/);
        if (!v) {
            return notFound(res);
        }
        const [, ver, rest] = v;
        if (!meta.versions.some((x) => x.ver === ver)) {
            return notFound(res);
        }
        const vdir = S.versionDir(id, ver);
        if (rest === '' || rest === 'index.html') {
            return send(res, 200, injectRuntime(readFileSync(join(vdir, 'index.html'), 'utf8'), tag(ver)), {
                ...frameHeaders(),
                'content-type': 'text/html; charset=utf-8'
            });
        }
        const file = S.inside(vdir, decodeURIComponent(rest));
        const entry = meta.versions.find((x) => x.ver === ver)!.files.find((f) => f.path === decodeURIComponent(rest));
        return file && entry ? serveFile(res, file, entry.contentType, frameHeaders()) : notFound(res);
    };

    const handle = async (req: Req, res: ServerResponse) => {
        const host = (req.headers.host ?? '').toLowerCase();
        const [name, p] = host.split(':');
        if (p !== String(port)) {
            return send(res, 421, 'wrong host');
        }
        const u = new URL(req.url ?? '/', `http://${host}`);
        const parts = u.pathname.split('/').filter(Boolean);
        const sub = name.endsWith('.localhost') ? name.slice(0, -'.localhost'.length) : undefined;
        if (sub !== undefined) {
            return UUID_RE.test(sub) ? frame(req, res, sub, u.pathname) : send(res, 421, 'wrong host');
        }
        if (name !== 'localhost' && name !== '127.0.0.1') {
            return send(res, 421, 'wrong host');
        }
        if (parts[0] === '_agent') {
            return agent(req, res, parts, u.searchParams);
        }
        if (name === '127.0.0.1' && parts[0] !== '_agent') {
            return send(res, 302, '', { location: `${shellOrigin()}${u.pathname}${u.search}` });
        }
        if (parts[0] === 'api') {
            return shellApi(req, res, parts);
        }
        if (parts[0] === '_static' && parts.length === 2 && /^[a-z]+\.(js|css|svg)$/.test(parts[1])) {
            return serveFile(res, join(WEB, parts[1]));
        }
        if (u.pathname === '/') {
            return send(res, 302, '', { location: '/stages' });
        }
        if (u.pathname === '/stages' || (parts[0] === 'stage' && UUID_RE.test(parts[1] ?? '') && parts.length === 2)) {
            return serveFile(res, join(WEB, 'viewer.html'), 'text/html; charset=utf-8', {
                'content-security-policy': `default-src 'self'; frame-src http://*.localhost:${port}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'`,
                'x-frame-options': 'DENY'
            });
        }
        return notFound(res);
    };

    const server = createServer((req, res) => {
        handle(req as Req, res).catch((e) => {
            if (!res.headersSent) {
                send(res, e?.status ?? 500, String(e?.message ?? e));
            } else {
                res.end();
            }
        });
    });

    // websockets reach only a live stage's dev server (its hmr)
    server.on('upgrade', (req: Req, sock: Duplex, head: Buffer) => {
        const [name, p] = (req.headers.host ?? '').toLowerCase().split(':');
        const id = name.endsWith('.localhost') ? name.slice(0, -'.localhost'.length) : '';
        const l = p === String(port) && UUID_RE.test(id) && S.exists(id) ? S.meta(id).live : undefined;
        if (l) {
            live.upgrade(req, sock, head, id, l);
        } else {
            sock.destroy();
        }
    });

    return new Promise<{ port: number; token: string; close: () => Promise<void> }>((ok, bad) => {
        server.once('error', bad);
        server.listen(port, HOST, () => {
            port = (server.address() as { port: number }).port;
            ok({
                port,
                token,
                close: () =>
                    new Promise((r) => {
                        clearInterval(sweeper);
                        clearInterval(poller);
                        live.close();
                        for (const c of [...shellSse, ...frameSse]) {
                            c.res.end();
                        }
                        server.close(() => r());
                    })
            });
        });
    });
};

// run as a process: `node daemon.ts` writes server.json for clients to find it
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const { writeAtomic } = S;
    const { port, token } = await startDaemon();
    const { chmodSync } = await import('node:fs');
    const file = join(HOME, 'server.json');
    writeAtomic(file, JSON.stringify({ pid: process.pid, port, token, api: API_VERSION }));
    chmodSync(file, 0o600);
    console.log(`playcanvas-stage daemon on http://localhost:${port}`);
}
