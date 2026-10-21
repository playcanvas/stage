// live stages in a real browser: each fixture on its own dev server, attached and shown through stage
// first, so the stage folder is the test's own before chrome.ts loads the server
import './home.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { chrome, launch } from './chrome.ts';

const { startDaemon } = await import('../plugins/playcanvas-stage/server/daemon.ts');

const FIX = join(import.meta.dirname, 'fixtures', 'live');
const BIN = join(import.meta.dirname, '..', 'node_modules', '.bin');

const copy = (name: string) => {
    const dir = mkdtempSync(join(tmpdir(), `stage-fix-${name}-`));
    cpSync(join(FIX, name), dir, { recursive: true });
    return dir;
};
const freePort = () =>
    new Promise<number>((ok) => {
        const s = createServer().listen(0, '127.0.0.1', () => {
            const p = (s.address() as AddressInfo).port;
            s.close(() => ok(p));
        });
    });
const get = (port: number, path = '/') =>
    new Promise<string>((ok, bad) =>
        request({ host: '127.0.0.1', port, path }, (r) => {
            let b = '';
            r.on('data', (c) => (b += c)).on('end', () => ok(b));
        })
            .on('error', bad)
            .end()
    );

// http-server, as a person would run it: its own process, which stage never starts or stops
const httpServer = async (dir: string, port: number) => {
    const p = spawn(join(BIN, 'http-server'), [dir, '-p', String(port), '-a', '127.0.0.1', '-c-1', '-s'], {
        stdio: 'ignore'
    });
    for (let i = 0; i < 100; i++) {
        if (
            await get(port).then(
                () => true,
                () => false
            )
        ) {
            return p;
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('http-server did not start');
};

describe('live stages in the browser', { skip: !chrome && 'no Chrome' }, () => {
    let d: Awaited<ReturnType<typeof startDaemon>>;
    let b: Awaited<ReturnType<typeof launch>>;
    const procs: ChildProcess[] = [];
    const closers: (() => Promise<unknown> | void)[] = [];
    const attach = async (url: string, root: string) => {
        const r = await fetch(`http://127.0.0.1:${d.port}/_agent/publish`, {
            method: 'POST',
            headers: { authorization: `Bearer ${d.token}` },
            body: JSON.stringify({ title: 'App', live: { url, root } })
        }).then((x) => x.json());
        return r as { id: string; reachable: boolean; url: string };
    };
    const frameUrl = (id: string, path = '/') => `http://${id}.localhost:${d.port}${path}`;
    const runtime = 'document.querySelector(\'script[src="/_frame/runtime.js"][data-live="1"]\') && !!window.agent';

    before(async () => {
        d = await startDaemon({ port: 0 });
        b = await launch();
    });
    after(async () => {
        for (const p of procs) {
            p.kill();
        }
        for (const c of closers) {
            await c();
        }
        await b.close();
        await d.close();
    });

    test('a Vite project shows with the runtime, and its own HMR updates through the proxy', async () => {
        const { createServer: vite } = await import('vite');
        const root = copy('vite');
        const srv = await vite({ root, configFile: false, logLevel: 'silent', server: { port: 0, host: '127.0.0.1' } });
        await srv.listen();
        closers.push(() => srv.close());
        const port = (srv.httpServer!.address() as AddressInfo).port;
        const s = await attach(`http://localhost:${port}/`, root);
        assert.equal(s.reachable, true);
        const p = await b.open(frameUrl(s.id));
        await p.until(runtime);
        await p.until('document.getElementById("m")?.dataset.ready === "1"');
        await p.until('getComputedStyle(document.documentElement).getPropertyValue("--v").trim() === "1"');
        writeFileSync(join(root, 'style.css'), ':root {\n    --v: 2;\n}\n');
        await p.until('getComputedStyle(document.documentElement).getPropertyValue("--v").trim() === "2"');
        assert.equal(await p.evaluate('sessionStorage.loads'), '1', 'a hot update, not a reload');
        await p.close();

        // the dev server keeps working in its own tab alongside
        const own = await b.open(`http://localhost:${port}/`);
        await own.until('document.getElementById("m")?.dataset.ready === "1"');
        assert.equal(await own.evaluate('!!window.agent'), false);
        await own.close();
    });

    test('an Express server shows with the runtime and reloads on a file change', async () => {
        const { default: express } = await import('express');
        const root = copy('express');
        const srv = express().use(express.static(root)).listen(0, '127.0.0.1');
        await new Promise((r) => srv.once('listening', r));
        closers.push(() => new Promise((r) => srv.close(r)));
        const port = (srv.address() as AddressInfo).port;
        const s = await attach(`http://127.0.0.1:${port}/`, root);
        const p = await b.open(frameUrl(s.id));
        await p.until(runtime);
        await p.until('document.getElementById("m")?.textContent === "one"');
        await new Promise((r) => setTimeout(r, 200));
        writeFileSync(join(root, 'index.html'), '<!doctype html>\n<title>Express fixture</title>\n<p id="m">two</p>\n');
        await p.until('document.getElementById("m")?.textContent === "two"');
        await p.close();
    });

    test('a device frame gives the app its viewport, rotates and fits in place and is kept per stage', async () => {
        const { default: express } = await import('express');
        const root = copy('express');
        const srv = express().use(express.static(root)).listen(0, '127.0.0.1');
        await new Promise((r) => srv.once('listening', r));
        closers.push(() => new Promise((r) => srv.close(r)));
        const s = await attach(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/`, root);
        const viewer = await b.open(s.url);
        const app = await viewer.frame(frameUrl(s.id));
        await app.until('document.getElementById("m")?.textContent === "one"');
        await app.evaluate('window.kept = 1');

        const pick = (v: string) =>
            viewer.evaluate(
                `document.querySelector('#device-menu input[name="device"][value=${JSON.stringify(v)}]').click()`
            );
        // the device menu's sections, shown only where they apply
        const setHidden = (name: string) =>
            `document.querySelector('#device-menu input[name="${name}"]').closest('fieldset').hidden`;

        // a web lens shows snapchat's controls sketched over it, as in the carousel or full screen, in portrait only
        const guides = 'document.querySelector(".device-guides").checkVisibility()';
        const view = (v: string) =>
            viewer.evaluate(
                `document.querySelector('#device-menu input[name="guides"][value=${JSON.stringify(v)}]').click()`
            );
        const icons = () => viewer.evaluate<number>('document.querySelectorAll(".device-guides .icon").length');
        // a zoomed frame snaps to whole screen pixels, so shrunk to fit, the app's viewport can read a pixel short
        const near = (w: number, h: number) => `Math.abs(innerWidth - ${w}) <= 1 && Math.abs(innerHeight - ${h}) <= 1`;
        await pick('lens');
        await app.until(near(360, 640));
        assert.equal(await viewer.evaluate(guides), true, 'in the carousel by default');
        const [g, f] = await viewer.evaluate<number[][]>(
            '[".device-guides", ".frame-wrap iframe"].map((q) => { const r = document.querySelector(q).getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })'
        );
        assert.deepEqual(g, f, 'over the frame, at its scale');
        const carousel = await icons();
        await view('full');
        assert.equal(await icons(), 1, 'full screen, only the close button');
        assert.ok(carousel > 1);
        assert.equal(await viewer.evaluate(setHidden('land')), true, 'a web lens is portrait only');
        await view('off');
        assert.equal(await viewer.evaluate(guides), false);
        assert.match(await viewer.evaluate<string>(`localStorage.getItem("stage.device:${s.id}")`), /:off$/);
        await view('carousel');

        await pick('iphone');
        assert.equal(await viewer.evaluate(setHidden('guides')), true, 'snapchat guides for a web lens only');
        assert.equal(await viewer.evaluate(guides), false);
        await app.until(near(390, 844));
        assert.match(
            await viewer.evaluate<string>('document.querySelector(".device-size").textContent'),
            /^390 × 844 · \d+%$/
        );

        // a drag from beside the device selects nothing of the viewer's: not the frame, nor the text around it
        const [fl, ft] = await viewer.evaluate<number[]>(
            '(() => { const r = document.querySelector(".frame-wrap iframe").getBoundingClientRect(); return [r.left, r.top]; })()'
        );
        const label = await viewer.evaluate<number[]>(
            '(() => { const r = document.querySelector(".device-size").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()'
        );
        await viewer.drag([fl - 20, ft + 100], label);
        assert.equal(await viewer.evaluate('getSelection().toString()'), '');
        assert.equal(
            await viewer.evaluate('getSelection().containsNode(document.querySelector("iframe"), true)'),
            false
        );
        await viewer.evaluate('document.querySelector(\'#device-menu input[name="land"][value="true"]\').click()');
        await app.until('innerWidth === 844 && innerHeight === 390');
        const size = () => viewer.evaluate<string>('document.querySelector(".device-size").textContent');
        assert.equal(await size(), '844 × 390', 'actual size when it fits');

        // fit to screen scales it up to the space, the app's viewport unchanged
        await viewer.evaluate('document.querySelector(\'#device-menu input[name="fit"][value="true"]\').click()');
        await viewer.until('/^844 × 390 · 1\\d\\d%$/.test(document.querySelector(".device-size").textContent)');
        assert.equal(await app.evaluate('innerWidth'), 844);
        assert.equal(await app.evaluate('window.kept'), 1, 'resized in place, not reloaded');

        // and the page renders as it would at that size: a backdrop-filter blurs what is under it, here a webgl canvas's
        // stripes to grey (a scaled frame loses a canvas's backdrop in chrome)
        await app.evaluate(`(() => {
            const c = Object.assign(document.createElement('canvas'), { id: 'stripes', width: 844, height: 390 });
            c.style.cssText = 'position:fixed;inset:0';
            const g = c.getContext('webgl');
            const draw = () => {
                if (!c.isConnected) return;
                g.disable(g.SCISSOR_TEST);
                g.clearColor(0, 0, 0, 1);
                g.clear(g.COLOR_BUFFER_BIT);
                g.enable(g.SCISSOR_TEST);
                g.clearColor(1, 1, 1, 1);
                for (let x = 0; x < c.width; x += 12) (g.scissor(x, 0, 6, c.height), g.clear(g.COLOR_BUFFER_BIT));
                requestAnimationFrame(draw);
            };
            const o = document.createElement('div');
            o.style.cssText = 'position:fixed;inset:0;backdrop-filter:blur(8px)';
            document.body.append(c, o);
            draw();
        })()`);
        await new Promise((r) => setTimeout(r, 1000));
        const fr = await viewer.evaluate<number[]>(
            '(() => { const r = document.querySelector(".frame-wrap iframe").getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()'
        );
        const { data } = (await viewer.send('Page.captureScreenshot', {
            format: 'png',
            clip: { x: fr[0] + 40, y: fr[1] + fr[3] / 2, width: fr[2] - 80, height: 1, scale: 1 }
        })) as { data: string };
        const row = await viewer.evaluate<number[]>(`new Promise((ok) => {
            const i = new Image();
            i.onload = () => {
                const x = Object.assign(document.createElement('canvas'), { width: i.width, height: 1 }).getContext('2d');
                x.drawImage(i, 0, 0);
                ok([...x.getImageData(0, 0, i.width, 1).data].filter((_, n) => n % 4 === 0));
            };
            i.src = 'data:image/png;base64,${data}';
        })`);
        assert.ok(Math.min(...row) > 64 && Math.max(...row) < 192, `grey: ${Math.min(...row)}..${Math.max(...row)}`);
        await app.evaluate('document.querySelectorAll("#stripes, #stripes + div").forEach((e) => e.remove())');

        // the comment overlay's pins and outlines undo the scale, so they stay at screen size
        await viewer.evaluate('document.querySelector(".iconbtn.mode").click()');
        await app.until('!!document.querySelector("agent-overlay")');
        const zoom = Number(/(\d+)%$/.exec(await size())![1]) / 100;
        const k = Number(await app.evaluate('document.querySelector("agent-overlay").style.getPropertyValue("--k")'));
        assert.ok(Math.abs(k * zoom - 1) < 0.01, `overlay at 1/${zoom}: ${k}`);
        await viewer.close();

        const again = await b.open(s.url);
        await (await again.frame(frameUrl(s.id))).until('innerWidth === 844');
        assert.equal(
            await again.evaluate('document.querySelector(\'#device-menu input[name="fit"][value="true"]\').checked'),
            true
        );
        assert.equal(
            await again.evaluate('document.querySelector(\'button[popovertarget="device-menu"]\').textContent'),
            'iPhone 844×390',
            'the button names the kept device'
        );
        assert.equal(await again.evaluate(setHidden('guides')), true, 'and the menu shows only its sections');
        await again.evaluate(`document.querySelector('#device-menu input[name="device"][value="responsive"]').click()`);
        await again.until(
            'document.querySelector(".frame-wrap iframe").clientWidth === document.querySelector(".frame-wrap").clientWidth'
        );
        assert.equal(await again.evaluate(setHidden('land')), true, 'no orientation or fit when responsive');
        await again.close();
    });

    test('a page published from the retired scene scaffold still opens and renders', async () => {
        const { wrapHtml } = await import('../plugins/playcanvas-stage/server/wrap.ts');
        const html = readFileSync(join(import.meta.dirname, 'fixtures', 'scaffolded.html'), 'utf8');
        const r = (await fetch(`http://127.0.0.1:${d.port}/_agent/publish`, {
            method: 'POST',
            headers: { authorization: `Bearer ${d.token}` },
            body: JSON.stringify({ title: 'Plinth Study', html: wrapHtml(html), capabilities: { db: {} } })
        }).then((x) => x.json())) as { id: string; ver: string };
        const p = await b.open(frameUrl(r.id, `/v/${r.ver}/`));
        await p.until('!!document.querySelector(".scene[data-scene-ready]")', 30000);
        assert.deepEqual(
            p.logs.filter((l) => /^(error|exception)/.test(l)),
            []
        );
        await p.close();
    });

    test('a page that saves itself keeps running in the viewer', async () => {
        const { wrapHtml } = await import('../plugins/playcanvas-stage/server/wrap.ts');
        const r = (await fetch(`http://127.0.0.1:${d.port}/_agent/publish`, {
            method: 'POST',
            headers: { authorization: `Bearer ${d.token}` },
            body: JSON.stringify({
                title: 'S',
                html: wrapHtml('<title>S</title><p>one</p>'),
                capabilities: { stage: {} }
            })
        }).then((x) => x.json())) as { id: string; url: string };
        const viewer = await b.open(r.url);
        const page = await viewer.frame(frameUrl(r.id));
        await page.until('!!window.agent');
        await page.evaluate('window.kept = 1');
        await page.evaluate(
            "window.agent.use('stage').then((s) => s.publish('<!doctype html><title>S</title><p>two</p>')).then(() => true)"
        );
        await viewer.until('document.querySelectorAll("select.version option").length === 2');
        await new Promise((ok) => setTimeout(ok, 500));
        assert.equal(await page.evaluate('window.kept'), 1);
        await viewer.close();
    });

    test('a single HTML file behind http-server waits while down and attaches when it starts', async () => {
        const root = copy('static');
        const port = await freePort();
        const s = await attach(`http://localhost:${port}/`, root);
        assert.equal(s.reachable, false);
        const viewer = await b.open(s.url);
        await viewer.until('document.querySelector(".live-state") && !document.querySelector(".live-state").hidden');
        assert.match(await viewer.evaluate<string>('document.querySelector(".live-state").textContent'), /Waiting/);
        const p = await b.open(frameUrl(s.id));
        await p.until('document.title === "Waiting for the dev server"');

        const hs = await httpServer(root, port);
        procs.push(hs);
        await p.until('document.getElementById("m")?.textContent === "one"');
        await p.until(runtime);
        await viewer.until('document.querySelector(".live-state").hidden');

        // stage never signals the server: it is still serving after the views close
        await p.close();
        await viewer.close();
        assert.equal(hs.exitCode, null);
        assert.match(await get(port), /one/);

        // and an attached server that goes away shows as unreachable
        const again = await b.open(s.url);
        await again.until('document.querySelector(".live-state")?.hidden === true');
        hs.kill();
        await again.until('document.querySelector(".live-state").dataset.state === "unreachable"');
        await again.close();
    });
});
