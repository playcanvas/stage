// the mini-stats over a live app's canvas, in the inspector's look: frame, cpu and gpu times, draw calls, memory and
// resource counts, averaged and peaked every half second, with a strip of history per row at the largest size.
// html over the canvas rather than drawn into it, so it takes the page's type and stays out of comment captures

// the size and the collapsed groups, kept across the app's reloads
const SIZE_KEY = 'stage-ministats-size';
const COLLAPSED_KEY = 'stage-ministats-collapsed';

// how often the text refreshes, and how many frames a gpu pass reads zero before its row goes
const REFRESH = 500;
const DROP_AFTER = 240;

const SIZES = ['compact', 'detailed', 'graphs'];
const MB = 1 / (1024 * 1024);

// a graph's height in css pixels; a bar fills it at 1.5 times the row's watermark, orange above the watermark
const GRAPH_W = 72;
const GRAPH_H = 14;
const GRAPH_RANGE = 1.5;

const CPU = [
    ['renderTime', 'Render'],
    ['scriptUpdate', 'Script update'],
    ['scriptPostUpdate', 'Script post-update'],
    ['animUpdate', 'Animation', true],
    ['physicsTime', 'Physics', true],
    ['gsplatSort', 'Splat sort', true]
];
const VRAM = [
    ['tex', 'Textures'],
    ['geom', 'Geometry'],
    ['buffers', 'Buffers']
];
const RESOURCES = [
    ['vertexBuffers', 'Vertex buffers'],
    ['indexBuffers', 'Index buffers'],
    ['uniformBuffers', 'Uniform buffers'],
    ['storageBuffers', 'Storage buffers', 'webgpu'],
    ['textures', 'Textures'],
    ['renderTargets', 'Render targets'],
    ['shaders', 'Shaders', 'webgl'],
    ['computes', 'Computes'],
    ['bindGroups', 'Bind groups'],
    ['bindGroupFormats', 'Bind group formats'],
    ['drawCommands', 'Draw commands'],
    ['renderPipelines', 'Render pipelines'],
    ['computePipelines', 'Compute pipelines']
];

const SIZE_ICON =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';

// the inspector's palette (inspector/src/styles.js), dark as it is
const STYLE = `
:host { all: initial; position: fixed; z-index: 99999; display: block; color-scheme: dark; contain: layout style;
    transform-origin: 0 100%;
    --bg: #182022; --bar: #13191b; --raised: #1f282a; --hover: rgba(255, 255, 255, 0.06);
    --border: rgba(255, 255, 255, 0.07); --border-strong: rgba(255, 255, 255, 0.12);
    --text: #eef2f3; --label: #93a2a6; --muted: #7f8f93; --faint: #56656a; --value: #b5cea8; --accent: #ff6600;
    --font: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --mono: ui-monospace, Menlo, Consolas, "Liberation Mono", monospace; }
* { box-sizing: border-box; }
.panel { display: flex; flex-direction: column; overflow: hidden; background: var(--bg); color: var(--label);
    font: 12px/1.45 var(--font); border: 1px solid var(--border-strong);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35); user-select: none; -webkit-user-select: none; }
.panel.compact { width: 168px; }
.panel.detailed { width: 248px; }
.panel.graphs { width: 324px; }
.row, .bar { display: grid; grid-template-columns: minmax(0, 1fr) var(--graph, 0) 48px var(--peak, 40px);
    align-items: center; column-gap: 6px; height: 20px; padding: 0 10px; white-space: nowrap; }
.compact { --peak: 0; }
.graphs { --graph: ${GRAPH_W}px; }
.bar { height: 28px; background: var(--bar); border-bottom: 1px solid var(--border); color: var(--muted); font-size: 11px; }
.bar .title { display: flex; align-items: center; gap: 6px; color: var(--text); font-size: 11.5px; font-weight: 600; }
.bar .avg, .bar .peak { color: var(--muted); font: 11px var(--font); }
.compact .bar .avg, .compact .bar .peak { visibility: hidden; }
.size { display: grid; place-items: center; width: 20px; height: 20px; padding: 0; border: 0;
    border-radius: 4px; background: transparent; color: var(--muted); cursor: pointer; }
.size:hover { background: var(--hover); color: var(--text); }
.body { overflow-y: auto; padding-bottom: 4px; scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.18) transparent; }
.group + .group { margin-top: 2px; }
.head { width: 100%; margin: 0; border: 0; font: inherit; text-align: left; background: var(--raised); color: var(--text);
    font-size: 11.5px; font-weight: 600; cursor: pointer; }
.head:hover { background: #253033; }
.head .name::before { content: '\\25BE'; display: inline-block; width: 12px; color: var(--muted); font-weight: 400; }
.collapsed .head .name::before { content: '\\25B8'; }
.collapsed .rows { display: none; }
.row:not(.head) { padding-left: 22px; }
.row:not(.head):hover { background: var(--hover); }
.name { overflow: hidden; text-overflow: ellipsis; }
.unit { margin-left: 4px; color: var(--muted); font-size: 10.5px; font-weight: 400; }
.avg, .peak { font: 10.5px var(--mono); font-variant-numeric: tabular-nums; text-align: right; overflow: hidden; }
.avg { color: var(--value); }
.peak { color: var(--muted); }
.compact .peak, .count .peak { visibility: hidden; }
canvas { visibility: hidden; width: 100%; height: ${GRAPH_H}px; background: rgba(255, 255, 255, 0.03); }
.graphs canvas { visibility: visible; }
.graphs .count canvas, .graphs .blank canvas { visibility: hidden; }
.compact .group:not(.flat) .rows, .compact .flat .head, .compact .counts { display: none; }
.compact .flat .rows { display: block; }
.compact .head { background: transparent; color: var(--label); font-size: 12px; font-weight: 400; cursor: default; }
.compact .head .name::before { content: none; }
.compact .row:not(.head) { padding-left: 10px; }
`;

const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) {
        e.className = cls;
    }
    if (text != null) {
        e.textContent = text;
    }
    return e;
};

// a graph's pixels at the screen's ratio; resizing clears it, so only when that changes
const fit = (c) => {
    const dpr = devicePixelRatio || 1;
    const [w, h] = [Math.round(GRAPH_W * dpr), Math.round(GRAPH_H * dpr)];
    if (c.width !== w || c.height !== h) {
        Object.assign(c, { width: w, height: h });
    }
    return c;
};

/** the panel, shown; `enabled` hides and shows it, and `div` is its host element */
export const createStats = (app, canvas) => {
    const device = app.graphicsDevice;
    const st = app.stats;
    const prof = device.gpuProfiler ?? null;
    const counts = typeof device.getResourceCounts === 'function' ? new Map() : null;
    const collapsed = new Set((localStorage.getItem(COLLAPSED_KEY) ?? 'Resources').split(','));
    let size = Math.min(SIZES.length - 1, Math.max(0, Number(localStorage.getItem(SIZE_KEY) ?? 1) | 0));

    const host = document.createElement('stage-stats');
    const root = host.attachShadow({ mode: 'open' });
    const style = el('style', '', STYLE);
    const panel = el('div', 'panel');
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'MiniStats');
    const bar = el('div', 'bar');
    const sizeBtn = el('button', 'size');
    sizeBtn.type = 'button';
    sizeBtn.innerHTML = SIZE_ICON;
    const title = el('span', 'title', 'MiniStats');
    title.append(sizeBtn);
    const avg = el('span', 'avg', 'Avg');
    const peak = el('span', 'peak', 'Peak');
    avg.title = `The average over ${REFRESH / 1000} s`;
    peak.title = `The highest over ${REFRESH / 1000} s`;
    bar.append(title, el('span'), avg, peak);
    const body = el('div', 'body');
    panel.append(bar, body);
    root.append(style, panel);

    const groups = [];
    const group = (name, o = {}) => {
        const g = { name, unit: o.unit ?? '', dp: o.dp ?? 1, mark: o.mark ?? 0, count: !!o.count, rows: [] };
        g.el = el('div', `group${o.flat ? ' flat' : ''}${o.count ? ' counts' : ''}`);
        g.list = el('div', 'rows');
        g.head = row(g, name, o.read, { head: true, unit: g.unit, value: !!o.read || g.count });
        g.el.append(g.head.el, g.list);
        g.el.classList.toggle('collapsed', collapsed.has(name));
        body.append(g.el);
        groups.push(g);
        return g;
    };

    // a row's text refreshes from what it sampled since the last refresh; a graph is drawn only at the largest size
    function row(g, label, read, o = {}) {
        const r = { g, label, read, dp: o.dp ?? g.dp, mark: o.mark ?? g.mark, sum: 0, n: 0, max: 0, a: '', p: '' };
        r.el = el(
            o.head ? 'button' : 'div',
            `row${o.head ? ' head' : ''}${g.count ? ' count' : ''}${o.head && !o.value ? ' blank' : ''}`
        );
        const name = el('span', 'name', label);
        if (o.unit) {
            name.append(el('span', 'unit', o.unit));
        }
        r.graph = fit(el('canvas'));
        r.avg = el('span', 'avg', o.head && !o.value ? '' : '—');
        r.peak = el('span', 'peak', o.head && !o.value ? '' : '—');
        r.el.append(name, r.graph, r.avg, r.peak);
        if (o.head) {
            r.el.type = 'button';
            r.el.setAttribute('aria-expanded', String(!collapsed.has(label)));
        } else {
            g.list.append(r.el);
        }
        if (!o.head) {
            g.rows.push(r);
        }
        return r;
    }
    const drop = (g, r) => (r.el.remove(), g.rows.splice(g.rows.indexOf(r), 1));

    group('Engine', { flat: true });
    const engine = groups[0];
    row(engine, 'Draw calls', () => st.drawCalls.total, { dp: 0, mark: 1000 });
    row(engine, 'Frame', () => st.frame.ms, { mark: 33 });
    engine.rows[1].el.firstChild.append(el('span', 'unit', 'ms'));

    // cpu: the app's update and render, timed as the engine's mini-stats do, and the parts it reports
    let t0 = 0;
    let t1 = 0;
    let upd = 0;
    let cpuMs = 0;
    const cpu = group('CPU', { unit: 'ms', mark: 33, read: () => cpuMs });
    const cpuRows = new Map();
    for (const [k, label, later] of CPU) {
        if (!later) {
            cpuRows.set(
                k,
                row(cpu, label, () => st.frame[k])
            );
        }
    }

    // gpu: the profiler's frame time once it has one, and its passes while they take time
    const gpu = prof && group('GPU', { unit: 'ms', mark: 33, read: () => prof.frameTime });
    const passes = new Map();

    const vram = group('VRAM', { unit: 'MB', mark: 1024, read: () => st.vram.totalUsed * MB });
    for (const [k, label] of VRAM.slice(0, device.isWebGPU ? 3 : 2)) {
        row(vram, label, () => st.vram[k] * MB);
    }

    const res = counts && group('Resources', { count: true, dp: 0 });
    const resRows = new Map();

    const sizeTitle = () => {
        panel.className = `panel ${SIZES[size]}`;
        sizeBtn.title = `Size: ${SIZES[size]}. Click for ${SIZES[(size + 1) % SIZES.length]}`;
        sizeBtn.setAttribute('aria-label', sizeBtn.title);
    };
    sizeTitle();

    const all = () => groups.flatMap((g) => (g.head.read ? [g.head, ...g.rows] : g.rows));

    // a bar for this frame at the right of the graph, after moving the rest one pixel left. the graphs are drawn in
    // software (willReadFrequently): on the gpu, a dozen tiny canvases redrawn each frame cost the app about 20% of
    // its frame rate, measured; in software, nothing measurable
    const plot = (r, v) => {
        const c = r.graph;
        const ctx = (r.ctx ??= c.getContext('2d', { willReadFrequently: true }));
        const h = c.height;
        ctx.globalCompositeOperation = 'copy';
        ctx.drawImage(c, -1, 0);
        ctx.globalCompositeOperation = 'source-over';
        if (!(v > 0) || !r.mark) {
            return;
        }
        const y = Math.min(1, v / (GRAPH_RANGE * r.mark)) * h;
        const m = Math.min(y, h / GRAPH_RANGE);
        ctx.fillStyle = 'rgba(147, 162, 166, 0.55)';
        ctx.fillRect(c.width - 1, h - m, 1, m);
        if (y <= m) {
            return;
        }
        ctx.fillStyle = '#ff6600';
        ctx.fillRect(c.width - 1, h - y, 1, y - m);
    };
    const fitGraphs = () => all().forEach((r) => fit(r.graph));

    const sample = (r, v, graph) => {
        if (Number.isFinite(v)) {
            r.sum += v;
            r.n++;
            if (v > r.max) {
                r.max = v;
            }
        }
        if (graph) {
            plot(r, v);
        }
    };
    const show = (r, a, p) => {
        if (a !== r.a) {
            r.avg.textContent = r.a = a;
        }
        if (p !== r.p) {
            r.peak.textContent = r.p = p;
        }
    };
    const flush = (r) => {
        show(r, r.n ? (r.sum / r.n).toFixed(r.dp) : '—', r.n ? r.max.toFixed(r.dp) : '—');
        r.sum = r.n = r.max = 0;
    };

    // the panel sits 12px in from the canvas's bottom left, as the hud sits from its top left, no taller than it. a
    // device fit to the viewer scales the whole page, so the panel divides that scale out, to stay its size on screen
    let k = 1;
    const follow = () => {
        const c = canvas.getBoundingClientRect();
        host.style.left = `${Math.max(0, c.left) + 12 * k}px`;
        host.style.bottom = `${Math.max(0, innerHeight - c.bottom) + 12 * k}px`;
        host.style.transform = k === 1 ? '' : `scale(${k})`;
        panel.style.maxHeight = `${Math.max(64, (Math.min(c.bottom, innerHeight) - Math.max(0, c.top)) / k - 24)}px`;
    };
    const onZoom = (e) => {
        k = 1 / e.detail.s;
        follow();
    };
    document.addEventListener('agent:zoom', onZoom);
    document.dispatchEvent(new Event('agent:zoom-ask'));

    let enabled = true;
    let frame = 0;
    let last = performance.now();
    let saved = prof?.enabled;
    if (prof) {
        prof.enabled = true;
    }

    const onUpdate = () => (t0 = performance.now());
    const onRender = () => ((t1 = performance.now()), (upd = t1 - t0));
    const onEnd = () => {
        if (!enabled) {
            return;
        }
        const now = performance.now();
        cpuMs = upd + (now - t1);
        frame++;
        const graphs = size === 2;
        const detailed = size > 0;

        if (detailed) {
            for (const [k, label, later] of CPU) {
                if (later && !cpuRows.has(k) && st.frame[k] > 0) {
                    cpuRows.set(
                        k,
                        row(cpu, label, () => st.frame[k])
                    );
                }
            }
            if (gpu) {
                for (const [name, ms] of st.gpu) {
                    let r = passes.get(name);
                    if (!r && !(ms > 0)) {
                        continue;
                    }
                    if (!r) {
                        passes.set(name, (r = row(gpu, name, null)));
                    }
                    if (ms > 0) {
                        r.seen = frame;
                    }
                }
            }
        }
        for (const g of groups) {
            if (g.count) {
                continue;
            }
            const open = graphs && !collapsed.has(g.name);
            if (g.head.read) {
                sample(g.head, g.head.read(), graphs);
            }
            for (const r of g.rows) {
                sample(r, r.read ? r.read() : st.gpu.get(r.label), open);
            }
        }

        if (now - last < REFRESH) {
            return;
        }
        last = now;
        for (const r of all()) {
            if (!r.g.count) {
                flush(r);
            }
        }
        for (const [name, r] of passes) {
            if (frame - (r.seen ?? 0) <= DROP_AFTER) {
                continue;
            }
            passes.delete(name);
            drop(gpu, r);
        }
        if (res && detailed) {
            device.getResourceCounts(counts);
            let total = 0;
            for (const [k, label, only] of RESOURCES) {
                const n = counts.get(k);
                if (n === undefined || (only && only !== (device.isWebGPU ? 'webgpu' : 'webgl'))) {
                    continue;
                }
                total += n;
                let r = resRows.get(k);
                if (!r) {
                    resRows.set(k, (r = row(res, label, null)));
                }
                show(r, String(n), '');
            }
            show(res.head, String(total), '');
        }
        follow();
        if (graphs) {
            fitGraphs();
        }
    };
    app.on('frameupdate', onUpdate);
    app.on('framerender', onRender);
    app.on('frameend', onEnd);

    const reset = () => {
        for (const r of all()) {
            r.sum = r.n = r.max = 0;
        }
        last = performance.now() - REFRESH;
    };

    sizeBtn.addEventListener('click', () => {
        size = (size + 1) % SIZES.length;
        localStorage.setItem(SIZE_KEY, String(size));
        sizeTitle();
        if (size === 2) {
            fitGraphs();
        }
        reset();
    });
    for (const g of groups) {
        g.head.el.addEventListener('click', () => {
            if (size === 0) {
                return;
            }
            const on = !collapsed.has(g.name);
            if (on) {
                collapsed.add(g.name);
            } else {
                collapsed.delete(g.name);
            }
            g.el.classList.toggle('collapsed', on);
            g.head.el.setAttribute('aria-expanded', String(!on));
            localStorage.setItem(COLLAPSED_KEY, [...collapsed].join(','));
        });
    }

    document.documentElement.append(host);
    follow();
    if (size === 2) {
        fitGraphs();
    }

    const destroy = () => {
        app.off('frameupdate', onUpdate);
        app.off('framerender', onRender);
        app.off('frameend', onEnd);
        app.off('destroy', destroy);
        document.removeEventListener('agent:zoom', onZoom);
        if (prof && enabled) {
            prof.enabled = saved;
        }
        host.remove();
    };
    app.on('destroy', destroy);

    return {
        div: host,
        destroy,
        get enabled() {
            return enabled;
        },

        // hidden, it reads nothing, and the gpu profiler goes back to how the app had it
        set enabled(on) {
            if (on === enabled) {
                return;
            }
            enabled = on;
            host.style.display = on ? '' : 'none';
            if (prof && on) {
                saved = prof.enabled;
            }
            if (prof) {
                prof.enabled = on || saved;
            }
            if (!on) {
                return;
            }
            reset();
            follow();
        }
    };
};
