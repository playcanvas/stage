// finds the live app and its engine, fills in the engine bridge, and mounts the scene tools on the app
import { findAnyEngine, findEngine, problem } from './core.mjs';
import { set } from './engine.mjs';

// apps that never call the hook (below 2.23, or devtools: false) are looked for this long after load
const FALLBACK_MS = 1500;

const stage = globalThis[Symbol.for('playcanvas.stage')];
let started = false;

// the frame runtime tells the viewer; the console line reaches the stage's diagnostics
const report = (text) => {
    if (text) {
        console.warn(`Stage: ${text}`);
    }
    document.dispatchEvent(new CustomEvent('agent:live', { detail: { problem: text } }));
};

const env = () => {
    const map = document.querySelector('script[type="importmap"]');
    let importMap;
    try {
        const u = JSON.parse(map?.textContent ?? '{}').imports?.playcanvas;
        importMap = u && new URL(u, document.baseURI).href;
    } catch {}
    return {
        pc: globalThis.pc,
        importMap,
        resources: performance.getEntriesByType('resource').map((r) => r.name),
        load: (u) => import(u)
    };
};

const mount = async (entry) => {
    if (started) {
        return;
    }
    started = true;
    const { pc } = await findEngine(entry, env());
    const why = problem(entry, pc);
    if (why) {
        return report(why);
    }
    set(pc);
    const { mountTools } = await import('./scene-tools.mjs');
    stage.tools = await mountTools(entry);
    report(null);
};

stage?.onApp((e) =>
    mount(e).catch((err) => console.error(`Stage: the scene tools did not mount: ${err?.stack ?? err}`))
);

const fallback = async () => {
    if (started) {
        return;
    }
    const found = await findAnyEngine(env());
    if (started) {
        return;
    }

    // a page with no PlayCanvas at all is just a web page: the viewer shows it as it is
    if (!found) {
        return console.info(`Stage: ${problem(null, null)}`);
    }
    mount({ app: found.app, version: found.pc.version, pc: found.pc }).catch((err) =>
        console.error(`Stage: the scene tools did not mount: ${err?.stack ?? err}`)
    );
};
const later = () => setTimeout(fallback, FALLBACK_MS);
if (document.readyState === 'complete') {
    later();
} else {
    addEventListener('load', later, { once: true });
}
