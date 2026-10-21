import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

const HOME = mkdtempSync(join(tmpdir(), 'stage-live-'));
process.env.STAGE_DIR = HOME;
const { startDaemon } = await import('../plugins/playcanvas-stage/server/daemon.ts');
const { rewriteImports } = await import('../plugins/playcanvas-stage/server/live.ts');

type Res = { status: number; body: any; headers: Record<string, unknown> };
const http = (
    port: number,
    method: string,
    path: string,
    opts: { host?: string; headers?: Record<string, string>; body?: unknown } = {}
) =>
    new Promise<Res>((ok, bad) => {
        const data = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
        const req = request(
            {
                host: '127.0.0.1',
                port,
                method,
                path,
                headers: {
                    host: opts.host ?? `localhost:${port}`,
                    ...(data && { 'content-type': 'application/json' }),
                    ...opts.headers
                }
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => {
                    const t = Buffer.concat(chunks).toString();
                    ok({
                        status: res.statusCode!,
                        headers: res.headers,
                        body: String(res.headers['content-type']).startsWith('application/json') ? JSON.parse(t) : t
                    });
                });
            }
        );
        req.on('error', bad);
        req.end(data);
    });

const until = async (f: () => Promise<boolean> | boolean, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
        if (await f()) {
            return;
        }
    }
    assert.fail('timed out');
};

// a stand-in dev server: records what it was asked, serves html, a self-redirect, and echoes websockets
const upstream = (port = 0) =>
    new Promise<{ srv: Server; port: number; seen: IncomingMessage[] }>((ok) => {
        const seen: IncomingMessage[] = [];
        const srv = createServer((req, res) => {
            seen.push(req);
            const u = new URL(req.url!, 'http://x');
            const p = (srv.address() as AddressInfo).port;
            if (u.pathname === '/away') {
                return res.writeHead(302, { location: `http://localhost:${p}/next?x=1` }).end();
            }
            if (u.pathname === '/out') {
                return res.writeHead(302, { location: 'https://example.com/' }).end();
            }
            if (u.pathname === '/app.js') {
                return res.writeHead(200, { 'content-type': 'text/javascript' }).end('1;');
            }
            const page = '<html><head lang="en"></head><b>a</b></html>';
            res.writeHead(200, {
                'content-type': 'text/html',
                'content-security-policy': "default-src 'none'",
                'x-frame-options': 'DENY',
                'content-length': String(page.length)
            }).end(page);
        });
        srv.on('upgrade', (req, sock: Socket) => {
            seen.push(req);
            sock.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: upgrade\r\n\r\n');
            sock.on('data', (d) => sock.write(d));
        });
        srv.listen(port, '127.0.0.1', () => ok({ srv, port: (srv.address() as AddressInfo).port, seen }));
    });

const freePort = () =>
    new Promise<number>((ok) => {
        const s = createServer().listen(0, '127.0.0.1', () => {
            const p = (s.address() as AddressInfo).port;
            s.close(() => ok(p));
        });
    });

describe('the engine bridge', () => {
    test('every module we serve imports playcanvas from the bridge', () => {
        const src = [
            "import { Vec3, Entity as E } from 'playcanvas';",
            'import {',
            '    Quat,',
            '    Mat4',
            '} from "playcanvas"',
            "import * as pc from 'playcanvas';",
            "/** @import { AppBase } from 'playcanvas' */",
            "import { x } from './local.js';",
            'new Vec3();'
        ].join('\n');
        const out = rewriteImports(src);
        assert.doesNotMatch(out, /from ['"]playcanvas['"];?\n/);
        assert.match(out, /import __pc0 from '\/_frame\/live\/engine\.mjs'; const \{ Vec3, Entity: E \} = __pc0;/);
        assert.match(out, /import __pc1 from '\/_frame\/live\/engine\.mjs'; const \{ Quat, Mat4 \} = __pc1;/);
        assert.match(out, /import pc from '\/_frame\/live\/engine\.mjs';/);
        assert.ok(out.includes("/** @import { AppBase } from 'playcanvas' */"));
        assert.ok(out.includes("import { x } from './local.js';"));
    });
});

describe('live stages', () => {
    let d: Awaited<ReturnType<typeof startDaemon>>;
    let up: Awaited<ReturnType<typeof upstream>>;
    const root = mkdtempSync(join(tmpdir(), 'stage-live-root-'));
    const agent = (method: string, path: string, body?: unknown) =>
        http(d.port, method, path, { body, headers: { authorization: `Bearer ${d.token}` } });
    const attach = (live: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
        agent('POST', '/_agent/publish', { title: 'App', live: { root, ...live }, ...extra });
    const frame = (id: string, path: string, headers: Record<string, string> = {}) =>
        http(d.port, 'GET', path, { host: `${id}.localhost:${d.port}`, headers });

    before(async () => {
        d = await startDaemon({ port: 0 });
        up = await upstream();
    });
    after(async () => {
        up.srv.close();
        await d.close();
    });

    test('publish takes only an http loopback url and an absolute root', async () => {
        for (const url of [
            'https://localhost:5173/',
            'http://example.com/',
            'http://10.0.0.1:5173/',
            'file:///index.html',
            'http://localhost:5173.evil/',
            `http://localhost:${d.port}/stages`,
            'not a url'
        ]) {
            const r = await attach({ url });
            assert.equal(r.status, 400, url);
        }
        assert.equal((await attach({ url: `http://localhost:${up.port}/`, root: 'relative/dir' })).status, 400);
        for (const host of ['localhost', '127.0.0.1', '[::1]']) {
            const r = await attach({ url: `http://${host}:${up.port}/x?level=${host}` });
            assert.equal(r.status, 200, host);
            assert.equal(r.body.meta.live.url, `http://${host}:${up.port}/x?level=${host}`);
        }
    });

    test('republishing the same root and page updates that stage, even on a new port', async () => {
        const a = await attach({ url: `http://localhost:${up.port}/same?a=1` });
        const b = await attach({ url: `http://127.0.0.1:${up.port + 1}/same?a=1` });
        assert.equal(b.body.id, a.body.id);
        assert.equal(b.body.created, false);
        assert.equal(b.body.meta.live.url, `http://127.0.0.1:${up.port + 1}/same?a=1`);
        const c = await attach({ url: `http://localhost:${up.port}/same?a=2` });
        assert.notEqual(c.body.id, a.body.id);
    });

    test('proxies with the server’s own Host, injects the runtime, and replaces framing headers', async () => {
        const { body } = await attach({ url: `http://localhost:${up.port}/` });
        assert.equal(body.reachable, true);
        up.seen.length = 0;
        const r = await frame(body.id, '/?level=2', { 'accept-encoding': 'gzip, br' });
        assert.equal(r.status, 200);
        const req = up.seen.at(-1)!;
        assert.equal(req.url, '/?level=2');
        assert.equal(req.headers.host, `localhost:${up.port}`);
        assert.equal(req.headers['accept-encoding'], undefined);
        assert.match(r.body, /^<html><head lang="en"><script src="\/_frame\/runtime\.js" [^>]*data-live="1"/);
        assert.ok(r.body.endsWith('<b>a</b></html>'));
        assert.equal(Number(r.headers['content-length']), Buffer.byteLength(r.body));
        assert.equal(r.headers['x-frame-options'], undefined);
        assert.match(String(r.headers['content-security-policy']), /frame-ancestors http:\/\/localhost:\d+/);
        assert.doesNotMatch(String(r.headers['content-security-policy']), /default-src 'none'/);

        // other types stream through untouched
        const js = await frame(body.id, '/app.js');
        assert.equal(js.body, '1;');
    });

    test('serves the hook ahead of the app and the tools beside it, on live stages only', async () => {
        const { body } = await attach({ url: `http://localhost:${up.port}/` });
        const page = await frame(body.id, '/');
        assert.match(
            page.body,
            /<head lang="en"><script src="\/_frame\/runtime\.js"[^>]*><\/script><script src="\/_frame\/live\/hook\.js"><\/script><script type="module" src="\/_frame\/live\/attach\.mjs"><\/script>/
        );
        const hook = await frame(body.id, '/_frame/live/hook.js');
        assert.equal(hook.status, 200);
        assert.match(String(hook.headers['content-type']), /javascript/);
        const tools = await frame(body.id, '/_frame/live/scene-tools.mjs');
        assert.equal(tools.status, 200);
        assert.doesNotMatch(tools.body, /from ['"]playcanvas['"]/);
        assert.match(tools.body, /from '\/_frame\/live\/engine\.mjs'/);
        // a dot path resolves to the app's own /server/…, never to our files
        assert.doesNotMatch((await frame(body.id, '/_frame/live/../../server/daemon.ts')).body, /startDaemon/);
        assert.equal((await frame(body.id, '/_frame/live/nope.mjs')).status, 404);
        const pageStage = await agent('POST', '/_agent/publish', { title: 'P', html: '<title>P</title>' });
        assert.equal((await frame(pageStage.body.id, '/_frame/live/hook.js')).status, 404);
    });

    test('serves the vendored inspector through the bridge, or the app’s own linked copy instead', async () => {
        const { body } = await attach({ url: `http://localhost:${up.port}/insp` });
        const index = await frame(body.id, '/_frame/live/inspector/src/index.js');
        assert.equal(index.status, 200);
        assert.match(index.body, /export \{ Inspector \}/);
        const main = await frame(body.id, '/_frame/live/inspector/src/inspector.js');
        assert.doesNotMatch(main.body, /^import[^;]*from ['"]playcanvas['"]/m);
        assert.match(main.body, /from '\/_frame\/live\/engine\.mjs'/);
        const pkg = await frame(body.id, '/_frame/live/inspector/package.json');
        assert.equal(pkg.body.peerDependencies.playcanvas, '^2.23.0');
        assert.equal((await frame(body.id, '/_frame/live/inspector/../../hook.js')).status === 200, false);
        assert.equal((await frame(body.id, '/_frame/live/inspector/src/nope.js')).status, 404);

        const dir = mkdtempSync(join(tmpdir(), 'stage-live-insp-'));
        const linked = mkdtempSync(join(tmpdir(), 'stage-insp-copy-'));
        mkdirSync(join(linked, 'src'));
        writeFileSync(
            join(linked, 'package.json'),
            '{"name":"@playcanvas/inspector","peerDependencies":{"playcanvas":"^2.23.0"}}'
        );
        writeFileSync(join(linked, 'src', 'index.js'), "import { Vec3 } from 'playcanvas';\nexport const fork = 1;");
        mkdirSync(join(dir, 'node_modules', '@playcanvas'), { recursive: true });
        symlinkSync(linked, join(dir, 'node_modules', '@playcanvas', 'inspector'));
        const l = await attach({ url: `http://localhost:${up.port}/insp2`, root: dir });
        const fork = await frame(l.body.id, '/_frame/live/inspector/src/index.js');
        assert.match(fork.body, /export const fork = 1/);
        assert.match(fork.body, /const \{ Vec3 \} = __pc0/);
    });

    test('Apply sends the agent one message with every pending edit', async () => {
        const { body } = await attach({ url: `http://localhost:${up.port}/apply` });
        const h = `${body.id}.localhost:${d.port}`;
        const post = (path: string, data?: unknown) =>
            http(d.port, 'POST', path, { host: h, body: data, headers: { origin: `http://${h}` } });
        assert.equal((await post('/_frame/api/apply')).status, 400, 'nothing pending');
        const edit = (doc: string, path: string, x: number) => ({
            op: 'set',
            collection: 'edits',
            doc_id: doc,
            data: { path, pos: [x, 0, 0], rot: [0, 90, 0], scale: [1, 1, 1] }
        });
        await post('/_frame/api/db', {
            verb: 'batch',
            args: { writes: [edit('e-a', '/Desk/Box', 1.5), edit('e-b', '/Ball', -2)] }
        });
        const r = await post('/_frame/api/apply');
        assert.equal(r.status, 200);
        assert.equal(r.body.count, 2);
        const { threads } = (await agent('GET', `/_agent/s/${body.id}/comments`)).body;
        assert.equal(threads.length, 1);
        const t = threads[0];
        assert.ok(t.comments[0].to_agent_at, 'sent to the agent');
        assert.match(t.comments[0].text, /^Apply 2 viewer edits to the project's source/);
        assert.match(t.comments[0].text, /^- \/Ball — pos -2, 0, 0 · rot 0, 90, 0 · scale 1, 1, 1$/m);
        assert.match(t.comments[0].text, /^- \/Desk\/Box — pos 1\.5, 0, 0/m);
        assert.match(t.comments[0].text, /StageData/);
        assert.equal(
            (await http(d.port, 'POST', '/_frame/api/apply', { host: h, headers: { origin: 'http://evil' } })).status,
            403
        );
    });

    test('keeps redirects to the server on the frame origin', async () => {
        const { body } = await attach({ url: `http://localhost:${up.port}/` });
        assert.equal((await frame(body.id, '/away')).headers.location, '/next?x=1');
        assert.equal((await frame(body.id, '/out')).headers.location, 'https://example.com/');
    });

    test('an allowed origin joins the csp', async () => {
        const r = await attach({ url: `http://localhost:${up.port}/allow`, allow: ['http://localhost:3000'] });
        assert.equal(r.status, 200);
        const csp = String((await frame(r.body.id, '/allow')).headers['content-security-policy']);
        assert.match(csp, /connect-src 'self' http:\/\/localhost:3000/);
        assert.equal(
            (await attach({ url: `http://localhost:${up.port}/allow`, allow: ['http://x.com; script-src *'] })).status,
            400
        );
    });

    test('proxies websockets both ways', async () => {
        const { body } = await attach({ url: `http://localhost:${up.port}/` });
        const s = connect(d.port, '127.0.0.1');
        await new Promise((r) => s.once('connect', r));
        s.write(
            `GET /hmr?token=t HTTP/1.1\r\nhost: ${body.id}.localhost:${d.port}\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\nsec-websocket-protocol: vite-hmr\r\n\r\n`
        );
        let got = '';
        s.on('data', (c) => (got += c));
        await until(() => got.includes('\r\n\r\n'));
        assert.match(got, /^HTTP\/1\.1 101/);
        const req = up.seen.at(-1)!;
        assert.equal(req.url, '/hmr?token=t');
        assert.equal(req.headers.host, `localhost:${up.port}`);
        assert.equal(req.headers['sec-websocket-protocol'], 'vite-hmr');
        got = '';
        s.write('ping');
        await until(() => got === 'ping');
        s.destroy();
    });

    test('waits for a server that is down, attaches when it starts, and shows when it goes away', async () => {
        const port = await freePort();
        const r = await attach({ url: `http://localhost:${port}/` });
        assert.equal(r.status, 200);
        assert.equal(r.body.reachable, false);
        const { id } = r.body;
        const status = async () => (await frame(id, '/_frame/live/status')).body.state;
        assert.equal(await status(), 'waiting');
        const w = await frame(id, '/', { accept: 'text/html' });
        assert.equal(w.status, 503);
        assert.match(w.body, /<script src="\/_frame\/runtime\.js"/);
        assert.match(w.body, /\/_frame\/live\/status/);
        assert.equal((await http(d.port, 'GET', `/api/s/${id}`)).body.live.state, 'waiting');

        const late = await upstream(port);
        await until(async () => (await status()) === 'attached');
        assert.equal((await frame(id, '/')).status, 200);
        await new Promise((ok) => late.srv.close(ok));
        late.srv.closeAllConnections();
        await until(async () => (await status()) === 'unreachable');
        const diag = await agent('GET', `/_agent/s/${id}/diag/${r.body.ver}`);
        assert.ok(diag.body.entries.some((e: any) => e.kind === 'live' && /not answering|unreachable/.test(e.text)));
    });

    test('a viewer can never supply a url', async () => {
        const page = await agent('POST', '/_agent/publish', {
            title: 'P',
            html: '<title>P</title>',
            capabilities: { stage: {} }
        });
        const host = `${page.body.id}.localhost:${d.port}`;
        const pub = (h: string, body: unknown) =>
            http(d.port, 'POST', '/_frame/api/publish', { host: h, body, headers: { origin: `http://${h}` } });
        const r = await pub(host, { html: '<p>x</p>', live: { url: `http://localhost:${up.port}/`, root } });
        assert.equal(r.status, 200);
        assert.equal(r.body.meta.live, undefined);

        // and a live stage has no page to save
        const live = await attach({ url: `http://localhost:${up.port}/v` });
        assert.equal(live.body.meta.capabilities.db !== undefined, true);
        const lh = `${live.body.id}.localhost:${d.port}`;
        assert.notEqual((await pub(lh, { html: '<p>x</p>' })).status, 200);
    });

    test('reloads the frame when a file under root changes, unless a websocket (hmr) is open', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'stage-live-watch-'));
        const { body } = await attach({ url: `http://localhost:${up.port}/w`, root: dir });
        let events = '';
        const es = request({
            host: '127.0.0.1',
            port: d.port,
            path: '/_frame/events',
            headers: { host: `${body.id}.localhost:${d.port}` }
        });
        es.on('response', (res) => res.on('data', (c) => (events += c)));
        es.end();
        await until(() => events.includes(': ok'));
        await new Promise((r) => setTimeout(r, 100));
        writeFileSync(join(dir, 'index.html'), '<p>1</p>');
        await until(() => events.includes('event: reload'));

        // an open websocket means the app has its own hmr
        events = '';
        const s = connect(d.port, '127.0.0.1');
        await new Promise((r) => s.once('connect', r));
        s.write(
            `GET /hmr HTTP/1.1\r\nhost: ${body.id}.localhost:${d.port}\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n`
        );
        await until(() => up.seen.at(-1)?.url === '/hmr');
        await new Promise((r) => setTimeout(r, 100));
        writeFileSync(join(dir, 'index.html'), '<p>2</p>');
        await new Promise((r) => setTimeout(r, 500));
        assert.doesNotMatch(events, /event: reload/);
        s.destroy();
        es.destroy();
    });
});
