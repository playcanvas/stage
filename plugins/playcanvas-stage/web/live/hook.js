// the first script of a live app's page, ahead of the app's own: engine 2.23+ announces each app it creates to
// globalThis[Symbol.for('playcanvas.inspector')]. this keeps one entry per app, merges a second registration (the
// line a bundled app adds to hand over its engine module), and chains a hook already there (the inspector extension)
(() => {
    const KEY = Symbol.for('playcanvas.inspector');
    const OURS = Symbol.for('playcanvas.stage');
    if (globalThis[OURS]) {
        return;
    }
    const prev = globalThis[KEY];
    const apps = new Map();
    const listeners = [];
    const safe = (f) => {
        try {
            f();
        } catch {}
    };
    const deliver = (l, e) => {
        if (l.seen.has(e)) {
            return;
        }
        l.seen.add(e);
        safe(() => l.fn(e));
    };

    // announced a microtask later, so the line's merge right after `new Application()` lands first
    const announce = (e) => queueMicrotask(() => apps.get(e.app) === e && listeners.forEach((l) => deliver(l, e)));

    globalThis[KEY] = Object.assign(Object.create(prev ?? null), {
        register(app, info) {
            const known = apps.get(app);
            if (known) {
                return void Object.assign(known, info, { app });
            }
            const e = { ...info, app };
            apps.set(app, e);
            safe(() => prev?.register?.(app, info));
            announce(e);
        },
        unregister(app) {
            apps.delete(app);
            safe(() => prev?.unregister?.(app));
        }
    });
    // input ownership by scope: a listener is the app's unless it was registered inside ours(). paused, the app's
    // hear no input and ours hear all of it; playing, ours hear only what comes from our ui (the hud, the
    // inspector panel), and the app's everything but that
    const INPUT_RE = /^(key|pointer|mouse|wheel|touch|click$|dblclick$|contextmenu$|auxclick$|gesture|drag|drop$)/;
    const gate = { paused: false, ui: new Set(), only: null, hotkey: null };
    let scope = 0;
    const fromHud = (e) => gate.ui.size > 0 && !!e.composedPath && e.composedPath().some((n) => gate.ui.has(n));
    const allowed = (mine, e) => {
        if (gate.only) {
            return gate.only === (mine ? 'ours' : 'app');
        }
        if (!INPUT_RE.test(e.type)) {
            return true;
        }
        return mine ? gate.paused || fromHud(e) : !gate.paused && !fromHud(e);
    };

    const EP = EventTarget.prototype;
    const add = EP.addEventListener;
    const remove = EP.removeEventListener;
    const wrapped = new WeakMap();
    const captureOf = (o) => (typeof o === 'boolean' ? o : !!o?.capture);
    const entries = (fn) => {
        let list = wrapped.get(fn);
        if (!list) {
            wrapped.set(fn, (list = []));
        }
        return list;
    };
    const drop = (list, x) => list.splice(list.indexOf(x), 1);
    EP.addEventListener = function (type, fn, opts) {
        if (!fn || (typeof fn !== 'function' && typeof fn.handleEvent !== 'function')) {
            return add.call(this, type, fn, opts);
        }
        const list = entries(fn);
        const capture = captureOf(opts);

        // the same listener added twice is one listener, as unwrapped
        if (list.some((x) => x.target === this && x.type === type && x.capture === capture)) {
            return;
        }
        const mine = scope > 0;
        const x = { target: this, type, capture };
        // what one of ours does when it runs is ours too: a button of ours that turns on a mode adds its listeners
        x.w = function (e) {
            if (opts?.once) {
                drop(list, x);
            }
            if (!allowed(mine, e)) {
                return;
            }
            const call = () => (typeof fn === 'function' ? fn.call(this, e) : fn.handleEvent(e));
            return mine ? ours(call) : call();
        };
        list.push(x);
        opts?.signal?.addEventListener?.('abort', () => list.includes(x) && drop(list, x), { once: true });
        return add.call(this, type, x.w, opts);
    };
    EP.removeEventListener = function (type, fn, opts) {
        const list = fn && wrapped.get(fn);
        const capture = captureOf(opts);
        const x = list?.find((y) => y.target === this && y.type === type && y.capture === capture);
        if (!x) {
            return remove.call(this, type, fn, opts);
        }
        drop(list, x);
        return remove.call(this, type, x.w, opts);
    };

    const run = (f) => {
        try {
            return [null, f()];
        } catch (e) {
            return [e];
        }
    };
    const within = (f, set) => {
        const [e, r] = run(f);
        set();
        if (e) {
            throw e;
        }
        return r;
    };

    /** runs fn with every listener it registers counted as ours */
    const ours = (f) => (scope++, within(f, () => scope--));

    /** dispatches inside fn reach the app's listeners only */
    const toApp = (f) => ((gate.only = 'app'), within(f, () => (gate.only = null)));

    // our hotkeys (play/pause, step) are heard before anything else and stop the event outright
    add.call(
        window,
        'keydown',
        (e) => {
            if (!gate.hotkey?.(e)) {
                return;
            }
            e.preventDefault();
            e.stopImmediatePropagation();
        },
        true
    );

    // pointers something holds captured, so a pause can let them go
    const captured = new Map();
    add.call(window, 'gotpointercapture', (e) => captured.set(e.pointerId, e.target), true);
    add.call(window, 'lostpointercapture', (e) => captured.delete(e.pointerId), true);
    const release = () => {
        for (const [id, t] of captured) {
            run(() => t.releasePointerCapture(id));
        }
        captured.clear();
    };

    // paused, the app can't take the pointer
    const lock = globalThis.Element?.prototype.requestPointerLock;
    if (lock) {
        Element.prototype.requestPointerLock = function (...a) {
            return gate.paused ? Promise.resolve() : lock.apply(this, a);
        };
    }

    globalThis[OURS] = {
        apps,
        gate,
        ours,
        toApp,
        release,
        inOurs: () => scope > 0,
        onApp: (fn) => {
            const l = { fn, seen: new Set() };
            listeners.push(l);
            for (const e of apps.values()) {
                deliver(l, e);
            }
        }
    };
})();
