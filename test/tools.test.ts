// the scene tools on live PlayCanvas apps, one per way an app loads its engine, each on its own dev server
// first, so the stage folder is the test's own before chrome.ts loads the server
import './home.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    copyFileSync,
    cpSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    statSync,
    symlinkSync,
    writeFileSync
} from 'node:fs';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { chrome, launch } from './chrome.ts';

const { startDaemon } = await import('../plugins/playcanvas-stage/server/daemon.ts');

const REPO = join(import.meta.dirname, '..');
const ENGINE = join(REPO, 'node_modules', 'playcanvas');
const FIX = join(import.meta.dirname, 'fixtures', 'live', 'pc');

const freePort = () =>
    new Promise<number>((ok) => {
        const s = createServer().listen(0, '127.0.0.1', () => {
            const p = (s.address() as AddressInfo).port;
            s.close(() => ok(p));
        });
    });
const up = (port: number) =>
    new Promise<boolean>((ok) =>
        request({ host: '127.0.0.1', port, path: '/' }, (r) => (r.resume(), ok(true)))
            .on('error', () => ok(false))
            .end()
    );
const httpServer = async (dir: string) => {
    const port = await freePort();
    const p = spawn(
        join(REPO, 'node_modules', '.bin', 'http-server'),
        [dir, '-p', String(port), '-a', '127.0.0.1', '-c-1', '-s'],
        { stdio: 'ignore' }
    );
    for (let i = 0; i < 100 && !(await up(port)); i++) {
        await new Promise((r) => setTimeout(r, 100));
    }
    return { p, port };
};

// every file of the project but its installed packages and build output, so a test proves we wrote none
const snapshot = (dir: string) => {
    const out: Record<string, string> = {};
    const walk = (d: string) => {
        for (const n of readdirSync(d)) {
            const f = join(d, n);
            if (n === 'node_modules' || n === 'dist') {
                continue;
            }
            if (statSync(f).isDirectory()) {
                walk(f);
            } else {
                out[relative(dir, f)] = createHash('sha256').update(readFileSync(f)).digest('hex');
            }
        }
    };
    walk(dir);
    return out;
};

describe('scene tools on live apps', { skip: !chrome && 'no Chrome' }, () => {
    let d: Awaited<ReturnType<typeof startDaemon>>;
    let b: Awaited<ReturnType<typeof launch>>;
    let root: string;
    let files: Record<string, string>;
    const procs: ChildProcess[] = [];
    const closers: (() => Promise<unknown>)[] = [];
    const servers: Record<string, number> = {};

    const agent = (method: string, path: string, body?: unknown) =>
        fetch(`http://127.0.0.1:${d.port}${path}`, {
            method,
            headers: { authorization: `Bearer ${d.token}` },
            body: body === undefined ? undefined : JSON.stringify(body)
        }).then((r) => r.json());
    const attach = async (url: string, at = root) =>
        (await agent('POST', '/_agent/publish', { title: 'Game', live: { url, root: at } })) as {
            id: string;
            url: string;
        };
    const frameOrigin = (id: string) => `http://${id}.localhost:${d.port}`;
    const edits = async (id: string) =>
        ((await agent('POST', `/_agent/s/${id}/db`, { verb: 'list', args: { collection: 'edits' } })).docs ?? []) as {
            data: { path: string; pos: number[] };
        }[];

    // where an entity, or a gizmo handle, shows on the canvas, in css px, through the camera drawing it
    const VIEW =
        "(app.root.findByPath('StageCamera')?.enabled ? app.root.findByPath('StageCamera') : app.root.findByPath('Camera')).camera";
    const screenOf = (path: string) =>
        `(() => { const e = app.root.findByPath(${JSON.stringify(path.slice(1))}); const c = ${VIEW}; const v = c.worldToScreen(e.getPosition()); return [v.x, v.y]; })()`;
    const ARROW_X = `(() => {
        const c = ${VIEW};
        const g = app.root.children.find((n) => n.name.startsWith('gizmo') && n.enabled);
        const a = g && g.find((n) => n.name === 'head:x' && n.render)[0];
        if (!a) return null;
        const p = a.render.meshInstances[0].aabb.center;
        const s = c.worldToScreen(p);
        return [s.x, s.y];
    })()`;
    // an app that keeps no global of its own (the starter) is reached through the hook's registry
    const mounted =
        '(window.app ??= [...globalThis[Symbol.for("playcanvas.stage")].apps.keys()][0]) && document.querySelector("canvas")?.dataset.stageTools === ""';
    const ready = `${mounted} && !!document.querySelector("stage-tools")`;
    const hudText = (cls: string) =>
        `document.querySelector('stage-tools').shadowRoot.querySelector('.${cls}').textContent`;
    const boxX = "app.root.findByPath('Desk/Box').getLocalPosition().x";
    const hudAt = (action: string) =>
        `(() => { const r = document.querySelector('stage-tools').shadowRoot.querySelector('[data-action="${action}"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`;
    const isPaused = `document.querySelector('stage-tools').shadowRoot.querySelector('[data-action="play"]').getAttribute('aria-pressed') === 'false'`;
    // where an entity shows once the view holds still (the editor camera eases to a stop)
    const settled = async (page: any, path: string) => {
        let [x, y] = await page.evaluate(screenOf(path));
        for (let i = 0; i < 50; i++) {
            await new Promise((r) => setTimeout(r, 150));
            const [nx, ny] = await page.evaluate(screenOf(path));
            const still = Math.hypot(nx - x, ny - y) < 0.5;
            [x, y] = [nx, ny];
            if (still) {
                break;
            }
        }
        return [x, y] as number[];
    };
    // the inspector's toggle is the viewer's; a page opened on its own gets the same event
    const openInspector = async (page: any) => {
        await page.until("globalThis[Symbol.for('playcanvas.stage')].tools?.inspectable()");
        await page.evaluate("document.dispatchEvent(new CustomEvent('agent:inspector-toggle'))");
    };
    // play/pause is Unity's ⌘P (Ctrl+P off a Mac)
    const playKey = (page: any) =>
        page.key('p', 'KeyP', { windowsVirtualKeyCode: 80, modifiers: process.platform === 'darwin' ? 4 : 2 });
    const press = async (page: any, action: string) => {
        const [x, y] = await page.evaluate(hudAt(action));
        await page.click(x, y);
    };

    before(async () => {
        d = await startDaemon({ port: 0 });
        b = await launch();
        root = mkdtempSync(join(tmpdir(), 'stage-pc-'));
        cpSync(FIX, root, { recursive: true });
        mkdirSync(join(root, 'node_modules'));
        symlinkSync(ENGINE, join(root, 'node_modules', 'playcanvas'));
        copyFileSync(join(ENGINE, 'build', 'playcanvas.js'), join(root, 'playcanvas.js'));
        files = snapshot(root);

        const { build, createServer: vite } = await import('vite');
        const v = await vite({ root, configFile: false, logLevel: 'silent', server: { port: 0, host: '127.0.0.1' } });
        await v.listen();
        closers.push(() => v.close());
        servers.vite = (v.httpServer!.address() as AddressInfo).port;
        await build({
            root: join(root, 'bundle'),
            configFile: false,
            logLevel: 'silent',
            base: './',
            build: { outDir: join(root, 'bundle', 'dist'), emptyOutDir: true }
        });
        for (const [k, dir] of [
            ['static', root],
            ['bundle', join(root, 'bundle', 'dist')]
        ]) {
            const s = await httpServer(dir);
            procs.push(s.p);
            servers[k] = s.port;
        }
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

    // select the box, drag its gizmo along x, and see the edit kept, across a reload and in a second view
    const exercise = async (url: string, path = '/Desk/Box', at = root) => {
        const xOf = `app.root.findByPath(${JSON.stringify(path.slice(1))}).getLocalPosition().x`;
        const s = await attach(url, at);
        const page = await b.open(`${frameOrigin(s.id)}${new URL(url).pathname}${new URL(url).search}`);
        await page.until(ready);

        // the tools edit a paused app
        await press(page, 'play');
        await page.until(isPaused);
        const from = await page.evaluate<number>(xOf);
        const [bx, by] = await page.evaluate<number[]>(screenOf(path));
        await page.click(bx, by);
        await page.until(`${hudText('selection')} === ${JSON.stringify(path)}`);
        const arrow = (await page.until(ARROW_X)) as number[];
        await page.drag(arrow, [arrow[0] + 120, arrow[1]]);
        await page.until(`${xOf} > ${from + 0.2}`);
        const moved = await page.evaluate<number>(xOf);
        for (let i = 0; i < 50 && !(await edits(s.id)).some((x) => x.data.path === path); i++) {
            await new Promise((r) => setTimeout(r, 100));
        }
        const doc = (await edits(s.id)).find((x) => x.data.path === path)!;
        assert.ok(Math.abs(doc.data.pos[0] - moved) < 1e-3, `kept at ${doc.data.pos[0]}, shown at ${moved}`);

        await page.evaluate('window.before = true');
        await page.send('Page.reload');
        await page.until(`!window.before && ${ready}`);
        await page.until(`Math.abs(${xOf} - ${moved}) < 1e-3`);
        const second = await b.open(`${frameOrigin(s.id)}${new URL(url).pathname}${new URL(url).search}`);
        await second.until(ready);
        await second.until(`Math.abs(${xOf} - ${moved}) < 1e-3`);
        await second.close();
        return { s, page, from, moved };
    };

    test('a Vite app (its engine as a module file): select, gizmo drag, edits kept, and discarded', async () => {
        const { s, page, from, moved } = await exercise(`http://localhost:${servers.vite}/`);

        // Discard puts the box back where the app placed it and deletes its edit; undo brings both back
        await press(page, 'play');
        await page.until(isPaused);
        await page.until(
            `!document.querySelector('stage-tools').shadowRoot.querySelector('[data-action="discard"]').disabled`
        );
        await press(page, 'discard');
        const confirmBox = "document.querySelector('stage-tools').shadowRoot.querySelector('.confirm')";
        await page.until(`!${confirmBox}.hidden && ${confirmBox}.textContent.includes('Discard 1 edit?')`);
        assert.ok(Math.abs((await page.evaluate<number>(boxX)) - moved) < 1e-3, 'nothing discarded before the confirm');
        const [cx, cy] = await page.evaluate<number[]>(
            `(() => { const r = ${confirmBox}.querySelector('[data-confirm="discard"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`
        );
        await page.click(cx, cy);
        await page.until(`Math.abs(${boxX} - ${from}) < 1e-3`);
        for (let i = 0; i < 50 && (await edits(s.id)).length; i++) {
            await new Promise((r) => setTimeout(r, 100));
        }
        assert.equal((await edits(s.id)).length, 0);
        await page.key('z', 'KeyZ', { windowsVirtualKeyCode: 90, modifiers: process.platform === 'darwin' ? 4 : 2 });
        await page.until(`Math.abs(${boxX} - ${moved}) < 1e-3`);
        for (let i = 0; i < 50 && !(await edits(s.id)).length; i++) {
            await new Promise((r) => setTimeout(r, 100));
        }
        assert.equal((await edits(s.id)).length, 1);
        await page.close();
    });

    test('a script-tag app: select, gizmo drag, edits kept', async () => {
        const { page } = await exercise(`http://localhost:${servers.static}/script.html`);
        await page.close();
    });

    test('a bundled app with the line: select, gizmo drag, edits kept', async () => {
        const { page } = await exercise(`http://localhost:${servers.bundle}/`);

        // the line's pause and resume run the app's own clocks with ours (the page reloaded playing)
        await press(page, 'play');
        await page.until(isPaused);
        await press(page, 'play');
        await page.until(`!(${isPaused})`);
        assert.deepEqual(await page.evaluate('({ ...clocks })'), { paused: 1, resumed: 1 });
        await page.close();
    });

    // in the viewer: comment mode, a click on the entity, a comment sent; the thread as the agent reads it
    const commentOn = async (
        s: { id: string; url: string },
        path: string,
        text = 'make it red',
        gesture?: (v: any, at: number[], to: number[], f: any) => Promise<unknown>
    ) => {
        const viewer = await b.open(s.url, { width: 1100, height: 760 });
        const f = await viewer.frame(frameOrigin(s.id));
        await f.until(mounted);

        // comments wait for a pause
        await viewer.until(
            `document.querySelector('.tools-bar [data-id="play"]')?.getAttribute('aria-pressed') === 'true'`
        );
        await viewer.evaluate(`document.querySelector('.tools-bar [data-id="play"]').click()`);
        await viewer.until(`document.querySelector('.iconbtn.mode').getAttribute('aria-disabled') === 'false'`);
        await viewer.evaluate('document.querySelector(".iconbtn.mode").click()');
        await f.until('document.adoptedStyleSheets.length > 0');

        // the comments panel opening beside the frame resizes the app, so its size settles before the entity's place
        await viewer.until("document.body.classList.contains('panel-open')");
        let w = 0;
        for (let i = 0; i < 50; i++) {
            const nw = await viewer.evaluate<number>(
                'Math.round(document.querySelector("iframe").getBoundingClientRect().width)'
            );
            if (nw === w) {
                break;
            }
            w = nw;
            await new Promise((r) => setTimeout(r, 100));
        }
        await f.until(`innerWidth === ${w}`);
        assert.equal(await f.evaluate("document.querySelector('canvas').style.cursor"), 'crosshair');

        // the comments panel may open beside the frame and the editor camera takes over, so the entity's place on
        // screen settles first
        await f.until("!!app.root.findByPath('StageCamera')?.enabled");
        const [bx, by] = await settled(f, path);
        const rect = await viewer.evaluate<number[]>(
            '(() => { const r = document.querySelector("iframe").getBoundingClientRect(); return [r.left, r.top]; })()'
        );
        // a slow runner can route a click before the app's frame takes input, so a plain click is sent again until the
        // box opens; a test's own gesture runs once
        const open = 'document.querySelector(".draft-pop textarea") && !document.querySelector(".draft-pop").hidden';
        if (gesture) {
            await gesture(viewer, rect, [bx, by], f);
        } else {
            for (let i = 0; i < 5; i++) {
                await viewer.click(rect[0] + bx, rect[1] + by);
                if (await viewer.until(open, 2000).catch(() => false)) {
                    break;
                }
            }
        }
        await viewer.until(open);
        await viewer.evaluate('document.querySelector(".draft-pop textarea").focus()');
        await viewer.type(text);
        await viewer.key('Enter', 'Enter');
        let t: any;
        for (let i = 0; i < 50 && !t; i++) {
            t = (await agent('GET', `/_agent/s/${s.id}/comments`)).threads?.[0];
            if (!t) {
                await new Promise((r) => setTimeout(r, 100));
            }
        }
        await viewer.close();
        assert.equal(t.comments[0].text, text);
        assert.ok(t.anchor.image?.type?.startsWith('image/'), 'a capture of the object');
        return t;
    };

    test('a comment arrives anchored to the entity path, with its capture', async () => {
        const s = await attach(`http://localhost:${servers.vite}/?comment`);
        const t = await commentOn(s, '/Ball', 'make the ball red');
        assert.match(t.anchor.snippet, /^<canvas data-entity="\/Ball" data-point="[-\d.]+,[-\d.]+,[-\d.]+">$/);
        assert.equal(t.anchor.label, 'Vite game › /Ball');
    });

    // paused, the app's html over its canvas hides until the UI toggle shows it
    const showUi = async (v: any, f: any) => {
        const card = "document.querySelector('.hud-card').checkVisibility({ visibilityProperty: true })";
        assert.equal(await f.evaluate(card), false, 'hidden while paused');
        await v.evaluate(`document.querySelector('.tools-bar [data-id="ui"]').click()`);
        await f.until(card);
    };
    // a comment's capture, read at points given in css px of an area this size
    const pixels = async (s: { id: string }, t: any, [w, h]: number[], points: number[][]) => {
        const img = await agent('GET', `/_agent/s/${s.id}/comments/${t.id}/image`);
        const page = await b.open('about:blank');
        const out = await page.evaluate<number[][]>(`(async () => {
            const i = new Image();
            i.src = ${JSON.stringify(`data:${img.type};base64,${img.b64}`)};
            await i.decode();
            const c = new OffscreenCanvas(i.width, i.height);
            const x = c.getContext('2d');
            x.drawImage(i, 0, 0);
            return ${JSON.stringify(points)}.map(([px, py]) => [...x.getImageData((px / ${w}) * i.width, (py / ${h}) * i.height, 1, 1).data.slice(0, 3)]);
        })()`);
        await page.close();
        return out;
    };
    const magenta = ([r, g, bl]: number[]) => r > 220 && g < 40 && bl > 220;

    test('an area centred on the page’s ui over the canvas is a comment on the page, with the scene in its capture', async () => {
        const s = await attach(`http://localhost:${servers.vite}/?hud`);
        // 180x110 css px from (10, 10), centred on the card; from inside it, across its text, which isn't selected
        const t = await commentOn(s, '/Ball', 'the card is too big', async (v, [ox, oy], _, f) => {
            await showUi(v, f);
            await v.drag([ox + 190, oy + 120], [ox + 10, oy + 10]);
            assert.equal(await f.evaluate('getSelection().toString()'), '');
        });
        assert.doesNotMatch(t.anchor.snippet, /^<canvas/, 'anchored on the page, so its pin stays on the page');
        assert.deepEqual(t.anchor.inside, ['<div class="hud-card">Tap']);
        const [card, scene] = await pixels(
            s,
            t,
            [180, 110],
            [
                [140, 90],
                [10, 10]
            ]
        );
        assert.ok(magenta(card), `the card shows in the capture: ${card}`);
        assert.ok(!magenta(scene), `the scene shows around it: ${scene}`);
    });

    test('an area centred on the scene is a comment on the scene, with the page’s ui in its capture', async () => {
        const s = await attach(`http://localhost:${servers.vite}/?hud&scene`);
        // 300x240 css px from (100, 60), over part of the card at its top left
        const t = await commentOn(s, '/Ball', 'the hills look flat', async (v, [ox, oy], _, f) => {
            await showUi(v, f);
            await v.drag([ox + 400, oy + 300], [ox + 100, oy + 60]);
        });
        assert.equal(t.anchor.label, 'Vite game › area');
        assert.match(t.anchor.snippet, /^<canvas data-camera=/);
        const [card, scene] = await pixels(
            s,
            t,
            [300, 240],
            [
                [50, 60],
                [250, 200]
            ]
        );
        assert.ok(magenta(card), `the card shows in the capture: ${card}`);
        assert.ok(!magenta(scene), `the scene shows around it: ${scene}`);
    });

    test('an entity whose path others share refuses a move, and says why', async () => {
        const s = await attach(`http://localhost:${servers.vite}/?coins`);
        const page = await b.open(`${frameOrigin(s.id)}/?coins`);
        await page.until(ready);
        await press(page, 'play');
        await page.until(isPaused);
        const [x, y] = await page.evaluate<number[]>(
            `(() => { const e = app.root.children.find((n) => n.name === 'Coin'); const c = app.root.findByPath('Camera').camera; const v = c.worldToScreen(e.getPosition()); return [v.x, v.y]; })()`
        );
        await page.click(x, y);
        await page.until(`${hudText('selection')} === '/Coin'`);
        assert.match(await page.evaluate<string>(hudText('status')), /Can't move \/Coin: 2 entities share that path/);
        assert.equal(await page.evaluate(ARROW_X), null, 'no gizmo to drag');
        await page.close();
    });

    test('paused, the app hears no input and holds still; playing, the tools hear nothing but the hud', async () => {
        const s = await attach(`http://localhost:${servers.vite}/?pause`);
        const page = await b.open(`${frameOrigin(s.id)}/?pause`);
        await page.until(ready);
        const heard = () => page.evaluate<Record<string, number>>('({ ...heard })');
        const keyW = { key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 };

        // playing: the app hears keys; a click on the box selects nothing
        await page.key('w', 'KeyW', { windowsVirtualKeyCode: 87 });
        await page.until('heard.key === 1');
        const [bx, by] = await page.evaluate<number[]>(screenOf('/Desk/Box'));
        await page.click(bx, by);
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(await page.evaluate(hudText('selection')), '');

        // every toolbar button says what it does and its key on hover, and why when it can't be used yet
        const tipOf = (action: string) =>
            `getComputedStyle(document.querySelector('stage-tools').shadowRoot.querySelector('[data-action="${action}"], [data-tool="${action}"]'), '::after').content`;
        const [gx, gy] = await page.evaluate<number[]>(hudAt('step'));
        await page.mouse('mouseMoved', gx, gy);
        await page.until(`/⌥⌘P|Ctrl\\+Alt\\+P/.test(${tipOf('step')}) && ${tipOf('step')}.includes('Pause first')`);
        const viewOff = `document.querySelector('stage-tools').shadowRoot.querySelector('[data-action="view"]').disabled`;
        assert.equal(await page.evaluate(viewOff), true, 'no View from camera while playing');

        // a key held across the pause is let go of
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...keyW });
        await page.until("held('W')");
        const h0 = await heard();
        await press(page, 'play');
        await page.until(isPaused);
        assert.equal((await heard()).page, h0.page, 'a click on our hud never reaches the game');
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...keyW });

        // paused: no key, pointer, wheel or pointer lock reaches the app
        const h1 = await heard();
        await page.key('a', 'KeyA', { windowsVirtualKeyCode: 65 });
        await page.click(20, 600);
        await page.mouse('mouseWheel', 300, 300, { deltaX: 0, deltaY: 120 });
        await page.evaluate('lockPointer()');
        await new Promise((r) => setTimeout(r, 300));
        const h2 = await heard();
        assert.deepEqual({ ...h2, lock: 0 }, { ...h1, lock: 0 });
        assert.equal(await page.evaluate('document.pointerLockElement'), null);

        // a gizmo move on the spinner holds: the app's per-frame code doesn't overwrite it
        const frame = await page.evaluate<number>('app.frame');
        const [sx, sy] = await page.evaluate<number[]>(screenOf('/Spinner'));
        await page.click(sx, sy);
        await page.until(`${hudText('selection')} === '/Spinner'`);
        const spinX = "app.root.findByPath('Spinner').getLocalPosition().x";
        const before = await page.evaluate<number>(spinX);
        const arrow = (await page.until(ARROW_X)) as number[];
        await page.drag(arrow, [arrow[0] + 100, arrow[1]]);
        await page.until(`${spinX} > ${before + 0.2}`);
        const moved = await page.evaluate<number>(spinX);
        await new Promise((r) => setTimeout(r, 500));
        assert.equal(await page.evaluate(spinX), moved);
        assert.equal(await page.evaluate('app.frame'), frame, 'paused, the app does not update');

        // step runs the app's update exactly once
        await press(page, 'step');
        await page.until(`app.frame === ${frame + 1}`);
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(await page.evaluate('app.frame'), frame + 1);

        // orbiting away, the game camera stays put
        const gameAt = "app.root.findByPath('Camera').getPosition().toString()";
        const edAt = "app.root.findByPath('StageCamera').getPosition().toString()";
        await page.until("!!app.root.findByPath('StageCamera')?.enabled");
        const g = await page.evaluate<string>(gameAt);

        // the outline is drawn from the pose the frame is drawn from, so it stays on its entity as the view moves
        await page.evaluate(`window.lag = 0; app.on('frameend', () => {
            const [o, e] = [app.root.findByPath('OutlineCamera'), app.root.findByPath('StageCamera')];
            if (o && e?.enabled && o.getPosition().distance(e.getPosition()) > 1e-5) lag++;
        }), 0`);
        await page.drag([150, 150], [400, 260]);
        await page.until(`${edAt} !== ${JSON.stringify(g)}`);

        // the camera eases: it is still moving a good way after the drag ends
        const edXyz =
            "(() => { const p = app.root.findByPath('StageCamera').getPosition(); return [p.x, p.y, p.z]; })()";
        const p1 = await page.evaluate<number[]>(edXyz);

        // a few frames, not a time: a slow renderer (the tests' software one) draws fewer of them in a window
        await page.evaluate(
            "new Promise((r) => { let n = 0; const f = () => ++n === 3 && (app.off('frameend', f), r()); app.on('frameend', f); })"
        );
        const p2 = await page.evaluate<number[]>(edXyz);
        assert.ok(Math.hypot(...p1.map((v, i) => v - p2[i])) > 0.01, 'the camera eased after the drag');
        await new Promise((r) => setTimeout(r, 500));
        assert.equal(await page.evaluate('lag'), 0, 'frames whose outline lagged the view');
        assert.equal(await page.evaluate(gameAt), g, 'the game camera is never moved');

        // the game camera shows as an icon: zoomed out to see it, a click on it selects it and puts the gizmo on it
        for (let i = 0; i < 6; i++) {
            await page.mouse('mouseWheel', 300, 300, { deltaX: 0, deltaY: 240 });
        }
        const [cx, cy] = await settled(page, '/Camera');
        await page.click(cx, cy);
        await page.until(`${hudText('selection')} === '/Camera'`);
        assert.equal(await page.evaluate("app.root.findByPath('StageIcons').enabled"), true);

        // moved with its gizmo, the camera keeps its edit, and F frames it though it has no mesh
        const camArrow = (await page.until(ARROW_X)) as number[];
        await page.drag(camArrow, [camArrow[0] + 60, camArrow[1] - 60]);
        await page.until(`${gameAt} !== ${JSON.stringify(g)}`);
        const camMoved = await page.evaluate<string>(gameAt);
        await page.until(`${hudText('status')} === 'Saved'`);
        assert.ok(
            (await edits(s.id)).some((e) => e.data.path === '/Camera'),
            'the camera move is kept'
        );
        await page.key('f', 'KeyF', { windowsVirtualKeyCode: 70 });
        const apart =
            "app.root.findByPath('StageCamera').getPosition().distance(app.root.findByPath('Camera').getPosition())";
        await page.until(`${apart} < 1`);

        // orbiting the framed camera keeps its gizmo: F doesn't park the view on the gizmo's near cutoff
        await page.evaluate(`window.flips = 0; window.had = ${ARROW_X} !== null; app.on('frameend', () => {
            const has = ${ARROW_X} !== null;
            if (has !== had) flips++;
            had = has;
        }), 0`);
        await page.drag([150, 550], [230, 590]);
        await new Promise((r) => setTimeout(r, 500));
        assert.equal(await page.evaluate('flips'), 0, 'the gizmo flickered while orbiting the framed camera');

        // View from camera puts the editor camera where the selected camera is, looking its way
        await page.until(`!${viewOff}`);
        await press(page, 'view');
        await page.until(
            `${apart} < 1e-3 && app.root.findByPath('StageCamera').forward.distance(app.root.findByPath('Camera').forward) < 1e-3`
        );

        // looking from the camera, its gizmo is off rather than filling the view, and back once the view moves away
        await page.until(`${ARROW_X} === null`);
        for (let i = 0; i < 4; i++) {
            await page.mouse('mouseWheel', 300, 300, { deltaX: 0, deltaY: 240 });
        }
        await page.until(`${ARROW_X} !== null`);

        // playing again: the key held over the pause is not stuck, the app hears again, the gizmo nothing
        await press(page, 'play');
        await page.until(`!(${isPaused})`);
        assert.equal(await page.evaluate("held('W')"), false);
        const k = (await heard()).key;
        await page.key('b', 'KeyB', { windowsVirtualKeyCode: 66 });
        await page.until(`heard.key === ${k + 1}`);
        assert.equal(await page.evaluate(ARROW_X), null, 'no gizmo while playing');
        assert.equal(await page.evaluate(gameAt), camMoved, 'playing, the game camera is where it was moved to');
        await page.until("!app.root.findByPath('StageIcons').enabled");

        // our hotkey pauses and plays, and the app never hears it
        const k2 = (await heard()).key;
        await playKey(page);
        await page.until(isPaused);
        await playKey(page);
        await page.until(`!(${isPaused})`);
        assert.equal((await heard()).key, k2);
        await page.close();
    });

    test('paused, the editor camera keeps the game camera’s view, roll included, until it is driven', async () => {
        const s = await attach(`http://localhost:${servers.vite}/?roll`);
        const page = await b.open(`${frameOrigin(s.id)}/?roll`);
        await page.until(ready);
        const tools = "globalThis[Symbol.for('playcanvas.stage')].tools";
        const axes = (name: string) =>
            page.evaluate<number[]>(
                `(() => { const { up: u, forward: f } = app.root.findByPath('${name}'); return [u.x, u.y, u.z, f.x, f.y, f.z]; })()`
            );
        const frames = () =>
            page.evaluate(
                "new Promise((r) => { let n = 0; const f = () => ++n === 5 && (app.off('frameend', f), r()); app.on('frameend', f); })"
            );
        const off = async () => {
            const [g, e] = [await axes('Camera'), await axes('StageCamera')];
            return Math.max(...g.map((v, i) => Math.abs(v - e[i])));
        };

        // a game camera that isn't world-up, as a chase camera on a planet
        await page.evaluate(
            "(() => { const c = app.root.findByPath('Camera'); const e = c.getEulerAngles(); c.setEulerAngles(e.x, e.y, 25); })()"
        );
        await press(page, 'play');
        await page.until(isPaused);
        await frames();
        assert.ok((await off()) < 1e-3, 'the paused view is the game’s, roll included');
        assert.equal(await page.evaluate(`${tools}.drive()`), null);

        // a click, which selects, doesn't drive it
        await page.click(20, 600);
        await frames();
        assert.ok((await off()) < 1e-3, 'a click keeps the view');

        // a drag does, and the roll eases out as it moves rather than going at once: the view's right, as far as it
        // is off level, each frame
        const at = "app.root.findByPath('StageCamera').getPosition().toString()";
        const from = await page.evaluate<string>(at);
        await page.evaluate(
            "(() => { const e = app.root.findByPath('StageCamera'); window.rolls = []; app.on('frameend', () => rolls.push(Math.abs(e.right.y))); })()"
        );
        await page.drag([150, 150], [400, 260]);
        await page.until(`!!${tools}.drive() && ${at} !== ${JSON.stringify(from)}`);
        await new Promise((r) => setTimeout(r, 1500));
        const rolls = await page.evaluate<number[]>('rolls');
        const steps = rolls.slice(1).map((r, i) => rolls[i] - r);
        assert.ok(Math.max(...steps) < rolls[0] * 0.8, 'no one frame takes the roll away');
        assert.ok(rolls[rolls.length - 1] < 1e-3, 'the view ends level');
        await page.close();
    });

    test('paused, the editor camera renders through a copy of the game camera’s camera-frame look, kept up as it changes', async () => {
        const s = await attach(`http://localhost:${servers.vite}/?frame`);
        const page = await b.open(`${frameOrigin(s.id)}/?frame`);
        await page.until(`${ready} && !!window.frame?.engineCameraFrame`);
        const ours = "app.root.findByPath('StageCamera')?.script?.scripts.find((x) => x.engineCameraFrame)";
        const frames = () =>
            page.evaluate(
                "new Promise((r) => { let n = 0; const f = () => ++n === 5 && (app.off('frameend', f), r()); app.on('frameend', f); })"
            );
        await press(page, 'play');
        await page.until(isPaused);
        await frames();
        assert.equal(
            await page.evaluate(`${ours}?.rendering.toneMapping`),
            'aces2',
            'the paused view is tone mapped as the game is'
        );
        assert.equal(await page.evaluate(`${ours}?.bloom.enabled`), true);
        assert.equal(
            await page.evaluate(
                `${ours}.engineCameraFrame.rendering.toneMapping === frame.engineCameraFrame.rendering.toneMapping`
            ),
            true,
            'its settings reach the engine frame while the app is paused'
        );

        // the app's own scripts don't run while paused, but a change to the game's look still carries over
        await page.evaluate('frame.bloom.intensity = 0.07');
        await frames();
        assert.equal(await page.evaluate(`${ours}.bloom.intensity`), 0.07);

        await press(page, 'play');
        await page.until(`!(${isPaused})`);
        assert.equal(
            await page.evaluate(`${ours}.engineCameraFrame.enabled`),
            false,
            'playing, only the game camera renders it'
        );
        await page.close();
    });

    test('paused, the selection shows as in the editor: a thin outline and corner brackets on its bounds', async () => {
        const s = await attach(`http://localhost:${servers.vite}/?highlight`);
        const page = await b.open(`${frameOrigin(s.id)}/?highlight`);
        await page.until(ready);
        await press(page, 'play');
        await page.until(isPaused);
        const [bx, by] = await settled(page, '/Desk/Box');
        await page.click(bx, by);
        await page.until(`${hudText('selection')} === '/Desk/Box'`);

        // the lines drawn in one frame, as [from, to] pairs, and those depth tested (the bright ones)
        const lines = () =>
            page.evaluate<{ depth: boolean; segs: number[][][] }[]>(`new Promise((ok) => {
                const out = [];
                const draw = app.drawLines;
                app.drawLines = function (p, c, depth = true, layer) {
                    const segs = [];
                    for (let i = 0; i < p.length; i += 2) segs.push([p[i], p[i + 1]].map((v) => [v.x, v.y, v.z]));
                    out.push({ depth, segs });
                    return draw.apply(this, arguments);
                };
                app.once('frameend', () => ((app.drawLines = draw), ok(out)));
            })`);
        const bounds = await page.evaluate<{ c: number[]; h: number[] }>(
            "(() => { const b = app.root.findByPath('Desk/Box').render.meshInstances[0].aabb; return { c: [b.center.x, b.center.y, b.center.z], h: [b.halfExtents.x, b.halfExtents.y, b.halfExtents.z] }; })()"
        );

        // a bracket at each of the 8 corners: 3 arms along the edges, a third of the way in
        const brackets = (drawn: { depth: boolean; segs: number[][][] }[]) =>
            drawn
                .filter((d) => d.depth)
                .flatMap((d) => d.segs)
                .filter(([a, z]) => {
                    const corner = a.every((v, i) => Math.abs(Math.abs(v - bounds.c[i]) - bounds.h[i]) < 0.02);
                    const arm = z.map((v, i) => Math.abs(v - a[i]) / bounds.h[i]);
                    return (
                        corner && arm.filter((v) => v < 1e-4).length === 2 && arm.some((v) => Math.abs(v - 0.3) < 0.02)
                    );
                });
        assert.equal(brackets(await lines()).length, 24, 'corner brackets around the selection');

        // the outline is the engine's own, a pixel or so either side of the edge, as in the editor
        const row = (y: number) =>
            page.evaluate<number[]>(`new Promise((ok) => app.once('frameend', () => {
                const c = app.graphicsDevice.canvas;
                const g = new OffscreenCanvas(c.width, 1).getContext('2d');
                g.drawImage(c, 0, Math.round(${y} * c.height / c.clientHeight), c.width, 1, 0, 0, c.width, 1);
                ok([...g.getImageData(0, 0, c.width, 1).data]);
            }))`);
        await page.evaluate("app.scene.layers.getLayerByName('StageGizmo').enabled = false");
        const lit = await row(by);
        await page.key('Escape', 'Escape', { windowsVirtualKeyCode: 27 });
        await page.until(`${hudText('selection')} === ''`);
        const bare = await row(by);
        let edge = 0;
        for (let i = 0; i < lit.length; i += 4) {
            if ([0, 1, 2].some((k) => Math.abs(lit[i + k] - bare[i + k]) > 8)) {
                edge++;
            }
        }
        assert.ok(edge > 0 && edge <= 6, `outline ${edge}px across both edges`);
        assert.equal(brackets(await lines()).length, 0, 'no brackets with nothing selected');
        await page.close();
    });

    test('the inspector panel lists the app’s entities and reads it playing and paused, with no pause of its own', async () => {
        const s = await attach(`http://localhost:${servers.vite}/?inspect`);
        const page = await b.open(`${frameOrigin(s.id)}/?inspect`, { width: 1400, height: 800 });
        await page.until(ready);
        await openInspector(page);
        const panel = "document.querySelector('.pc-inspector')?.shadowRoot";
        const row = (name: string) =>
            `[...${panel}.querySelectorAll('.pci-row')].find((r) => r.querySelector('.pci-name')?.textContent === ${JSON.stringify(name)})`;
        for (const n of ['Camera', 'Desk', 'Ball', 'Spinner']) {
            await page.until(`!!${row(n)}`);
        }

        // its own pause and step are not there: ours is the only one
        const visible = await page.evaluate<string[]>(
            `[...${panel}.querySelectorAll('button')].filter((b) => b.offsetParent !== null).map((b) => b.getAttribute('aria-label') ?? '')`
        );
        assert.ok(!visible.some((l) => /^(Pause|Resume|Step)/.test(l)), visible.join(', '));

        // playing, a click on the panel reaches it and never the game; paused, it still reads the app
        const pick = async (name: string) => {
            const [x, y] = await page.evaluate<number[]>(
                `(() => { const r = ${row(name)}.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`
            );
            await page.click(x, y);
            await page.until(`${row(name)}.classList.contains('pci-selected')`);
        };
        const pageClicks = await page.evaluate<number>('heard.page');
        await pick('Spinner');
        assert.equal(await page.evaluate('heard.page'), pageClicks);
        await press(page, 'play');
        await page.until(isPaused);
        await pick('Ball');
        await page.close();
    });

    test('in the viewer the tools sit in a strip above the app, off its canvas', async () => {
        const s = await attach(`http://localhost:${servers.vite}/?strip`);
        const { docIdOf } = await import(
            pathToFileURL(join(import.meta.dirname, '..', 'plugins', 'playcanvas-stage', 'web', 'live', 'core.mjs'))
                .href
        );
        await agent('POST', `/_agent/s/${s.id}/db`, {
            verb: 'batch',
            args: {
                writes: [
                    {
                        op: 'set',
                        collection: 'edits',
                        doc_id: docIdOf('/Ball'),
                        data: { path: '/Ball', pos: [0, 3, 0], rot: [0, 0, 0], scale: [1, 1, 1] }
                    }
                ]
            }
        });
        const viewer = await b.open(s.url, { width: 1200, height: 800 });
        const f = await viewer.frame(frameOrigin(s.id));
        await f.until(mounted);
        assert.equal(await f.evaluate("!!document.querySelector('stage-tools')"), false, 'nothing over the canvas');
        const tool = (id: string) => `document.querySelector('.tools-bar [data-id="${id}"]')`;
        await viewer.until(
            `!document.querySelector('.tools-bar').hidden && /⌘P|Ctrl\\+P/.test(${tool('play')}.dataset.tip)`
        );
        assert.match(
            await viewer.evaluate<string>(`${tool('step')}.dataset.tip`),
            /(⌥⌘P|Ctrl\+Alt\+P)[\s\S]*Pause first/
        );
        assert.equal(await viewer.evaluate(`!!${tool('game')}`), false, 'no game view button');

        // every header and strip button shows what it does on hover. a slow runner can drop the one hover a test sends
        // (the viewer still settling), so it moves off and back on until the tip shows
        const tipShown = `!document.querySelector('.tip').hidden && document.querySelector('.tip').textContent === 'Comments'`;
        for (let i = 0; i < 5; i++) {
            const [hx, hy] = await viewer.evaluate<number[]>(
                `(() => { const r = document.querySelector('.bar [aria-label="Toggle comments"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`
            );
            await viewer.mouse('mouseMoved', 1, 790);
            await viewer.mouse('mouseMoved', hx, hy);
            if (await viewer.until(tipShown, 2000).catch(() => false)) {
                break;
            }
        }
        await viewer.until(tipShown);

        // playing, the play button is lit and the viewer around the app dims
        await viewer.until(
            `${tool('play')}.getAttribute('aria-pressed') === 'true' && document.body.classList.contains('playing')`
        );

        const edge = "getComputedStyle(document.querySelector('.frame-wrap'), '::after')";
        await viewer.until(`${edge}.opacity === '1' && ${edge}.boxShadow.includes('inset')`);

        // playing, the app has the input: comment mode waits for a pause, by the button or C
        const modeBtn = "document.querySelector('.bar .mode')";
        await viewer.until(`${modeBtn}.getAttribute('aria-disabled') === 'true'`);
        await viewer.evaluate(`${modeBtn}.click()`);
        await viewer.key('c', 'KeyC', { windowsVirtualKeyCode: 67 });
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(await viewer.evaluate(`${modeBtn}.getAttribute('aria-pressed')`), 'false');

        // a click there acts in the frame, and the strip follows
        await viewer.evaluate(`${tool('play')}.click()`);
        await f.until("globalThis[Symbol.for('playcanvas.stage')].tools.paused()");
        await viewer.until(
            `${tool('play')}.getAttribute('aria-pressed') === 'false' && ${tool('step')}.getAttribute('aria-disabled') === 'false'`
        );
        await f.until("!!app.root.findByPath('StageCamera')?.enabled");
        assert.equal(await viewer.evaluate("document.body.classList.contains('playing')"), false);
        await viewer.until(`${edge}.opacity === '0'`);
        await viewer.until(`${modeBtn}.getAttribute('aria-disabled') === 'false'`);
        await viewer.evaluate(`${modeBtn}.click()`);
        await viewer.until(`${modeBtn}.getAttribute('aria-pressed') === 'true'`);

        // commenting, its hint sits up in the strip, off the app's canvas
        await viewer.until(
            `(() => { const h = document.querySelector('.mode-hint'), f = document.querySelector('.frame-wrap iframe'); return h && !h.hidden && h.getBoundingClientRect().bottom <= f.getBoundingClientRect().top; })()`
        );
        await viewer.evaluate(`${modeBtn}.click()`);

        // ⌘P with the viewer's keyboard plays and pauses the app too, and the browser doesn't print
        await viewer.evaluate("document.querySelector('.title').focus?.(); document.activeElement?.blur?.()");
        await playKey(viewer);
        await f.until("!globalThis[Symbol.for('playcanvas.stage')].tools.paused()");
        await playKey(viewer);
        await f.until("globalThis[Symbol.for('playcanvas.stage')].tools.paused()");
        await f.evaluate(
            "globalThis[Symbol.for('playcanvas.stage')].tools.select([globalThis[Symbol.for('playcanvas.stage')].tools.app.root.findByPath('Ball')])"
        );
        await viewer.until(`document.querySelector('.tools-sel').textContent === '/Ball'`);

        // Discard asks first, in the strip: Cancel keeps the edit, Discard drops it
        const pop = "document.querySelector('.tools-confirm')";
        await viewer.until(`${tool('discard')}.getAttribute('aria-disabled') === 'false'`);
        await viewer.evaluate(`${tool('discard')}.click()`);
        await viewer.until(`!${pop}.hidden && ${pop}.textContent.includes('Discard 1 edit?')`);
        await viewer.evaluate(`[...${pop}.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click()`);
        await viewer.until(`${pop}.hidden`);
        assert.equal((await edits(s.id)).length, 1);
        await viewer.evaluate(`${tool('discard')}.click()`);
        await viewer.evaluate(
            `[...${pop}.querySelectorAll('button')].find((b) => b.textContent === 'Discard').click()`
        );
        for (let i = 0; i < 50 && (await edits(s.id)).length; i++) {
            await new Promise((r) => setTimeout(r, 100));
        }
        assert.equal((await edits(s.id)).length, 0);
        await viewer.close();
    });

    test('the viewer’s Inspector button, beside the comments panel’s, opens the panel beside the app, off its canvas', async () => {
        const s = await attach(`http://localhost:${servers.vite}/?inspect-viewer`);
        const viewer = await b.open(s.url, { width: 1400, height: 800 });
        const f = await viewer.frame(`${frameOrigin(s.id)}/?`);
        await f.until(mounted);
        const btn = 'document.querySelector(\'.bar [aria-label="Inspector"]\')';
        const appW = "document.querySelector('.frame-wrap iframe').getBoundingClientRect().width";
        const inApp = "!!document.querySelector('.pc-inspector')";
        await viewer.until(`${btn} && !${btn}.hidden`);
        const wide = await viewer.evaluate<number>(appW);
        await viewer.evaluate(`${btn}.click()`);

        // the panel is in the viewer's inspector frame, and the app's frame gave it the width
        const side = await viewer.frame(`${frameOrigin(s.id)}/_frame/live/inspector.html`);
        const panel = "document.querySelector('.pc-inspector')?.shadowRoot";
        const row = (name: string) =>
            `[...${panel}.querySelectorAll('.pci-row')].find((r) => r.querySelector('.pci-name')?.textContent === ${JSON.stringify(name)})`;
        await side.until(`!!${row('Ball')}`);
        await viewer.until(`${btn}.getAttribute('aria-pressed') === 'true' && ${appW} <= ${wide} - 280`);
        assert.equal(await f.evaluate(inApp), false, 'nothing over the canvas');

        // a row clicked there selects in the app, once the viewer has drawn the panel: a press sent sooner is routed
        // by the layout before it, and misses the panel
        await viewer.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
        const [x, y] = await side.evaluate<number[]>(
            `(() => { const r = ${row('Ball')}.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`
        );
        const [fx, fy] = await viewer.evaluate<number[]>(
            "(() => { const r = document.querySelector('.inspector iframe').getBoundingClientRect(); return [r.left, r.top]; })()"
        );
        // and a slow runner can route it before the panel's frame takes input, so it is sent again until it lands
        const picked = `${row('Ball')}.classList.contains('pci-selected')`;
        for (let i = 0; i < 5; i++) {
            await viewer.click(fx + x, fy + y);
            if (await side.until(picked, 2000).catch(() => false)) {
                break;
            }
        }
        await side.until(picked);
        await viewer.until("document.querySelector('.tools-sel').textContent === '/Ball'");

        // hidden, the panel stays beside the app, and shows there again
        await viewer.evaluate(`${btn}.click()`);
        await viewer.until(
            `${btn}.getAttribute('aria-pressed') === 'false' && !document.body.classList.contains('inspecting') && ${appW} === ${wide}`
        );
        await viewer.evaluate(`${btn}.click()`);
        await viewer.until(`${btn}.getAttribute('aria-pressed') === 'true'`);
        await side.until(`!!${row('Ball')}?.offsetParent`);
        assert.equal(await f.evaluate(inApp), false, 'still nothing over the canvas');
        await viewer.close();
    });

    test('the viewer’s MiniStats button shows the mini-stats over the app, a reload keeps them, and off gives back the gpu profiler', async () => {
        const s = await attach(`http://localhost:${servers.vite}/?stats-viewer`);
        const viewer = await b.open(s.url, { width: 1400, height: 800 });
        const f = await viewer.frame(frameOrigin(s.id));
        await f.until(mounted);
        const btn = 'document.querySelector(\'.bar [aria-label="MiniStats"]\')';
        const shown = "globalThis[Symbol.for('playcanvas.stage')].tools.stats()?.enabled === true";
        const prof = "globalThis[Symbol.for('playcanvas.stage')].tools.app.graphicsDevice.gpuProfiler?.enabled";
        const before = await f.evaluate<boolean>(prof);
        await viewer.until(`${btn} && !${btn}.hidden`);
        await viewer.evaluate(`${btn}.click()`);
        await f.until(shown);
        await f.until(
            "getComputedStyle(globalThis[Symbol.for('playcanvas.stage')].tools.stats().div).display !== 'none'"
        );
        await f.until(
            "/^Draw calls\\s*\\d+/m.test(globalThis[Symbol.for('playcanvas.stage')].tools.stats().div.shadowRoot.querySelector('.body').innerText)"
        );
        await viewer.until(`${btn}.getAttribute('aria-pressed') === 'true'`);
        await f.evaluate('location.reload()');
        const g = await viewer.frame(frameOrigin(s.id));
        await g.until(mounted);
        await g.until(shown);
        await viewer.until(`${btn}.getAttribute('aria-pressed') === 'true'`);
        await viewer.evaluate(`${btn}.click()`);
        await g.until(`!(${shown})`);
        await viewer.until(`${btn}.getAttribute('aria-pressed') === 'false'`);
        assert.equal(await g.evaluate(prof), before, 'the gpu profiler is as the app had it');
        await viewer.close();
    });

    test('in a device fit to the viewer, the mini-stats keep their size on screen, 12px in from the canvas’s corner', async () => {
        const s = await attach(`http://localhost:${servers.vite}/?stats-fit`);
        const viewer = await b.open(s.url, { width: 1400, height: 1300 });
        await viewer.until("!!document.querySelector('.bar')");
        await viewer.evaluate(
            `localStorage.setItem('stage.device:${s.id}', 'lens:port:fit:carousel'); location.reload()`
        );
        await viewer.until("document.querySelector('.frame-wrap')?.classList.contains('device')");
        const f = await viewer.frame(`${frameOrigin(s.id)}/?`);
        await f.until(mounted);
        const btn = 'document.querySelector(\'.bar [aria-label="MiniStats"]\')';
        await viewer.until(`${btn} && !${btn}.hidden`);
        await viewer.evaluate(`${btn}.click()`);
        const div = "globalThis[Symbol.for('playcanvas.stage')].tools.stats()?.div";
        await f.until(`${div} && getComputedStyle(${div}).display !== 'none'`);
        const k = await viewer.evaluate<number>(
            "Number(getComputedStyle(document.querySelector('.frame-wrap iframe')).getPropertyValue('--s'))"
        );
        assert.ok(k > 1.2, `the lens is scaled up (${k})`);

        // on screen, the frame's px times its scale
        const placed = `(() => {
            const r = ${div}.shadowRoot.querySelector('.panel').getBoundingClientRect();
            const c = document.querySelector('canvas').getBoundingClientRect();
            return [r.width * ${k}, ${div}.shadowRoot.querySelector('.panel').offsetWidth, (r.left - c.left) * ${k}, (c.bottom - r.bottom) * ${k}];
        })()`;
        await f.until(
            `(([w, css, x, y]) => Math.abs(w - css) < 1 && Math.abs(x - 12) < 1 && Math.abs(y - 12) < 1)(${placed})`
        );
        await viewer.close();
    });

    test('paused, the editor camera alone shows a ground grid, which its toggle and G turn off, kept across a reload', async () => {
        const s = await attach(`http://localhost:${servers.vite}/?grid`);
        const viewer = await b.open(s.url, { width: 1400, height: 800 });
        const f = await viewer.frame(frameOrigin(s.id));
        await f.until(mounted);
        const tools = "globalThis[Symbol.for('playcanvas.stage')].tools";
        const play = `document.querySelector('.tools-bar [data-id="play"]')`;
        const btn = `document.querySelector('.tools-bar [data-id="grid"]')`;
        await viewer.until(`${play}?.getAttribute('aria-pressed') === 'true'`);
        assert.equal(await f.evaluate(`${tools}.grid()`), false, 'no grid while playing');
        assert.equal(await viewer.evaluate(`${btn}.getAttribute('aria-disabled')`), 'true');
        await viewer.evaluate(`${play}.click()`);
        await f.until(`${tools}.grid()`);
        await viewer.until(`${btn}.getAttribute('aria-pressed') === 'true'`);
        assert.equal(
            await f.evaluate(
                `${tools}.app.systems.camera.cameras.filter((c) => c.enabled && c.layers.includes(${tools}.app.scene.layers.getLayerByName('StageGrid').id)).map((c) => c.entity.name).join()`
            ),
            'StageCamera'
        );
        // its lines take their ink from a capture of the scene, made after the skybox only while it shows
        const depthAfterSky = `(() => { const L = ${tools}.app.scene.layers; return L.getOpaqueIndex(L.getLayerByName('Depth')) > L.getOpaqueIndex(L.getLayerByName('Skybox')); })()`;
        assert.equal(await f.evaluate(depthAfterSky), true);
        await viewer.evaluate(`${btn}.click()`);
        await f.until(`!${tools}.grid()`);
        await viewer.until(`${btn}.getAttribute('aria-pressed') === 'false'`);
        assert.equal(await f.evaluate(depthAfterSky), false, 'the layers go back');
        await f.evaluate('location.reload()');
        const g = await viewer.frame(frameOrigin(s.id));
        await g.until(mounted);
        await viewer.until(`${play}?.getAttribute('aria-pressed') === 'true'`);
        await viewer.evaluate(`${play}.click()`);
        await viewer.until(`${play}.getAttribute('aria-pressed') === 'false'`);
        assert.equal(await g.evaluate(`${tools}.grid()`), false, 'still off after the reload');
        await g.evaluate("dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG', key: 'g' }))");
        await g.until(`${tools}.grid()`);
        await viewer.close();
    });

    test('the inspector shares one selection, picker and camera with our tools', async () => {
        const s = await attach(`http://localhost:${servers.vite}/?inspect-tools`);
        const page = await b.open(`${frameOrigin(s.id)}/?inspect-tools`, { width: 1400, height: 800 });
        await page.until(ready);
        await openInspector(page);
        const panel = "document.querySelector('.pc-inspector')?.shadowRoot";
        const row = (name: string) =>
            `[...${panel}.querySelectorAll('.pci-row')].find((r) => r.querySelector('.pci-name')?.textContent === ${JSON.stringify(name)})`;
        const button = (label: string) =>
            `[...${panel}.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(label)})`;
        const shot = async () => ((await page.send('Page.captureScreenshot', { format: 'png' })) as any).data as string;
        const at = (name: string) => `app.root.findByPath(${JSON.stringify(name)})?.getPosition().toString()`;
        const near = (a: string, b: string) =>
            Math.hypot(...JSON.parse(a).map((v: number, i: number) => v - JSON.parse(b)[i])) < 0.01;

        // the viewport controls are our toolbar's only: the panel has no pick, fly, orbit or gizmos of its own
        await page.until(`!!${button('Fly')}`);
        for (const l of ['Pick', 'Fly', 'Orbit', 'Move', 'Rotate', 'Scale']) {
            assert.equal(await page.evaluate(`${button(l)}?.offsetParent ?? null`), null, l);
        }

        // one editor camera: W flies it with the inspector's fly and it stays moved, while the game camera holds and
        // the app hears no key
        await press(page, 'play');
        await page.until(isPaused);
        await page.until("!!app.root.findByPath('StageCamera')?.enabled");
        const keys = (await page.evaluate<Record<string, number>>('({ ...heard })')).key;
        const [game, editor] = [await page.evaluate(at('Camera')), await page.evaluate(at('StageCamera'))];
        await page.send('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'w',
            code: 'KeyW',
            windowsVirtualKeyCode: 87
        });
        await new Promise((r) => setTimeout(r, 600));
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 });
        await new Promise((r) => setTimeout(r, 300));
        assert.ok(!near(await page.evaluate<string>(at('StageCamera')), editor as string), 'the editor camera flew');
        assert.equal((await page.evaluate<Record<string, number>>('({ ...heard })')).key, keys);
        assert.equal(await page.evaluate(at('Camera')), game);

        // a click on the view selects in both; a row picked in the panel is our selection too
        const [bx, by] = await settled(page, '/Desk/Box');
        await page.click(bx, by);
        await page.until(
            `${hudText('selection')} === '/Desk/Box' && ${row('Box')}?.classList.contains('pci-selected')`
        );
        const [rx, ry] = await page.evaluate<number[]>(
            `(() => { const r = ${row('Spinner')}.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`
        );
        await page.click(rx, ry);
        await page.until(`${hudText('selection')} === '/Spinner'`);

        // and the panel stays read-only: its transform fields don't edit, so every edit goes through our undo
        await page.until(
            `[...${panel}.querySelectorAll('.pci-label')].some((l) => l.textContent === 'local position')`
        );
        assert.equal(await page.evaluate(`${panel}.querySelectorAll('.pci-editable').length`), 0);

        // the selection is highlighted once: paused, as our outline, so the panel draws no box of its own around it.
        // counted over frames, not time, as a slow runner can draw none in a few hundred ms
        const boxes = () =>
            page.evaluate<number>(`(() => {
                const w = globalThis[Symbol.for('playcanvas.stage')].tools.inspector()._wire;
                const box = w.box;
                let n = 0, f = 0;
                w.box = function (...a) { n++; return box.apply(this, a); };
                return new Promise((ok) => {
                    const end = () => {
                        if (++f < 5) {
                            return;
                        }
                        app.off('frameend', end);
                        w.box = box;
                        ok(n);
                    };
                    app.on('frameend', end);
                });
            })()`);
        assert.equal(await boxes(), 0);

        // F frames the selection, easing there; a drag then orbits it
        const spinner =
            "app.root.findByPath('StageCamera').getPosition().distance(app.root.findByPath('Spinner').getPosition())";
        const far = await page.evaluate<number>(spinner);
        await page.key('f', 'KeyF', { windowsVirtualKeyCode: 70 });
        await page.until(`${spinner} < ${far} - 0.5`);
        const still = await shot();
        await page.drag([300, 700], [500, 720]);
        await new Promise((r) => setTimeout(r, 300));
        assert.notEqual(await shot(), still, 'the view orbited');

        // playing again: no drive is on, and the selection is kept for the next pause
        await press(page, 'play');
        await page.until(`!(${isPaused})`);
        assert.equal(await page.evaluate("globalThis[Symbol.for('playcanvas.stage')].tools.drive()"), null);
        assert.equal(await page.evaluate(hudText('selection')), '/Spinner');

        // playing, the view is the app's: our outline is off, and the panel's own highlight shows the selection
        assert.ok((await boxes()) > 0);
        await page.close();
    });

    test('a camera the camera-controls script drives plays on from where it was moved', async () => {
        const s = await attach(`http://localhost:${servers.vite}/?controls`);
        const page = await b.open(`${frameOrigin(s.id)}/?controls`);
        await page.until(`${ready} && !!app.root.findByName('Camera').script?.get('cameraControls')`);
        await press(page, 'play');
        await page.until(isPaused);
        await page.until("!!app.root.findByPath('StageCamera')?.enabled");

        // zoomed out to see it, the camera is selected and moved with its gizmo
        for (let i = 0; i < 6; i++) {
            await page.mouse('mouseWheel', 300, 300, { deltaX: 0, deltaY: 240 });
        }
        await settled(page, '/Camera');
        await page.evaluate("globalThis[Symbol.for('playcanvas.stage')].tools.select([app.root.findByName('Camera')])");
        const at = "app.root.findByPath('Camera').getPosition().toString()";
        const from = await page.evaluate<string>(at);
        const arrow = (await page.until(ARROW_X)) as number[];
        await page.drag(arrow, [arrow[0] + 60, arrow[1] - 60]);
        await page.until(`${at} !== ${JSON.stringify(from)}`);
        await page.until(`${hudText('status')} === 'Saved'`);
        const moved = await page.evaluate<string>(at);
        const look = "(() => { const f = app.root.findByPath('Camera').forward; return [f.x, f.y, f.z]; })()";
        const ahead = await page.evaluate<number[]>(look);

        // playing, the script holds it there, looking the same way
        await press(page, 'play');
        await page.until(`!(${isPaused})`);
        const f0 = await page.evaluate<number>('app.frame');
        await page.until(`app.frame > ${f0 + 10}`);
        assert.equal(await page.evaluate(at), moved);
        const now = await page.evaluate<number[]>(look);
        assert.ok(Math.hypot(...now.map((v, i) => v - ahead[i])) < 1e-3, 'it looks the way it did');
        await page.close();
    });

    test('a create-playcanvas starter: select, gizmo drag, edits kept, and a comment', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'stage-starter-'));
        cpSync(join(import.meta.dirname, 'fixtures', 'live', 'starter'), dir, { recursive: true });
        mkdirSync(join(dir, 'node_modules'));
        symlinkSync(ENGINE, join(dir, 'node_modules', 'playcanvas'));
        const { createServer: vite } = await import('vite');
        const v = await vite({
            root: dir,
            configFile: false,
            logLevel: 'silent',
            server: { port: 0, host: '127.0.0.1' }
        });
        await v.listen();
        closers.push(() => v.close());
        const port = (v.httpServer!.address() as AddressInfo).port;
        const { s, page } = await exercise(`http://localhost:${port}/`, '/cube', dir);
        await page.close();
        const t = await commentOn(s, '/cube');
        assert.match(t.anchor.snippet, /^<canvas data-entity="\/cube" data-point=/);
    });

    test('a bundled app without the line, and a 2.22 app, say what is missing', async () => {
        for (const [url, re] of [
            [`http://localhost:${servers.bundle}/?noline`, /bundled into its code.*register\(app/s],
            [`http://localhost:${servers.static}/old.html`, /PlayCanvas 2\.22\.5.*2\.23\.0 or newer/s]
        ] as const) {
            const s = await attach(url);
            const viewer = await b.open(s.url);
            await viewer.until('document.querySelector(".live-state")?.dataset.state === "problem"', 20000);
            assert.match(await viewer.evaluate<string>('document.querySelector(".live-state").textContent'), re);
            await viewer.close();
        }
    });

    test('nothing was written into the project', () => {
        assert.deepEqual(snapshot(root), files);
    });

    // last, since it plays the agent and changes the project's source
    test('Apply sends the pending edits to the agent, who folds them into source', async () => {
        const { s, page } = await exercise(`http://localhost:${servers.vite}/?apply`);
        const moved = await page.evaluate<number>(boxX);
        await page.until(
            `!document.querySelector('stage-tools').shadowRoot.querySelector('[data-action="send"]').disabled`
        );
        await press(page, 'send');
        let t: any;
        for (let i = 0; i < 50 && !t; i++) {
            t = (await agent('GET', `/_agent/s/${s.id}/comments`)).threads?.[0];
            if (!t) {
                await new Promise((r) => setTimeout(r, 100));
            }
        }
        assert.ok(t.comments[0].to_agent_at);
        assert.match(
            t.comments[0].text,
            new RegExp(
                `^- /Desk/Box — pos ${moved
                    .toFixed(4)
                    .replace(/\.?0+$/, '')
                    .replace('.', '\\.')}`,
                'm'
            )
        );

        // the agent folds the edit into the source and deletes its doc; the app reloads where the edit put it
        await page.evaluate('window.before = true');
        const scene = join(root, 'scene.mjs');
        const src = readFileSync(scene, 'utf8');
        writeFileSync(
            scene,
            src.replace(
                "add('Box', desk, { render: 'box', pos: [-1.5, 0.5, 0] });",
                `add('Box', desk, { render: 'box', pos: [${moved}, 0.5, 0] });`
            )
        );
        const docs = await edits(s.id);
        await agent('POST', `/_agent/s/${s.id}/db`, {
            verb: 'batch',
            args: { writes: (docs as any[]).map((d) => ({ op: 'delete', collection: 'edits', doc_id: d.id })) }
        });
        await page.until('!window.before && !!window.app');
        await page.until(ready);
        await page.until(`Math.abs(${boxX} - ${moved}) < 1e-3`);
        assert.equal((await edits(s.id)).length, 0);
        await page.until(
            `document.querySelector('stage-tools').shadowRoot.querySelector('[data-action="send"]').disabled`
        );
        await page.close();
    });
});
