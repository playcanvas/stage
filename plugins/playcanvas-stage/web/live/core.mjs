// pure logic of the live scene tools; no engine or dom access, so node tests it directly

export const EDITS = 'edits';
export const MIN_ENGINE = [2, 23];
export const MAX_SELECTION = 50;
const EPS = 1e-4;

// 1 - |dot| of two unit quaternions; 1e-8 is about 0.016 degrees
const ROT_EPS = 1e-8;

// the engine is only ever imported again from a url that names it
const ENGINE_URL_RE = /playcanvas[^/]*\.m?js(?:[?#]|$)|\/playcanvas\/(?:build|src)\//i;

export const LINE =
    "globalThis[Symbol.for('playcanvas.inspector')]?.register(app, { version: pc.version, revision: pc.revision, protocol: 1, pc });";

export const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
export const round = (v, d = 4) => v.map((n) => Math.round(n * 10 ** d) / 10 ** d);

const engineOf = (m, app) => {
    try {
        return m && typeof m.Entity === 'function' && app?.root instanceof m.Entity ? m : null;
    } catch {
        return null;
    }
};

/**
 * the app's own engine module: from the line, a script build's globalThis.pc, or the url the page loaded it
 * from, imported again (the same url is the same instance); checked against the app's root entity
 */
export const findEngine = async (entry, env) => {
    const app = entry?.app;
    if (engineOf(entry?.pc, app)) {
        return { pc: entry.pc, via: 'line' };
    }
    if (engineOf(env.pc, app)) {
        return { pc: env.pc, via: 'script' };
    }
    const urls = [...new Set([env.importMap, ...env.resources.filter((u) => ENGINE_URL_RE.test(u))].filter(Boolean))];
    for (const u of urls) {
        const m = await env.load(u).catch(() => null);
        if (engineOf(m, app)) {
            return { pc: m, via: 'module' };
        }
    }
    return { pc: null, via: null };
};

/** an app that never called the hook: the first engine module on the page that knows one */
export const findAnyEngine = async (env) => {
    const urls = [env.importMap, ...env.resources.filter((u) => ENGINE_URL_RE.test(u))].filter(Boolean);
    for (const m of [env.pc, ...urls]) {
        const pc = typeof m === 'string' ? await env.load(m).catch(() => null) : m;
        let app;
        try {
            app = pc?.AppBase?.getApplication?.();
        } catch {}
        if (app && engineOf(pc, app)) {
            return { pc, app };
        }
    }
    return null;
};

const atLeast = (v) => {
    const [a, b] = String(v ?? '')
        .split('.')
        .map(Number);
    return a > MIN_ENGINE[0] || (a === MIN_ENGINE[0] && b >= MIN_ENGINE[1]);
};

/** whether a version is in a caret range (^2.23.0), as npm reads it: prereleases of other versions are not */
export const satisfies = (range, version) => {
    const r = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(String(range ?? ''));
    const v = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(String(version ?? ''));
    if (!r || !v) {
        return false;
    }
    const [a, b] = [r.slice(1).map(Number), v.slice(1, 4).map(Number)];
    if (v[4] && (b[0] !== a[0] || b[1] !== a[1] || b[2] !== a[2])) {
        return false;
    }
    const cmp = b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
    return b[0] === a[0] && (a[0] > 0 ? cmp >= 0 : b[1] === a[1] && cmp >= 0) && !(v[4] && cmp === 0);
};

/** what keeps the tools off an app, said so the person can fix it; null when nothing does */
export const problem = (entry, pc) => {
    const version = pc?.version ?? entry?.version;
    if (!entry && !pc) {
        return 'Stage found no PlayCanvas app on this page.';
    }
    if (version && !atLeast(version)) {
        return `This app runs PlayCanvas ${version}; Stage's tools need ${MIN_ENGINE.join('.')}.0 or newer. Upgrade the project's engine (npm i playcanvas@^2.23) and reload.`;
    }
    if (!pc) {
        return `This app's engine is bundled into its code, so Stage can't reach the parts of it the tools need. Add this line right after the app is created, with \`import * as pc from 'playcanvas'\`:\n${LINE}`;
    }
    return null;
};

/** an entity's path: its name and its ancestors' below the root, from the top */
export const pathOf = (node, root) => {
    const names = [];
    for (let n = node; n && n !== root; n = n.parent) {
        names.unshift(n.name);
    }
    return `/${names.join('/')}`;
};

/** every node at a path, so a path more than one entity shares can be refused */
export const nodesAt = (root, path) => {
    let at = [root];
    for (const name of path.split('/').slice(1)) {
        at = at.flatMap((n) => n.children.filter((c) => c.name === name));
    }
    return at;
};

// a 53-bit hash of the path: doc ids allow only a few characters, and the path itself is in the doc
const hash = (s) => {
    let [a, b] = [0xdeadbeef, 0x41c6ce57];
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        a = Math.imul(a ^ c, 2654435761);
        b = Math.imul(b ^ c, 1597334677);
    }
    a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
    b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
    return (4294967296 * (2097151 & b) + (a >>> 0)).toString(36);
};
export const docIdOf = (path) => `e-${hash(path)}`;

export const validEdit = (d) =>
    d && isVec3(d.pos) && isVec3(d.rot) && isVec3(d.scale) ? { pos: d.pos, rot: d.rot, scale: d.scale } : null;

/** euler degrees to a quaternion, as the engine's Quat#setFromEulerAngles */
const quatOf = ([ex, ey, ez]) => {
    const [sx, cx, sy, cy, sz, cz] = [ex, ey, ez].flatMap((d) => [
        Math.sin((d * Math.PI) / 360),
        Math.cos((d * Math.PI) / 360)
    ]);
    return [
        sx * cy * cz - cx * sy * sz,
        cx * sy * cz + sx * cy * sz,
        cx * cy * sz - sx * sy * cz,
        cx * cy * cz + sx * sy * sz
    ];
};
const near = (a, b) => a.every((n, i) => Math.abs(n - b[i]) < EPS);

// the engine reads rotations back in another euler form (0,180,0 as 180,0,180), so compare orientations
export const sameTransform = (a, b) => {
    const [qa, qb] = [quatOf(a.rot), quatOf(b.rot)];
    return (
        near(a.pos, b.pos) && near(a.scale, b.scale) && Math.abs(qa.reduce((s, n, i) => s + n * qb[i], 0)) > 1 - ROT_EPS
    );
};

/** the db write for an entity moved to `to`: set while off its base, delete an existing doc back on it */
export const editWrite = (path, to, base, existing) => {
    const at = `${EDITS}/${docIdOf(path)}`;
    if (base && sameTransform(to, base)) {
        return existing ? { op: 'delete', path: at } : null;
    }
    return { op: 'set', path: at, data: { path, pos: round(to.pos), rot: round(to.rot), scale: round(to.scale) } };
};

/** undo stack of ops, each op = [{ id, before, after }] */
export const createHistory = (limit = 100) => {
    const undo = [];
    const redo = [];
    return {
        push: (op) => {
            undo.push(op);
            if (undo.length > limit) {
                undo.shift();
            }
            redo.length = 0;
        },
        undo: () => {
            const op = undo.pop();
            if (!op) {
                return null;
            }
            redo.push(op);
            return op.map((o) => ({ id: o.id, to: o.before }));
        },
        redo: () => {
            const op = redo.pop();
            if (!op) {
                return null;
            }
            undo.push(op);
            return op.map((o) => ({ id: o.id, to: o.after }));
        }
    };
};

export const anchorAttrs = (path, point) => ({ entity: path ?? '', point: point ? round(point, 2).join(',') : '' });
