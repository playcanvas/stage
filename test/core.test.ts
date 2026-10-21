import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

const HOME = mkdtempSync(join(tmpdir(), 'da-test-'));
process.env.STAGE_DIR = HOME;
const { startDaemon } = await import('../plugins/playcanvas-stage/server/daemon.ts');
const { findTitle, unwrap, wrapHtml } = await import('../plugins/playcanvas-stage/server/wrap.ts');
const { agentStatus } = await import('../plugins/playcanvas-stage/server/store.ts');
const { AGENT_WORK_MS } = await import('../plugins/playcanvas-stage/server/constants.ts');

type Res = { status: number; body: any; headers: Record<string, unknown> };
const http = (
    port: number,
    method: string,
    path: string,
    opts: { host?: string; headers?: Record<string, string>; body?: unknown; raw?: string } = {}
) =>
    new Promise<Res>((ok) => {
        const data =
            opts.raw !== undefined
                ? Buffer.from(opts.raw)
                : opts.body === undefined
                  ? undefined
                  : Buffer.from(JSON.stringify(opts.body));
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
        req.end(data);
    });

describe('wrap', () => {
    test('wraps a fragment once and re-wrapping does not nest', () => {
        const w = wrapHtml('<title>A</title><p>x</p>');
        assert.ok(w.startsWith('<!doctype html><html><head><meta charset=utf8>'));
        assert.equal(wrapHtml(w), w);
        assert.equal(unwrap(w), '<title>A</title><p>x</p>');
    });
    test('title scan stops at 8KB and at an svg', () => {
        assert.equal(findTitle('<title> Two  Words </title>'), 'Two Words');
        assert.equal(findTitle(`${' '.repeat(9000)}<title>late</title>`), undefined);
        assert.equal(findTitle('<svg></svg><title>after</title>'), undefined);
    });
    test('wraps a page without adding scripts of its own', () => {
        assert.ok(!wrapHtml('<pre class="mermaid">graph TD; A-->B</pre>').includes('<script'));
        assert.ok(!wrapHtml('<p>plain</p>').includes('frame-runtime'));
    });
});

describe('daemon', () => {
    let d: Awaited<ReturnType<typeof startDaemon>>;
    let id: string;
    let ver: string;
    const agent = (method: string, path: string, body?: unknown) =>
        http(d.port, method, path, { body, headers: { authorization: `Bearer ${d.token}` } });
    const shell = (method: string, path: string, body?: unknown, origin = `http://localhost:${d.port}`) =>
        http(d.port, method, path, { body, headers: { origin } });

    before(async () => {
        d = await startDaemon({ port: 0 });
        const r = await agent('POST', '/_agent/publish', {
            title: 'T',
            html: wrapHtml('<title>T</title><p>hi</p>'),
            capabilities: { db: {} },
            files: { 'css/a.css': { b64: Buffer.from('p{}').toString('base64'), contentType: 'text/css' } }
        });
        assert.equal(r.status, 200);
        ({ id, ver } = r.body);
    });
    after(() => d.close());

    test('rejects foreign hosts, missing tokens and cross-origin writes', async () => {
        assert.equal((await http(d.port, 'GET', '/stages', { host: `evil:${d.port}` })).status, 421);
        assert.equal((await http(d.port, 'GET', '/_agent/stages')).status, 401);
        assert.equal((await shell('POST', `/api/s/${id}/comments`, { text: 'x' }, 'http://evil')).status, 403);
        const f = `${id}.localhost:${d.port}`;
        assert.equal(
            (
                await http(d.port, 'POST', '/_frame/api/db', {
                    host: f,
                    body: { verb: 'get', args: {} },
                    headers: { origin: 'http://evil' }
                })
            ).status,
            403
        );
    });

    test('serves the page on its own origin with the csp and runtime, and blocks traversal', async () => {
        const host = `${id}.localhost:${d.port}`;
        const p = await http(d.port, 'GET', `/v/${ver}/`, { host });
        assert.equal(p.status, 200);
        assert.match(String(p.headers['content-security-policy']), /connect-src 'self'/);
        assert.match(
            p.body,
            /<head><script src="\/_frame\/runtime\.js" data-id="[^"]+" data-ver="[^"]+" data-caps="db"/
        );
        assert.equal((await http(d.port, 'GET', `/v/${ver}/css/a.css`, { host })).body, 'p{}');
        assert.equal((await http(d.port, 'GET', `/v/${ver}/..%2f..%2fmeta.json`, { host })).status, 404);
        assert.equal((await http(d.port, 'GET', `/v/${ver}/../../meta.json`, { host })).status, 404);
    });

    test('refuses a publish built on an older version unless forced', async () => {
        const b = await agent('POST', '/_agent/publish', {
            id,
            baseVersion: ver,
            title: 'T',
            html: wrapHtml('<title>T</title><p>v2</p>')
        });
        assert.equal(b.body.seq, 2);
        const stale = await agent('POST', '/_agent/publish', {
            id,
            baseVersion: ver,
            title: 'T',
            html: wrapHtml('<p>v3</p>')
        });
        assert.equal(stale.status, 409);
        assert.equal(stale.body.live.seq, 2);
        const forced = await agent('POST', '/_agent/publish', {
            id,
            baseVersion: ver,
            force: true,
            title: 'T',
            html: wrapHtml('<p>v3</p>')
        });
        assert.equal(forced.body.seq, 3);
        // the css file is carried into every later version
        assert.equal(forced.body.meta.versions.at(-1).files[0].path, 'css/a.css');
    });

    test('carried files are hard links; replaced files are fresh', async () => {
        const b64 = (s: string) => Buffer.from(s).toString('base64');
        const a = await agent('POST', '/_agent/publish', {
            title: 'L',
            html: wrapHtml('<title>L</title><p>1</p>'),
            files: {
                'models/m.glb': { b64: b64('glTF-bytes'), contentType: 'model/gltf-binary' },
                'r.css': { b64: b64('p{}'), contentType: 'text/css' }
            }
        });
        const b = await agent('POST', '/_agent/publish', {
            id: a.body.id,
            baseVersion: a.body.ver,
            title: 'L',
            html: wrapHtml('<title>L</title><p>2</p>'),
            files: { 'r.css': { b64: b64('p{color:red}'), contentType: 'text/css' } }
        });
        const at = (ver: string, p: string) => statSync(join(HOME, 'stages', a.body.id, 'v', ver, p));
        assert.equal(at(b.body.ver, 'models/m.glb').ino, at(a.body.ver, 'models/m.glb').ino);
        assert.notEqual(at(b.body.ver, 'r.css').ino, at(a.body.ver, 'r.css').ino);
        assert.equal(
            readFileSync(join(HOME, 'stages', a.body.id, 'v', b.body.ver, 'models/m.glb'), 'utf8'),
            'glTF-bytes'
        );
    });

    test('a replaced file never rewrites the previous version, even under a case variant', async () => {
        const b64 = (s: string) => Buffer.from(s).toString('base64');
        const a = await agent('POST', '/_agent/publish', {
            title: 'C',
            html: wrapHtml('<title>C</title>'),
            files: { 'models/Lamp.glb': { b64: b64('v1-bytes'), contentType: 'model/gltf-binary' } }
        });
        await agent('POST', '/_agent/publish', {
            id: a.body.id,
            baseVersion: a.body.ver,
            title: 'C',
            html: wrapHtml('<title>C</title><p>2</p>'),
            files: { 'models/lamp.glb': { b64: b64('v2-bytes'), contentType: 'model/gltf-binary' } }
        });
        assert.equal(
            readFileSync(join(HOME, 'stages', a.body.id, 'v', a.body.ver, 'models/Lamp.glb'), 'utf8'),
            'v1-bytes'
        );
    });

    test('page db writes need the declared capability and a same-origin request', async () => {
        const host = `${id}.localhost:${d.port}`;
        const origin = `http://${host}`;
        const w = await http(d.port, 'POST', '/_frame/api/db', {
            host,
            headers: { origin },
            body: { verb: 'set', args: { collection: 'items', doc_id: 'a', data: { n: 1 } } }
        });
        assert.equal(w.body.version, 1);
        assert.equal((await http(d.port, 'GET', '/_frame/api/user', { host })).status, 403);
    });

    test('the page api checks db writes, uploads, comments and bodies as the agent api does', async () => {
        const p = await agent('POST', '/_agent/publish', {
            title: 'C',
            html: wrapHtml('<title>C</title>'),
            capabilities: { db: {}, assets: {} }
        });
        const host = `${p.body.id}.localhost:${d.port}`;
        const frame = (path: string, opts: { body?: unknown; raw?: string; headers?: Record<string, string> }) =>
            http(d.port, 'POST', path, { ...opts, host, headers: { origin: `http://${host}`, ...opts.headers } });
        const code = async (verb: string, args: unknown) =>
            (await frame('/_frame/api/db', { body: { verb, args } })).body.error?.code;
        assert.equal(await code('set', { collection: 'a/b', doc_id: 'x', data: {} }), 'invalid_argument');
        assert.equal(await code('set', { collection: 'items', doc_id: '..', data: {} }), 'invalid_argument');
        assert.equal(
            await code('batch', { writes: [{ op: 'nope', collection: 'items', doc_id: 'x' }] }),
            'invalid_argument'
        );
        assert.equal(await code('set', { collection: 'items', doc_id: 's', data: { t: 'aaa' } }), undefined);
        assert.equal(
            await code('str_replace', {
                collection: 'items',
                doc_id: 's',
                field: 't',
                old_str: '',
                new_str: 'b',
                replace_all: true
            }),
            'invalid_argument'
        );
        assert.equal(
            await code('set', { collection: 'items', doc_id: 'big', data: { t: 'x'.repeat(1024 * 1024) } }),
            'too_large'
        );
        assert.equal((await frame('/_frame/api/db', { body: { verb: 'whoami' } })).status, 403);
        assert.equal(
            (await frame('/_frame/api/db', { raw: '{', headers: { 'content-type': 'application/json' } })).status,
            400
        );
        const up = await frame('/_frame/api/assets', {
            raw: 'MZ',
            headers: { 'content-type': 'application/x-msdownload' }
        });
        assert.equal(up.status, 415);
        assert.equal((await shell('POST', `/api/s/${id}/comments`, { text: 'x'.repeat(16385) })).status, 413);
    });

    test('a republish that only adds a label mints a version', async () => {
        const html = wrapHtml('<title>L</title>');
        const a = await agent('POST', '/_agent/publish', { title: 'L', html });
        const b = await agent('POST', '/_agent/publish', { id: a.body.id, title: 'L', html, label: 'named' });
        assert.equal(b.body.unchanged, undefined);
        assert.equal(b.body.seq, 2);
    });

    test('comment threads: activation gates the agent flow', async () => {
        const t = await shell('POST', `/api/s/${id}/comments`, { text: 'make it blue', anchor: { path: 'p' } });
        assert.equal(t.status, 200);
        assert.equal(t.body.agent_activated_at, undefined);
        const s = await shell('POST', `/api/s/${id}/comments/${t.body.id}/send`);
        assert.ok(s.body.agent_activated_at);
        assert.ok(s.body.comments[0].to_agent_at);
        const p = await agent('POST', '/_agent/pending');
        assert.equal(p.body[0].count, 1);
        assert.equal((await agent('POST', '/_agent/pending')).body.length, 0);
        const m = await shell('POST', `/api/s/${id}/comments/${t.body.id}`, { text: '@agent also bigger' });
        assert.ok(m.body.comments[1].to_agent_at);
    });

    test('a comment keeps its Shift+clicked extra anchors, bounded', async () => {
        const also = Array.from({ length: 12 }, (_, i) => ({
            path: `li:nth-child(${i + 1})`,
            label: `Item ${i + 1}`,
            snippet: '<li>',
            junk: 'x'
        }));
        const t = await shell('POST', `/api/s/${id}/comments`, {
            text: 'these three',
            anchor: { path: 'ul > li', also: [...also, { label: 'no path' }] }
        });
        assert.equal(t.body.anchor.also.length, 8);
        assert.deepEqual(t.body.anchor.also[0], { path: 'li:nth-child(1)', label: 'Item 1', snippet: '<li>' });
    });

    test('area and click comments keep a checked capture beside the thread, served to the viewer and the agent', async () => {
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            'base64'
        );
        const url = `data:image/png;base64,${png.toString('base64')}`;
        const anchor = { path: 'canvas', region: { x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.5 } };
        const t = await shell('POST', `/api/s/${id}/comments`, { text: 'shadow looks off', anchor, image: url });
        assert.deepEqual(t.body.anchor.image, { type: 'image/png' });
        const img = await http(d.port, 'GET', `/api/s/${id}/comments/${t.body.id}/image`);
        assert.equal(img.status, 200);
        assert.equal(img.headers['content-type'], 'image/png');
        assert.equal(
            (await agent('GET', `/_agent/s/${id}/comments/${t.body.id}/image`)).body.b64,
            png.toString('base64')
        );
        const fake = await shell('POST', `/api/s/${id}/comments`, {
            text: 'x',
            anchor,
            image: `data:image/webp;base64,${png.toString('base64')}`
        });
        assert.equal(fake.body.anchor.image, undefined);
        const click = await shell('POST', `/api/s/${id}/comments`, {
            text: 'x',
            anchor: { path: 'canvas' },
            image: url
        });
        assert.deepEqual(click.body.anchor.image, { type: 'image/png' });
        const loose = await shell('POST', `/api/s/${id}/comments`, { text: 'x', image: url });
        assert.equal(loose.body.anchor?.image, undefined);
        const multi = await shell('POST', `/api/s/${id}/comments`, {
            text: 'these',
            anchor: {
                path: 'canvas',
                also: [
                    { path: 'canvas', snippet: 'a' },
                    { path: 'canvas', snippet: 'b' }
                ]
            },
            image: url,
            also_images: [null, url]
        });
        assert.deepEqual(
            multi.body.anchor.also.map((x: any) => x.image),
            [undefined, { type: 'image/png' }]
        );
        assert.equal((await http(d.port, 'GET', `/api/s/${id}/comments/${multi.body.id}/image/2`)).status, 200);
        assert.equal((await http(d.port, 'GET', `/api/s/${id}/comments/${multi.body.id}/image/1`)).status, 404);
        assert.equal(
            (await agent('GET', `/_agent/s/${id}/comments/${multi.body.id}/image/2`)).body.b64,
            png.toString('base64')
        );
        await shell('DELETE', `/api/s/${id}/comments/${t.body.id}`);
        assert.equal((await http(d.port, 'GET', `/api/s/${id}/comments/${t.body.id}/image`)).status, 404);
    });

    test('comments and replies keep attached images, checked and bounded, served to the viewer and the agent', async () => {
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            'base64'
        );
        const url = `data:image/png;base64,${png.toString('base64')}`;
        const t = await shell('POST', `/api/s/${id}/comments`, { text: 'like this', images: [url, url] });
        const [c] = t.body.comments;
        assert.deepEqual(c.images, [{ type: 'image/png' }, { type: 'image/png' }]);
        const img = await http(d.port, 'GET', `/api/s/${id}/comments/${t.body.id}/attachment/${c.id}/1`);
        assert.equal(img.status, 200);
        assert.equal(img.headers['content-type'], 'image/png');
        assert.equal(
            (await agent('GET', `/_agent/s/${id}/comments/${t.body.id}/attachment/${c.id}/0`)).body.b64,
            png.toString('base64')
        );
        assert.equal(
            (await http(d.port, 'GET', `/api/s/${id}/comments/${t.body.id}/attachment/${c.id}/2`)).status,
            404
        );
        const r = await shell('POST', `/api/s/${id}/comments/${t.body.id}`, { text: 'and this', images: [url] });
        const reply = r.body.comments.at(-1);
        assert.deepEqual(reply.images, [{ type: 'image/png' }]);
        assert.equal(
            (await http(d.port, 'GET', `/api/s/${id}/comments/${t.body.id}/attachment/${reply.id}/0`)).status,
            200
        );
        const fake = `data:image/webp;base64,${png.toString('base64')}`;
        assert.equal((await shell('POST', `/api/s/${id}/comments`, { text: 'x', images: [fake] })).status, 400);
        assert.equal(
            (await shell('POST', `/api/s/${id}/comments/${t.body.id}`, { text: 'x', images: Array(5).fill(url) }))
                .status,
            400
        );
        await shell('DELETE', `/api/s/${id}/comments/${t.body.id}`);
        assert.equal(
            (await http(d.port, 'GET', `/api/s/${id}/comments/${t.body.id}/attachment/${c.id}/0`)).status,
            404
        );
    });

    test('agent status: queued until delivered, working until answered', async () => {
        const status = async (tid: string) =>
            (await shell('GET', `/api/s/${id}/comments`)).body.threads.find((t: { id: string }) => t.id === tid).agent;
        const t = await shell('POST', `/api/s/${id}/comments`, {
            text: 'bigger title',
            anchor: { path: 'h1' },
            toAgent: true
        });
        assert.equal((await status(t.body.id)).status, 'queued');
        await agent('POST', '/_agent/pending');
        const w = await status(t.body.id);
        assert.equal(w.status, 'working');
        assert.ok(Date.parse(w.until) > Date.now());
        await agent('POST', `/_agent/s/${id}/comments/${t.body.id}/reply`, { text: 'done' });
        assert.equal(await status(t.body.id), undefined);
        await shell('POST', `/api/s/${id}/comments/${t.body.id}`, { text: '@agent and bold' });
        assert.equal((await status(t.body.id)).status, 'queued');
        await agent('GET', `/_agent/s/${id}/comments`);
        assert.equal((await status(t.body.id)).status, 'working');
    });

    test('deleting a thread the agent is on withdraws it in the next notice, once', async () => {
        const send = async () =>
            (await shell('POST', `/api/s/${id}/comments`, { text: 'redo', anchor: { path: 'p' }, toAgent: true })).body
                .id;
        await agent('POST', '/_agent/pending');
        const queued = await send();
        await shell('DELETE', `/api/s/${id}/comments/${queued}`);
        assert.equal((await agent('POST', '/_agent/pending')).body.length, 0, 'never heard of, nothing to withdraw');
        const working = await send();
        await agent('POST', '/_agent/pending');
        await shell('DELETE', `/api/s/${id}/comments/${working}`);
        const p = await agent('POST', '/_agent/pending');
        assert.deepEqual(
            p.body.map((x: any) => [x.id, x.count, x.withdrawn]),
            [[id, 0, [working]]]
        );
        assert.equal((await agent('POST', '/_agent/pending')).body.length, 0);
        const answered = await send();
        await agent('POST', '/_agent/pending');
        await agent('POST', `/_agent/s/${id}/comments/${answered}/reply`, { text: 'done' });
        await shell('DELETE', `/api/s/${id}/comments/${answered}`);
        assert.equal((await agent('POST', '/_agent/pending')).body.length, 0, 'answered, nothing to withdraw');
    });

    test('presence: a linked session is open, watching while its monitor polls, and hears only of its stages', async () => {
        const state = async (a: string) => (await shell('GET', `/api/s/${a}`)).body.presence;
        const other = (
            await agent('POST', '/_agent/publish', { title: 'O', html: wrapHtml('<title>O</title><p>o</p>') })
        ).body.id;
        await agent('POST', '/_agent/pending');
        assert.equal(await state(id), 'none');
        assert.equal((await agent('POST', '/_agent/presence', { stages: [id] })).status, 400);
        await agent('POST', '/_agent/presence', { host: 4242, stages: [id, 'not-a-uuid'] });
        await agent('POST', '/_agent/presence', { host: 4242, stages: [] });
        assert.equal(await state(id), 'open');
        assert.equal(await state(other), 'none');
        for (const a of [id, other]) {
            await shell('POST', `/api/s/${a}/comments`, { text: 'bigger', anchor: { path: 'p' }, toAgent: true });
        }
        const mine = await agent('POST', '/_agent/pending', { host: 4242, watch: true });
        assert.deepEqual(
            mine.body.map((p: any) => p.id),
            [id]
        );
        assert.equal(await state(id), 'watching');
        assert.deepEqual(
            (await agent('POST', '/_agent/pending', { host: 999 })).body.map((p: any) => p.id),
            [other]
        );
        await shell('POST', `/api/s/${id}/comments`, { text: 'again', anchor: { path: 'p' }, toAgent: true });
        await agent('GET', `/_agent/s/${id}/comments`);
        assert.equal((await agent('POST', '/_agent/pending', { host: 4242, watch: true })).body.length, 0);
    });

    test('a drawn area keeps a bounded region and what it covers; a bad region is dropped', async () => {
        const inside = Array.from({ length: 20 }, (_, i) => `<li>${'x'.repeat(300)}${i}`);
        const t = await shell('POST', `/api/s/${id}/comments`, {
            text: 'these',
            anchor: { path: 'ul', snippet: '<ul>', region: { x0: 0.12345, y0: 0, x1: 0.5, y1: 1, extra: 1 }, inside }
        });
        assert.deepEqual(t.body.anchor.region, { x0: 0.123, y0: 0, x1: 0.5, y1: 1 });
        assert.equal(t.body.anchor.inside.length, 16);
        assert.equal(t.body.anchor.inside[0].length, 200);
        for (const region of [
            { x0: 0.5, y0: 0, x1: 0.5, y1: 1 },
            { x0: -1, y0: 0, x1: 0.5, y1: 1 },
            { x0: 0, y0: 0, x1: 0.5 },
            'x'
        ]) {
            const b = await shell('POST', `/api/s/${id}/comments`, {
                text: 'bad',
                anchor: { path: 'ul', region, inside }
            });
            assert.equal(b.body.anchor.region, undefined);
            assert.equal(b.body.anchor.inside, undefined);
        }
        const q = await shell('POST', `/api/s/${id}/comments`, {
            text: 'quote wins',
            anchor: { path: 'p', span: { quote: 'hi' }, region: { x0: 0, y0: 0, x1: 1, y1: 1 } }
        });
        assert.equal(q.body.anchor.region, undefined);
    });
});

test('comment monitors run an existing script when an existing skill loads', () => {
    const root = join(import.meta.dirname, '..', 'plugins', 'playcanvas-stage');
    const monitors = JSON.parse(readFileSync(join(root, 'monitors', 'monitors.json'), 'utf8'));
    const skills = ['stage-design'];
    assert.deepEqual(
        new Set(monitors.map((m: { when: string }) => m.when)),
        new Set(skills.flatMap((s) => [`on-skill-invoke:${s}`, `on-skill-invoke:playcanvas-stage:${s}`]))
    );
    for (const m of monitors) {
        const script = m.command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/(\S+?)"/)[1];
        assert.ok(existsSync(join(root, script)));
        assert.ok(
            existsSync(join(root, 'skills', m.when.replace(/^on-skill-invoke:(playcanvas-stage:)?/, ''), 'SKILL.md'))
        );
    }
});

test('agent status: waiting once the work window passes, none once resolved', () => {
    const sent = '2026-01-01T00:00:00.000Z';
    const t = {
        id: 't',
        created_at: sent,
        comments: [
            { id: 'c', author: 'user' as const, text: 'x', created_at: sent, to_agent_at: sent, delivered_at: sent }
        ]
    };
    const at = Date.parse(sent);
    assert.equal(agentStatus(t, at + AGENT_WORK_MS - 1)?.status, 'working');
    assert.equal(agentStatus(t, at + AGENT_WORK_MS)?.status, 'waiting');
    assert.equal(agentStatus({ ...t, resolved_at: sent }, at), undefined);
});

// claude code sets only CLAUDE_PLUGIN_ROOT, and codex sets it too; a bare $PLUGIN_ROOT breaks the hook in claude code
test('comment hook runs an existing script from the plugin root both CLIs set', () => {
    const root = join(import.meta.dirname, '..', 'plugins', 'playcanvas-stage');
    const [h] = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8')).hooks.UserPromptSubmit[0].hooks;
    const script = h.command.match(/"\$\{CLAUDE_PLUGIN_ROOT\}\/(\S+?)"/)[1];
    assert.ok(existsSync(join(root, script)));
});

describe('mcp over stdio', () => {
    const port = 40000 + Math.floor(Math.random() * 20000);
    const env = { ...process.env, STAGE_DIR: HOME, STAGE_PORT: String(port), STAGE_AUTO_OPEN: '0' };
    const proc = spawn(
        process.execPath,
        [join(import.meta.dirname, '..', 'plugins', 'playcanvas-stage', 'server', 'mcp.ts')],
        {
            env,
            stdio: ['pipe', 'pipe', 'inherit']
        }
    );
    let buf = '';
    let n = 0;
    const waiting = new Map<number, (m: any) => void>();
    proc.stdout.on('data', (d) => {
        buf += d;
        for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
            const m = JSON.parse(buf.slice(0, i));
            waiting.get(m.id)?.(m);
        }
    });
    const rpc = (method: string, params?: unknown) =>
        new Promise<any>((ok) => {
            waiting.set(++n, ok);
            proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
        });
    const call = async (name: string, args: unknown) => (await rpc('tools/call', { name, arguments: args })).result;
    const out = (r: any) => r.content.map((c: any) => c.text ?? '').join('\n');

    after(() => {
        proc.kill();
        const s = JSON.parse(readFileSync(join(HOME, 'server.json'), 'utf8'));
        process.kill(s.pid);
    });

    test('lists the four tools with strict schemas', async () => {
        const init = await rpc('initialize', {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 't', version: '0' }
        });
        assert.match(init.result.instructions, /stage-design/);
        const { tools } = (await rpc('tools/list')).result;
        assert.deepEqual(
            tools.map((t: any) => t.name),
            ['Stage', 'StageComments', 'StageData', 'StageCheck']
        );
        assert.ok(tools.every((t: any) => t.inputSchema.additionalProperties === false));
        const r = await call('StageData', { action: 'get', nope: 1 });
        assert.equal(r.isError, true);
    });

    test('publish, conflict refusal, reply gate', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'da-page-'));
        const page = join(dir, 'page.html');
        writeFileSync(page, '<title>Test Page</title><p>one</p>');
        const pub = out(await call('Stage', { file_path: page, icon: 'doc' }));
        assert.match(pub, /Published .* at (http:\/\/localhost:\d+\/stage\/[0-9a-f-]{36}) \(Version 1/);
        const url = pub.match(/at (\S+) \(/)![1];
        const id = url.split('/').at(-1);

        // a newer version saved elsewhere makes the next publish from this session a refusal
        const s = JSON.parse(readFileSync(join(HOME, 'server.json'), 'utf8'));
        await http(port, 'POST', '/_agent/publish', {
            headers: { authorization: `Bearer ${s.token}` },
            body: { id, title: 'Test Page', html: wrapHtml('<title>Test Page</title><p>two</p>') }
        });
        writeFileSync(page, '<title>Test Page</title><p>three</p>');
        const refused = await call('Stage', { file_path: page });
        assert.equal(refused.isError, true);
        assert.match(out(refused), /Publish refused — nothing was merged or published: version 2 is live/);
        assert.match(out(await call('Stage', { file_path: page })), /Version 3/);

        const t = await http(port, 'POST', `/api/s/${id}/comments`, {
            headers: { origin: `http://localhost:${port}` },
            body: { text: 'hello' }
        });
        const denied = await call('StageComments', { action: 'reply', url, thread_id: t.body.id, text: 'hi' });
        assert.match(out(denied), /Reply not posted: the agent is not currently activated/);
        await http(port, 'POST', `/api/s/${id}/comments/${t.body.id}/send`, {
            headers: { origin: `http://localhost:${port}` }
        });
        const read = out(await call('StageComments', { action: 'read', url }));
        assert.match(read, /=== BEGIN STAGE COMMENTS (\w{8}) —/);
        assert.match(read, /sent to you — awaiting reply/);
        assert.match(
            out(await call('StageComments', { action: 'reply', url, thread_id: t.body.id, text: 'done' })),
            /Replied to comment thread/
        );
        assert.match(
            out(await call('StageComments', { action: 'reply', url, thread_id: t.body.id, text: 'again' })),
            /already stands/
        );
        assert.match(
            out(await call('StageComments', { action: 'resolve', url, thread_id: t.body.id })),
            /Marked comment thread .* resolved/
        );

        const area = {
            path: 'ul',
            label: 'Plans',
            snippet: '<ul class="plans">',
            region: { x0: 0, y0: 0.2, x1: 1, y1: 0.6 },
            inside: ['<li>Basic', '<li>Pro']
        };
        const r = await http(port, 'POST', `/api/s/${id}/comments`, {
            headers: { origin: `http://localhost:${port}` },
            body: { text: 'make these match', anchor: area }
        });
        const one = out(await call('StageComments', { action: 'read', url, thread_id: r.body.id }));
        assert.match(
            one,
            /\n {2}\[region of\] ul\n {2}\[anchored element\] <ul class="plans">\n {2}\[inside region\] <li>Basic\n {2}\[inside region\] <li>Pro\n/
        );
        assert.doesNotMatch(one, /\n {2}\[anchored at\]/);
        assert.match(one, /over part of which the commenter drew a rectangle/);

        // images attached to a comment ride along with the read, labelled by thread, comment and image
        const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        const ref = await http(port, 'POST', `/api/s/${id}/comments`, {
            headers: { origin: `http://localhost:${port}` },
            body: { text: 'match this look', images: [`data:image/png;base64,${png}`], toAgent: true }
        });
        const seen = await call('StageComments', { action: 'read', url, thread_id: ref.body.id });
        assert.match(
            out(seen),
            /\| match this look\n {2}\[attached image\] attached after this listing, labelled with this thread's id and "comment #1, image #1"/
        );
        assert.match(out(seen), /\[attached image\] marks a reference image the commenter attached/);
        const shot = seen.content.findIndex((c: any) => c.type === 'image');
        assert.match(seen.content[shot - 1].text, new RegExp(`thread ${ref.body.id}, comment #1, image #1`));
        assert.deepEqual([seen.content[shot].mimeType, seen.content[shot].data], ['image/png', png]);
    });

    test('attaches to a dev server by its url and project root, and says when it is down', async () => {
        const root = mkdtempSync(join(tmpdir(), 'da-app-'));
        const srv = createServer((_q, r) => r.writeHead(200, { 'content-type': 'text/html' }).end('<p>app</p>'));
        await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
        const up = (srv.address() as AddressInfo).port;
        const pub = out(await call('Stage', { url: `http://localhost:${up}/?level=1`, root, title: 'Game' }));
        assert.match(pub, /Attached Stage to the dev server at http:\/\/localhost:\d+\/\?level=1/);
        assert.match(pub, /It answered/);
        const url = pub.match(/(http:\/\/localhost:\d+\/stage\/[0-9a-f-]{36})/)![1];
        const read = out(await call('Stage', { action: 'read', url }));
        assert.match(read, /live app/);
        assert.ok(read.includes(root));
        await new Promise((r) => srv.close(r));
        const again = out(await call('Stage', { url: `http://localhost:${up}/?level=1`, root, title: 'Game' }));
        assert.ok(again.includes(url), 'the same project page is the same stage');
        assert.match(again, /not answering/);
        assert.match(again, /start it/);

        // a dev server needs a project root, and only loopback hosts are attached
        assert.equal((await call('Stage', { url: `http://localhost:${up}/` })).isError, true);
        assert.match(out(await call('Stage', { url: 'http://example.com/', root })), /loopback/);
        assert.match(
            out(await call('Stage', { url: `http://localhost:${up}/`, root: '/etc' })),
            /outside the working directory/
        );
    });
});
