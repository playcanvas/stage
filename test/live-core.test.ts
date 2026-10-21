import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const LIVE = join(import.meta.dirname, '..', 'plugins', 'playcanvas-stage', 'web', 'live');
const core = await import(pathToFileURL(join(LIVE, 'core.mjs')).href);
const HOOK = Symbol.for('playcanvas.inspector');
const STAGE = Symbol.for('playcanvas.stage');

// runs the classic hook script in a fresh global, optionally over an existing hook (the inspector extension's);
// symbol-keyed globals stay inside the context, so they are read back through it. its EventTarget is a subclass,
// so the hook's wrapping never reaches this process's own
const hookIn = (prev?: object) => {
    class ET extends EventTarget {}
    const win = new ET();
    const ctx = createContext({
        queueMicrotask,
        prev,
        EventTarget: ET,
        window: win,
        addEventListener: win.addEventListener.bind(win)
    });
    runInContext("if (prev) globalThis[Symbol.for('playcanvas.inspector')] = prev", ctx);
    runInContext(readFileSync(join(LIVE, 'hook.js'), 'utf8'), ctx);
    const read = (k: symbol) => runInContext(`globalThis[Symbol.for('${k.description}')]`, ctx);
    return { [HOOK]: read(HOOK), [STAGE]: read(STAGE), window: win, ET } as any;
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('inspector hook', () => {
    test('defines the hook and announces each app once, after the line has merged its pc', async () => {
        const g = hookIn();
        const seen: any[] = [];
        g[STAGE].onApp((e: any) => seen.push(e));
        const app = { id: 1 };
        const pc = { version: '2.23.0' };
        g[HOOK].register(app, { version: '2.23.0', revision: 'r', protocol: 1 });
        g[HOOK].register(app, { version: '2.23.0', revision: 'r', protocol: 1, pc, pause: 'p' });
        await tick();
        assert.equal(seen.length, 1);
        assert.equal(seen[0].app, app);
        assert.equal(seen[0].pc, pc);
        assert.equal(seen[0].pause, 'p');
        assert.equal(seen[0].version, '2.23.0');

        // a listener added later still hears of apps already registered
        const late: any[] = [];
        g[STAGE].onApp((e: any) => late.push(e));
        assert.equal(late[0].app, app);
    });

    test('chains an existing hook: forwards the first registration of each app only', async () => {
        const calls: any[] = [];
        const prev = {
            register: (...a: any[]) => calls.push(['register', ...a]),
            unregister: (...a: any[]) => calls.push(['unregister', ...a]),
            extra: 42
        };
        const g = hookIn(prev);
        const app = {};
        const info = { version: '2.23.0', protocol: 1 };
        g[HOOK].register(app, info);
        g[HOOK].register(app, { ...info, pc: {} });
        g[HOOK].register({}, info);
        assert.deepEqual(
            calls.map((c) => c[0]),
            ['register', 'register']
        );
        assert.equal(calls[0][1], app);
        assert.equal(calls[0][2], info);
        assert.equal(g[HOOK].extra, 42);
        g[HOOK].unregister(app);
        assert.deepEqual(calls.at(-1), ['unregister', app]);
        assert.equal(g[STAGE].apps.has(app), false);
    });

    test('a throwing chained hook never breaks the app', () => {
        const g = hookIn({
            register: () => {
                throw new Error('x');
            }
        });
        assert.doesNotThrow(() => g[HOOK].register({}, { version: '2.23.0' }));
    });
});

describe('input ownership by scope', () => {
    const setup = () => {
        const g = hookIn();
        const st = g[STAGE];
        const t = new g.ET();
        const heard: string[] = [];
        return { st, t, heard, fire: (type = 'keydown', target = t) => target.dispatchEvent(new Event(type)) };
    };

    test('paused, the app hears no input and ours hear all of it; playing, the reverse', () => {
        const { st, t, heard, fire } = setup();
        t.addEventListener('keydown', () => heard.push('app'));
        st.ours(() => t.addEventListener('keydown', () => heard.push('ours')));
        fire();
        assert.deepEqual(heard, ['app']);
        st.gate.paused = true;
        fire();
        assert.deepEqual(heard, ['app', 'ours']);
    });

    test('playing, an event from our hud reaches only ours', () => {
        const { st, t, heard } = setup();
        const hud = new (Object.getPrototypeOf(t).constructor)();
        st.gate.ui.add(hud);
        t.addEventListener('pointerdown', () => heard.push('app'));
        st.ours(() => t.addEventListener('pointerdown', () => heard.push('ours')));
        const e = new Event('pointerdown');
        Object.defineProperty(e, 'composedPath', { value: () => [hud, t] });
        t.dispatchEvent(e);
        assert.deepEqual(heard, ['ours']);
    });

    test('a listener added while one of ours runs is ours; one added by the app’s is the app’s', () => {
        const { st, t, heard, fire } = setup();
        st.ours(() => t.addEventListener('click', () => t.addEventListener('keydown', () => heard.push('mode'))));
        t.addEventListener('message', () => t.addEventListener('keyup', () => heard.push('app')));
        st.gate.paused = true;
        fire('click');
        fire('message');
        fire('keydown');
        fire('keyup');
        assert.deepEqual(heard, ['mode']);
    });

    test('events that are not input are never gated', () => {
        const { st, t, heard, fire } = setup();
        t.addEventListener('message', () => heard.push('app'));
        st.gate.paused = true;
        fire('message');
        assert.deepEqual(heard, ['app']);
    });

    test('a blur can go to the app’s listeners only', () => {
        const { st, t, heard } = setup();
        t.addEventListener('blur', () => heard.push('app'));
        st.ours(() => t.addEventListener('blur', () => heard.push('ours')));
        st.gate.paused = true;
        st.toApp(() => t.dispatchEvent(new Event('blur')));
        assert.deepEqual(heard, ['app']);
    });

    test('removeEventListener, duplicate adds, once, and handleEvent objects behave as unwrapped', () => {
        const { t, heard, fire } = setup();
        const f = () => heard.push('f');
        t.addEventListener('keydown', f);
        t.addEventListener('keydown', f);
        fire();
        assert.deepEqual(heard, ['f']);
        t.removeEventListener('keydown', f);
        fire();
        assert.deepEqual(heard, ['f']);
        t.addEventListener('keydown', f, true);
        t.removeEventListener('keydown', f);
        fire();
        assert.deepEqual(heard, ['f', 'f'], 'a capture listener needs a capture remove');
        t.removeEventListener('keydown', f, { capture: true });
        const o = { handleEvent: () => heard.push('o') };
        t.addEventListener('keyup', o, { once: true });
        fire('keyup');
        fire('keyup');
        t.addEventListener('keyup', o);
        fire('keyup');
        assert.deepEqual(heard, ['f', 'f', 'o', 'o']);
        const ac = new AbortController();
        t.addEventListener('keypress', f, { signal: ac.signal });
        ac.abort();
        t.addEventListener('keypress', f);
        fire('keypress');
        assert.deepEqual(heard, ['f', 'f', 'o', 'o', 'f'], 'a re-add after an abort registers again');
    });

    test('our hotkeys are heard first and stop the event outright', () => {
        const g = hookIn();
        const st = g[STAGE];
        const heard: string[] = [];
        const w = g.window;
        w.addEventListener('keydown', () => heard.push('app'), true);
        st.gate.hotkey = (e: any) => e.key === 'F8';
        const k = (key: string) => {
            const e = new Event('keydown', { cancelable: true });
            Object.defineProperty(e, 'key', { value: key });
            w.dispatchEvent(e);
            return e.defaultPrevented;
        };
        assert.equal(k('F8'), true);
        assert.deepEqual(heard, []);
        k('a');
        assert.deepEqual(heard, ['app']);
    });
});

describe('engine discovery', () => {
    class Entity {
        kind = 'entity';
    }
    const engine = (version = '2.23.0') => ({ Entity, version });
    const entry = (extra = {}) => ({ app: { root: new Entity() }, version: '2.23.0', ...extra });
    const env = (over: Record<string, unknown> = {}) => ({
        pc: undefined,
        importMap: undefined,
        resources: [],
        load: async () => {
            throw new Error('no module');
        },
        ...over
    });

    test('the line hands over the module', async () => {
        const pc = engine();
        assert.deepEqual(await core.findEngine(entry({ pc }), env()), { pc, via: 'line' });
    });
    test('a script build is globalThis.pc', async () => {
        const pc = engine();
        assert.deepEqual(await core.findEngine(entry(), env({ pc })), { pc, via: 'script' });
    });
    test('a module build is the same url imported again, import map first', async () => {
        const pc = engine();
        const tried: string[] = [];
        const load = async (u: string) => {
            tried.push(u);
            if (u === 'https://cdn/playcanvas.mjs') {
                return pc;
            }
            throw new Error('404');
        };
        const r = await core.findEngine(
            entry(),
            env({
                importMap: 'https://cdn/playcanvas.mjs',
                resources: ['http://x/node_modules/.vite/deps/playcanvas.js?v=1'],
                load
            })
        );
        assert.deepEqual(r, { pc, via: 'module' });
        assert.deepEqual(tried, ['https://cdn/playcanvas.mjs']);
    });
    test('vite dev serves the engine from its deps; only playcanvas-named scripts are tried', async () => {
        const pc = engine();
        const tried: string[] = [];
        const load = async (u: string) => (tried.push(u), u.includes('.vite/deps/playcanvas') ? pc : {});
        const r = await core.findEngine(
            entry(),
            env({
                resources: ['http://x/src/main.js', 'http://x/node_modules/.vite/deps/playcanvas.js?v=1'],
                load
            })
        );
        assert.equal(r.via, 'module');
        assert.deepEqual(tried, ['http://x/node_modules/.vite/deps/playcanvas.js?v=1']);
    });
    test('a module whose Entity is not the app’s is another engine copy', async () => {
        class Other {
            kind = 'other';
        }
        const r = await core.findEngine(entry(), env({ pc: { Entity: Other, version: '2.23.0' } }));
        assert.equal(r.pc, null);
    });
    test('a bundled engine without the line has no module to find', async () => {
        const r = await core.findEngine(entry(), env());
        assert.equal(r.pc, null);
    });

    test('an app that never announced itself (below 2.23, or devtools off) is found through its engine', async () => {
        const app = { root: new Entity() };
        const pc = { ...engine('2.22.5'), AppBase: { getApplication: () => app } };
        assert.deepEqual(await core.findAnyEngine(env({ pc })), { pc, app });
        const load = async (u: string) => (u.includes('playcanvas') ? pc : {});
        assert.deepEqual(
            await core.findAnyEngine(env({ resources: ['http://x/a.js', 'http://x/playcanvas.min.mjs'], load })),
            {
                pc,
                app
            }
        );
        assert.equal(await core.findAnyEngine(env()), null);
        const none = { ...engine(), AppBase: { getApplication: () => undefined } };
        assert.equal(await core.findAnyEngine(env({ pc: none })), null);
    });

    test('problems say what is missing and how to fix it', () => {
        assert.equal(core.problem({ version: '2.23.0' }, engine()), null);
        assert.equal(core.problem({ version: '2.24.1' }, engine('2.24.1')), null);
        assert.match(
            core.problem({ version: '2.22.5' }, engine('2.22.5')),
            /2\.22\.5.*2\.23\.0 or newer.*npm i playcanvas@\^2\.23/
        );
        assert.match(core.problem({ version: '2.23.0' }, null), /bundled.*register\(app, \{ version: pc\.version/s);
        assert.match(core.problem(null, null), /no PlayCanvas app/);
    });
});

test('the inspector shows on engines in its peer range only', () => {
    for (const v of ['2.23.0', '2.23.4', '2.30.1']) {
        assert.equal(core.satisfies('^2.23.0', v), true, v);
    }
    for (const v of ['2.22.9', '3.0.0', '2.24.0-beta.1', '2.23.0-beta.24', 'x', undefined]) {
        assert.equal(core.satisfies('^2.23.0', v), false, String(v));
    }
    assert.equal(core.satisfies('>=2', '2.23.0'), false, 'only caret ranges are read');
});

describe('entity paths and edits', () => {
    const node = (name: string, kids: any[] = []) => {
        const n: any = { name, children: kids, parent: null };
        for (const k of kids) {
            k.parent = n;
        }
        return n;
    };
    const lamp = node('Lamp');
    const dup1 = node('Coin');
    const dup2 = node('Coin');
    const root = node('Root', [node('Desk', [lamp]), dup1, dup2]);

    test('paths are names below the root', () => {
        assert.equal(core.pathOf(lamp, root), '/Desk/Lamp');
        assert.deepEqual(core.nodesAt(root, '/Desk/Lamp'), [lamp]);
        assert.deepEqual(core.nodesAt(root, '/Coin'), [dup1, dup2]);
        assert.deepEqual(core.nodesAt(root, '/Nope'), []);
    });

    test('doc ids are stable, db-safe and distinct per path', () => {
        const a = core.docIdOf('/Desk/Lamp');
        assert.equal(a, core.docIdOf('/Desk/Lamp'));
        assert.notEqual(a, core.docIdOf('/Desk/Lamp2'));
        assert.match(a, /^[A-Za-z0-9_\-.~:@+]{1,200}$/);
        assert.match(core.docIdOf(`/${'x'.repeat(500)}`), /^[A-Za-z0-9_\-.~:@+]{1,200}$/);
    });

    test('an edit is set while off its base and deleted back on it', () => {
        const base = { pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] };
        const to = { pos: [0.123456, 1, 0], rot: [0, 180, 0], scale: [1, 1, 1] };
        const id = core.docIdOf('/Desk/Lamp');
        assert.deepEqual(core.editWrite('/Desk/Lamp', to, base, false), {
            op: 'set',
            path: `edits/${id}`,
            data: { path: '/Desk/Lamp', pos: [0.1235, 1, 0], rot: [0, 180, 0], scale: [1, 1, 1] }
        });
        assert.deepEqual(
            core.editWrite('/Desk/Lamp', { ...base, rot: [180, 0, 180] }, { ...base, rot: [0, 180, 0] }, true),
            {
                op: 'delete',
                path: `edits/${id}`
            }
        );
        assert.equal(core.editWrite('/Desk/Lamp', base, base, false), null);
    });

    test('validEdit takes three finite vectors only', () => {
        const t = { pos: [1, 2, 3], rot: [0, 0, 0], scale: [1, 1, 1] };
        assert.deepEqual(core.validEdit({ ...t, path: '/A' }), t);
        for (const bad of [null, {}, { ...t, pos: [1, 2] }, { ...t, rot: [0, null, 0] }]) {
            assert.equal(core.validEdit(bad), null);
        }
    });

    test('history undoes and redoes ops; a push drops the redo branch', () => {
        const h = core.createHistory(2);
        h.push([{ id: 'a', before: 1, after: 2 }]);
        h.push([{ id: 'a', before: 2, after: 3 }]);
        h.push([{ id: 'a', before: 3, after: 4 }]);
        assert.deepEqual(h.undo(), [{ id: 'a', to: 3 }]);
        assert.deepEqual(h.undo(), [{ id: 'a', to: 2 }]);
        assert.equal(h.undo(), null);
        assert.deepEqual(h.redo(), [{ id: 'a', to: 3 }]);
        h.push([{ id: 'a', before: 3, after: 9 }]);
        assert.equal(h.redo(), null);
    });
});
