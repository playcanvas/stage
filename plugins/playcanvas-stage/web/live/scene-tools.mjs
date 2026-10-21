// the scene tools on a live app: a hud, selection, gizmos, comments with captures and pins, undo, and edits kept in
// the stage db by entity path. the engine is the app's own, read through the bridge
import {
    ADDRESS_CLAMP_TO_EDGE,
    BLEND_NORMAL,
    BoundingBox,
    Color,
    CULLFACE_NONE,
    Entity,
    Gizmo,
    GraphNode,
    Layer,
    LAYERID_DEPTH,
    LAYERID_SKYBOX,
    Mat4,
    Mesh,
    MeshInstance,
    OutlineRenderer,
    Picker,
    PlaneGeometry,
    PROJECTION_PERSPECTIVE,
    Quat,
    Ray,
    RotateGizmo,
    ScaleGizmo,
    SEMANTIC_POSITION,
    ShaderMaterial,
    StandardMaterial,
    Texture,
    TranslateGizmo,
    Vec3,
    version
} from 'playcanvas';

import {
    EDITS,
    MAX_SELECTION,
    anchorAttrs,
    createHistory,
    docIdOf,
    satisfies,
    editWrite,
    nodesAt,
    pathOf,
    round,
    sameTransform,
    validEdit
} from './core.mjs';
import { createStats } from './stats.mjs';

const PICK_SLOP = 4;
const CLICK_SLOP = 4;
const SNAP = { translate: 0.1, rotate: 15, scale: 0.1 };
const TOOL_KEYS = { 1: 'translate', 2: 'rotate', 3: 'scale' };

// Unity's keys, which a Mac keyboard has: ⌘P plays and pauses, ⌥⌘P steps (Ctrl off a Mac). our hotkeys stop the
// event before the app (or the browser's print) hears it
const MAC = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? '');
const KEYS = MAC ? { play: '⌘P', step: '⌥⌘P' } : { play: 'Ctrl+P', step: 'Ctrl+Alt+P' };

// whether the mini-stats were showing, kept across the app's reloads
const STATS_KEY = 'stage-ministats';

// step runs the app's update once with this delta
const STEP_DT = 1 / 60;

// the editor camera's first orbit point, this far ahead when the scene gives no better one
const FOCUS_DEFAULT = 5;

// F frames what it focuses this many times its radius away, no nearer than this, and no farther than this share of
// the far clip, so a dome round the scene (a sky) isn't framed from where everything is clipped
const FOCUS_FIT = 3;
const FOCUS_MIN = 0.5;
const FOCUS_FAR = 0.5;

// the editor camera eases its moves, turns and zooms as camera-controls does (its defaults)
const EASE = 0.98;

// the roll a drive starts from eases out at this damping, gentler than its moves
const LEVEL = 0.99;

const CAMERA_HELP =
    "Paused: drag to orbit, middle or Shift-drag to pan, wheel to zoom, right-drag and W A S D Q E to fly, F to focus, click a camera's icon to select it";

// the keys that fly the editor camera
const FLY_KEYS = /^(Key[WASDQE]|Arrow(Up|Down|Left|Right)|Page(Up|Down))$/;

// entities the app adds after attach get their edits on this beat
const APPEAR_MS = 500;

// layers that hold no pickable scene
const UNPICKED = ['Immediate', 'Skybox', 'Depth', 'UI'];
const SELECT_COLOR = new Color(1, 1, 1);

// the viewer's comment orange, gamma-encoded, since the outline pass draws it a gamma step darker
const COMMENT_COLOR = new Color(...[255, 102, 0].map((v) => (v / 255) ** (1 / 2.2)));

// the editor's selection box: corner brackets a third of the way along each edge, bright where seen, faint behind
const BOX_ARM = 0.3;
const BOX_MIN = new Vec3(0.01, 0.01, 0.01);
const BOX_BEHIND = new Color(1, 1, 1, 0.2);
const MAX_AREA_OBJECTS = 16;
const AREA_IMAGE_PX = 800;
const AREA_IMAGE_QUALITY = 0.85;
const OBJECT_IMAGE_PAD = 0.25;
const OBJECT_IMAGE_PAD_PX = 48;
const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
// a capture waits this long for the page's ui to draw (its fonts and images to load), then keeps the canvas alone
const PAGE_IMAGE_MS = 3000;
const SKEW_EPS = 1e-4;

// a camera's icon, as the editor's: this tall on screen, faint where it is behind something
const ICON_PX = 28;
const ICON_TEX = 64;
const ICON_ALPHA_TEST = 0.05;
const ICON_BEHIND = 0.25;

// the ground grid while paused, as supersplat's: 10 m, 1 m and 0.1 m lines fading out between these distances, m
// (the far one held inside the camera's far clip, where the plane would end), and whether it shows, across reloads
const GRID_FADE = [400, 1000];
const GRID_FADE_FAR = 0.9;
const GRID_FADE_START = 0.4;
const GRID_KEY = 'stage-grid';

// the app's html over its canvas (a hud, a splash) hides while paused, so the world shows as in the editor, unless the
// UI toggle (U) shows it to look at or comment on; stage's own panels stay
const UI_KEY = 'stage-ui';
const UI_HIDDEN =
    'body :not(:has(canvas[data-stage-tools]), canvas[data-stage-tools], stage-tools, stage-stats, .pc-inspector) { visibility: hidden !important; }';

// the inspector's toolbar beside the app, lined up with the viewer's: the tools strip's height, the comments panel's
// heading and padding, and no divider left over from the buttons hidden around it
const INSPECTOR_SIDE_CSS =
    '.pci-toolbar { box-sizing: border-box; height: 40px; padding: 0 8px 0 16px; flex-wrap: nowrap; } .pci-toolbar .pci-title { font-size: 15px; } .pci-toolbar .pci-sep { display: none; }';

// the gizmo is off while what it moves is this near the view, or behind it, as after View from camera; well inside
// FOCUS_MIN, so F on a camera doesn't park the view on the cutoff, where an orbit flickers the gizmo on and off
const GIZMO_MIN_DEPTH = FOCUS_MIN / 2;

const ICONS = {
    translate: 'M12 2v20M2 12h20m-7 7-3 3-3-3m10-10 3 3-3 3M9 5l3-3 3 3M5 15l-3-3 3-3',
    rotate: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8|M21 3v5h-5',
    scale: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
    world: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20|M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20',
    local: 'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z|m3.3 7 8.7 5 8.7-5M12 22V12',
    snap: 'm6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15|m5 8 4 4m3 3 4 4',
    grid: 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z|M3 9h18|M3 15h18|M9 3v18|M15 3v18',
    ui: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z|M2 8h20|M6 4v4|M10 4v4',
    undo: 'M9 14 4 9l5-5|M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
    play: 'M6 4v16l14-8z',
    pause: 'M7 4v16M17 4v16',
    step: 'M5 4v16l10-8z|M19 4v16',
    apply: 'M18 6 7 17l-5-5|m22 10-7.5 7.5L13 16',
    discard: 'M4 7h16|M10 11v6|M14 11v6|M6 7l1 13h10l1-13|M9 7V4h6v3',
    focus: 'M3 7V5a2 2 0 0 1 2-2h2|M17 3h2a2 2 0 0 1 2 2v2|M21 17v2a2 2 0 0 1-2 2h-2|M7 21H5a2 2 0 0 1-2-2v-2|M9 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
    view: 'M4 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z|M16 13l5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5',
    redo: 'm15 14 5-5-5-5|M20 9H9.5a5.5 5.5 0 0 0 0 11H13'
};

// the grid's lines, from the world position under each pixel so the plane can follow the camera; supersplat's
// infinite grid, after https://bgolus.medium.com/the-best-darn-grid-shader-yet-727f9278b9d8. each line is black
// over a light pixel of the scene and white over a dark one (the editor camera's scene colour, captured before the
// skybox and transparents), at GRID_INK strengths for 10 m, 1 m and 0.1 m, so a thin line reads on any ground; the
// axes keep their colours. the plane is drawn GRID_LIFT of the way toward the camera along each view ray, a depth
// step that grows with distance as the depth buffer's does, so a floor on y = 0 never covers it while what stands
// on the floor still does
const GRID_LIFT = '0.002';
const GRID_INK = ['0.9', '0.7', '0.4'];
const GRID_VS = /* glsl */ `
    attribute vec3 vertex_position;
    uniform mat4 matrix_model;
    uniform mat4 matrix_viewProjection;
    uniform vec3 view_position;
    varying vec3 worldPos;
    varying vec4 clipPos;

    void main(void) {
        vec4 p = matrix_model * vec4(vertex_position, 1.0);
        worldPos = p.xyz;
        clipPos = matrix_viewProjection * vec4(mix(p.xyz, view_position, ${GRID_LIFT}), 1.0);
        gl_Position = clipPos;
    }
`;
const GRID_FS = /* glsl */ `
    uniform vec3 view_position;
    uniform vec2 uFade;
    uniform sampler2D uSceneColorMap;
    varying vec3 worldPos;
    varying vec4 clipPos;

    float pristineGrid(vec2 uv, vec2 ddx, vec2 ddy, vec2 lineWidth) {
        vec2 uvDeriv = vec2(length(vec2(ddx.x, ddy.x)), length(vec2(ddx.y, ddy.y)));
        bvec2 invertLine = bvec2(lineWidth.x > 0.5, lineWidth.y > 0.5);
        vec2 targetWidth = vec2(
            invertLine.x ? 1.0 - lineWidth.x : lineWidth.x,
            invertLine.y ? 1.0 - lineWidth.y : lineWidth.y
        );
        vec2 drawWidth = clamp(targetWidth, uvDeriv, vec2(0.5));
        vec2 lineAA = uvDeriv * 1.5;
        vec2 gridUV = abs(fract(uv) * 2.0 - 1.0);
        gridUV.x = invertLine.x ? gridUV.x : 1.0 - gridUV.x;
        gridUV.y = invertLine.y ? gridUV.y : 1.0 - gridUV.y;
        vec2 grid2 = smoothstep(drawWidth + lineAA, drawWidth - lineAA, gridUV);
        grid2 *= clamp(targetWidth / drawWidth, 0.0, 1.0);
        grid2 = mix(grid2, targetWidth, clamp(uvDeriv * 2.0 - 1.0, 0.0, 1.0));
        grid2.x = invertLine.x ? 1.0 - grid2.x : grid2.x;
        grid2.y = invertLine.y ? 1.0 - grid2.y : grid2.y;
        return mix(grid2.x, 1.0, grid2.y);
    }

    void main(void) {
        vec2 pos = worldPos.xz;
        vec2 ddx = dFdx(pos);
        vec2 ddy = dFdy(pos);
        float epsilon = 1.0 / 255.0;
        float fade = 1.0 - smoothstep(uFade.x, uFade.y, length(worldPos - view_position));
        if (fade < epsilon) discard;

        // the axes: the 10 m line through 0 alone, x red and z blue
        vec2 p10 = pos * 0.1;
        float w10 = 2.0 / 1000.0;
        float ax = abs(p10.y) < 0.5 ? pristineGrid(vec2(0.5, p10.y), ddx * 0.1, ddy * 0.1, vec2(w10)) : 0.0;
        float az = abs(p10.x) < 0.5 ? pristineGrid(vec2(p10.x, 0.5), ddx * 0.1, ddy * 0.1, vec2(w10)) : 0.0;
        float axis = max(ax, az);

        // 10 m, then 1 m, then 0.1 m
        float a = pristineGrid(p10, ddx * 0.1, ddy * 0.1, vec2(w10)) * ${GRID_INK[0]};
        float w = 1.0 / 100.0;
        if (a <= epsilon) a = pristineGrid(pos, ddx, ddy, vec2(w)) * ${GRID_INK[1]};
        if (a <= epsilon) a = pristineGrid(pos * 10.0, ddx * 10.0, ddy * 10.0, vec2(w)) * ${GRID_INK[2]};
        a = max(a, axis);
        if (a * fade <= epsilon) discard;

        // black over a light pixel, white over a dark one
        vec3 under = texture2D(uSceneColorMap, (clipPos.xy / clipPos.w) * 0.5 + 0.5).rgb;
        vec3 ink = vec3(1.0 - smoothstep(0.4, 0.6, dot(under, vec3(0.2126, 0.7152, 0.0722))));
        vec3 color = axis >= a ? (az > ax ? vec3(0.2, 0.2, 1.0) : vec3(1.0, 0.2, 0.2)) : ink;
        gl_FragColor = vec4(color, a * fade);
    }
`;
const GRID_VS_WGSL = /* wgsl */ `
    attribute vertex_position: vec3f;
    uniform matrix_model: mat4x4f;
    uniform matrix_viewProjection: mat4x4f;
    uniform view_position: vec3f;
    varying worldPos: vec3f;
    varying clipPos: vec4f;

    @vertex
    fn vertexMain(input: VertexInput) -> VertexOutput {
        var output: VertexOutput;
        let p = uniform.matrix_model * vec4f(input.vertex_position, 1.0);
        output.worldPos = p.xyz;
        output.clipPos = uniform.matrix_viewProjection * vec4f(mix(p.xyz, uniform.view_position, ${GRID_LIFT}), 1.0);
        output.position = output.clipPos;
        return output;
    }
`;
const GRID_FS_WGSL = /* wgsl */ `
    uniform view_position: vec3f;
    uniform uFade: vec2f;
    var uSceneColorMap: texture_2d<f32>;
    var uSceneColorMapSampler: sampler;
    varying worldPos: vec3f;
    varying clipPos: vec4f;

    fn pristineGrid(uv: vec2f, ddx: vec2f, ddy: vec2f, lineWidth: vec2f) -> f32 {
        let uvDeriv = vec2f(length(vec2f(ddx.x, ddy.x)), length(vec2f(ddx.y, ddy.y)));
        let invertLine = vec2<bool>(lineWidth.x > 0.5, lineWidth.y > 0.5);
        let targetWidth = vec2f(
            select(lineWidth.x, 1.0 - lineWidth.x, invertLine.x),
            select(lineWidth.y, 1.0 - lineWidth.y, invertLine.y)
        );
        let drawWidth = clamp(targetWidth, uvDeriv, vec2f(0.5));
        let lineAA = uvDeriv * 1.5;
        var gridUV = abs(fract(uv) * 2.0 - 1.0);
        gridUV.x = select(1.0 - gridUV.x, gridUV.x, invertLine.x);
        gridUV.y = select(1.0 - gridUV.y, gridUV.y, invertLine.y);
        var grid2 = smoothstep(drawWidth + lineAA, drawWidth - lineAA, gridUV);
        grid2 *= clamp(targetWidth / drawWidth, vec2f(0.0), vec2f(1.0));
        grid2 = mix(grid2, targetWidth, clamp(uvDeriv * 2.0 - 1.0, vec2f(0.0), vec2f(1.0)));
        grid2.x = select(grid2.x, 1.0 - grid2.x, invertLine.x);
        grid2.y = select(grid2.y, 1.0 - grid2.y, invertLine.y);
        return mix(grid2.x, 1.0, grid2.y);
    }

    @fragment
    fn fragmentMain(input: FragmentInput) -> FragmentOutput {
        var output: FragmentOutput;
        let pos = input.worldPos.xz;
        let ddx = dpdx(pos);
        let ddy = dpdy(pos);
        let epsilon = 1.0 / 255.0;
        let fade = 1.0 - smoothstep(uniform.uFade.x, uniform.uFade.y, length(input.worldPos - uniform.view_position));

        // every line first, and the scene under it, as derivatives and sampling need uniform control flow
        let p10 = pos * 0.1;
        let w10 = 2.0 / 1000.0;
        let ax = select(0.0, pristineGrid(vec2f(0.5, p10.y), ddx * 0.1, ddy * 0.1, vec2f(w10)), abs(p10.y) < 0.5);
        let az = select(0.0, pristineGrid(vec2f(p10.x, 0.5), ddx * 0.1, ddy * 0.1, vec2f(w10)), abs(p10.x) < 0.5);
        let axis = max(ax, az);
        let w = 1.0 / 100.0;
        let a10 = pristineGrid(p10, ddx * 0.1, ddy * 0.1, vec2f(w10)) * ${GRID_INK[0]};
        let a1 = pristineGrid(pos, ddx, ddy, vec2f(w)) * ${GRID_INK[1]};
        let a01 = pristineGrid(pos * 10.0, ddx * 10.0, ddy * 10.0, vec2f(w)) * ${GRID_INK[2]};
        let a = max(select(select(a01, a1, a1 > epsilon), a10, a10 > epsilon), axis);
        var uv = (input.clipPos.xy / input.clipPos.w) * 0.5 + vec2f(0.5);
        uv.y = 1.0 - uv.y;
        let under = textureSampleLevel(uSceneColorMap, uSceneColorMapSampler, uv, 0.0).rgb;
        if (fade < epsilon || a * fade <= epsilon) {
            discard;
        }

        // black over a light pixel, white over a dark one
        let ink = vec3f(1.0 - smoothstep(0.4, 0.6, dot(under, vec3f(0.2126, 0.7152, 0.0722))));
        var color = ink;
        if (axis >= a) {
            color = select(vec3f(1.0, 0.2, 0.2), vec3f(0.2, 0.2, 1.0), az > ax);
        }
        output.color = vec4f(color, a * fade);
        return output;
    }
`;

// what each toolbar button does, with its keys, shown on hover
const TIPS = {
    step: `Step (${KEYS.step}): run the app for one frame`,
    focus: 'Focus (F): frame the selection, or the whole scene, and orbit it',
    view: 'View from camera: put the editor camera where the selected camera is, looking the way it looks',
    translate: 'Move (1): drag an arrow or plane of the gizmo',
    rotate: 'Rotate (2): drag a ring of the gizmo',
    scale: 'Scale (3): drag a handle of the gizmo',
    space: 'World axes (X): the gizmo follows the world axes',
    snap: 'Snap: move in 0.1 m, turn in 15° and scale in 0.1 steps (or hold Shift while dragging)',
    grid: 'Grid (G): the ground plane in 10 m, 1 m and 0.1 m lines, red along X and blue along Z',
    ui: "UI (U): the app's html over the scene, such as its hud, hidden while paused unless on",
    undo: 'Undo (Ctrl/⌘ Z)',
    redo: 'Redo (Ctrl/⌘ Shift Z)'
};

const STYLE = `
:host { all: initial; position: fixed; z-index: 2147483646; display: flex; flex-direction: column; align-items: flex-start; gap: 6px;
    font: 12px/1.4 -apple-system, BlinkMacSystemFont, sans-serif; --panel: #f6f7f4e6; --ink: #1d2320; --line: #c8cec8; --tool: #ff6600; --danger: #d34141; }
@media (prefers-color-scheme: dark) { :host(:not([data-theme="light"])) { --panel: #1d2220e6; --ink: #e3e8e4; --line: #333b37; } }
:host([data-theme="dark"]) { --panel: #1d2220e6; --ink: #e3e8e4; --line: #333b37; }
.tools { display: flex; gap: 2px; padding: 3px; background: var(--panel); border: 1px solid var(--line); border-radius: 7px; }
button { position: relative; display: grid; place-items: center; color: var(--ink); background: transparent; border: 0; border-radius: 5px; padding: 6px; cursor: pointer; }
button:hover { background: color-mix(in srgb, var(--tool) 18%, transparent); }
button[aria-pressed="true"] { background: var(--tool); color: #fff; }
button:disabled { cursor: default; }
button:disabled > * { opacity: 0.4; }
button[data-tip]:is(:hover, :focus-visible)::after { content: attr(data-tip); position: absolute; top: calc(100% + 8px); left: 0;
    width: max-content; max-width: 300px; padding: 5px 8px; border-radius: 5px; background: var(--ink); color: var(--panel);
    font: 12px/1.4 -apple-system, BlinkMacSystemFont, sans-serif; text-align: left; white-space: pre-line; pointer-events: none;
    z-index: 1; }
button[data-tip][data-off]:disabled:is(:hover, :focus-visible)::after { content: attr(data-tip) "\\A" attr(data-off); }
button[hidden], .sep:has(+ button[hidden]) { display: none; }
button:focus-visible { outline: 2px solid var(--tool); outline-offset: 1px; }
svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.sep { width: 1px; margin: 3px 4px; background: var(--line); }
p { margin: 0; padding: 2px 6px; border-radius: 4px; background: var(--panel); color: var(--ink); font: 11px/1.4 ui-monospace, monospace; max-width: 360px; }
p:empty { display: none; }
.confirm { display: flex; flex-direction: column; gap: 4px; width: 280px; padding: 12px 12px 10px; border: 1px solid var(--line);
    border-radius: 7px; background: var(--panel); color: var(--ink); }
.confirm[hidden] { display: none; }
.tools:has(~ .confirm:not([hidden])) button::after { content: none; }
.confirm strong { font-weight: 600; }
.confirm span { opacity: 0.7; font-size: 12px; }
.confirm div { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; }
.confirm button { padding: 4px 10px; font-weight: 600; }
.confirm .danger { background: var(--danger); color: #fff; }
.confirm .danger:hover { background: var(--danger); filter: brightness(1.1); }
[data-action="space"][aria-pressed="true"] .world, [data-action="space"]:not([aria-pressed="true"]) .local { display: none; }
.count { position: absolute; top: -3px; right: -3px; min-width: 14px; padding: 0 3px; border-radius: 7px; background: var(--tool);
    color: #fff; font: 600 10px/14px -apple-system, BlinkMacSystemFont, sans-serif; }
.count:empty { display: none; }
:host([data-playing]) .tools > :not([data-action="play"]) { opacity: 0.45; }
.edge { position: fixed; box-shadow: inset 0 0 0 2px var(--tool); pointer-events: none; opacity: 0; transition: opacity 0.2s; }
:host([data-playing]) .edge { opacity: 1; }
`;

const attempt = (f) => {
    try {
        return [null, f()];
    } catch (e) {
        return [e];
    }
};
const settle = (p) =>
    p.then(
        (v) => [null, v],
        (e) => [e]
    );
const typing = (t) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

// a url's bytes as a data: url, or null where they can't be read; fonts and images repeat across captures, so kept
const inlined = new Map();
const dataUrl = (u) => {
    if (!inlined.has(u)) {
        inlined.set(
            u,
            settle(fetch(u).then((r) => (r.ok ? r.blob() : null))).then(
                ([, b]) =>
                    b &&
                    new Promise((ok) => {
                        const f = new FileReader();
                        f.onload = () => ok(f.result);
                        f.onerror = () => ok(null);
                        f.readAsDataURL(b);
                    })
            )
        );
    }
    return inlined.get(u);
};

// a stylesheet as text, its urls (fonts, images) inlined against where it was loaded from; another origin's is
// fetched, and left out if that fails too
const cssOf = async (sheet) => {
    const base = sheet.href ?? document.baseURI;
    const [e, rules] = attempt(() => [...sheet.cssRules]);
    const text = e
        ? ((await settle(fetch(sheet.href).then((r) => (r.ok ? r.text() : ''))))[1] ?? '')
        : (
              await Promise.all(
                  rules.map((r) => (r instanceof CSSImportRule && r.styleSheet ? cssOf(r.styleSheet) : r.cssText))
              )
          ).join('\n');
    const urls = [...new Set([...text.matchAll(CSS_URL)].map((m) => m[2]).filter((u) => !/^(data:|#)/.test(u)))];
    const found = new Map(await Promise.all(urls.map(async (u) => [u, await dataUrl(new URL(u, base).href)])));
    const css = text.replace(CSS_URL, (m, _, u) => (found.get(u) ? `url("${found.get(u)}")` : m));
    const media = sheet.media?.mediaText;
    return media ? `@media ${media} {${css}}` : css;
};

/**
 * The page as it shows, as an svg image the size of the viewport: its html over the app's canvas (a game's hud)
 * then shows in a capture. The canvas shows `snap`, stage's own ui (`ours`) and comment overlay are left out.
 * Null where the browser won't draw it.
 */
const pageImage = async (canvas, snap, ours) => {
    const doc = document.documentElement;
    const copy = doc.cloneNode(true);
    const to = [copy, ...copy.querySelectorAll('*')];
    const imgs = [];
    for (const [i, o] of [doc, ...doc.querySelectorAll('*')].entries()) {
        const t = to[i];
        if (
            (o.parentElement === doc && o !== document.head && o !== document.body) ||
            /^(SCRIPT|STYLE|LINK)$/.test(o.tagName)
        ) {
            t.remove();
        } else if (ours.has(o)) {
            t.style.setProperty('visibility', 'hidden', 'important');
        } else if (o instanceof HTMLCanvasElement) {
            const u = o === canvas ? snap : attempt(() => o.toDataURL())[1];
            if (u) {
                t.style.setProperty('background', `url("${u}") 0 0 / 100% 100% no-repeat`, 'important');
            }
        } else if (o instanceof HTMLImageElement && o.currentSrc) {
            imgs.push(
                dataUrl(o.currentSrc).then((u) => {
                    t.removeAttribute('srcset');
                    if (u) {
                        t.src = u;
                    }
                })
            );
        }
    }
    const sheets = [...document.styleSheets, ...document.adoptedStyleSheets].filter((s) => !s.disabled);
    const [css] = await Promise.all([Promise.all(sheets.map(cssOf)), Promise.all(imgs)]);
    const style = document.createElement('style');

    // in the svg the page's root is the svg, not its html
    style.textContent = css.join('\n').replace(/:root\b/g, 'html');
    copy.prepend(style);
    const [w, h] = [doc.clientWidth, doc.clientHeight];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject width="100%" height="100%">${new XMLSerializer().serializeToString(copy)}</foreignObject></svg>`;
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    return (await settle(img.decode()))[0] ? null : img;
};

const svg = (name, cls) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    if (cls) {
        s.setAttribute('class', cls);
    }
    for (const d of ICONS[name].split('|')) {
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', d);
        s.append(p);
    }
    return s;
};

// engine 2.23's gizmo hit test writes each hit point into the vector holding its ray direction, so handles tested
// after a hit are missed or mistaken (an x arrow seen head-on picks y); the same test with vectors of its own
const [hitStart, hitEnd, hitDir, hitPoint] = [new Vec3(), new Vec3(), new Vec3(), new Vec3()];
const [hitTM, hitInv] = [new Mat4(), new Mat4()];
const hitRay = new Ray();
function hitTest(x, y) {
    const cam = this._camera;
    cam.screenToWorld(x, y, 0, hitStart);
    cam.screenToWorld(x, y, cam.farClip - cam.nearClip, hitEnd);
    hitDir.sub2(hitEnd, hitStart).normalize();
    const hits = [];
    for (const shape of this.intersectShapes) {
        if (shape.disabled || !shape.entity.enabled) {
            continue;
        }
        const parent = shape.entity.getWorldTransform();
        for (const { tris, transform, priority } of shape.triData) {
            hitTM.copy(parent).mul(transform);
            hitInv.copy(hitTM).invert();
            hitInv.transformPoint(hitStart, hitRay.origin);
            hitInv.transformVector(hitDir, hitRay.direction);
            hitRay.direction.normalize();
            for (const t of tris) {
                if (t.intersectsRay(hitRay, hitPoint)) {
                    hits.push({
                        dist: hitTM.transformPoint(hitPoint).sub(hitStart).length(),
                        meshInstances: shape.meshInstances,
                        priority
                    });
                }
            }
        }
    }
    hits.sort((a, b) => (a.priority !== 0 && b.priority !== 0 ? b.priority - a.priority : a.dist - b.dist));
    return hits[0]?.meshInstances ?? [];
}

const read = (e) => {
    const [p, r, s] = [e.getLocalPosition(), e.getLocalEulerAngles(), e.getLocalScale()];
    return { pos: round([p.x, p.y, p.z]), rot: round([r.x, r.y, r.z]), scale: round([s.x, s.y, s.z]) };
};
const place = (e, t) => {
    e.setLocalPosition(...t.pos);
    e.setLocalEulerAngles(...t.rot);
    e.setLocalScale(...t.scale);
};

/** the hud over the app's canvas: tools, the selection and a status line, in an open shadow root */
const createHud = (canvas) => {
    const host = document.createElement('stage-tools');
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    const button = (attrs, ...kids) => {
        const b = document.createElement('button');
        b.type = 'button';
        for (const [k, v] of Object.entries(attrs)) {
            b.setAttribute(k, v);
        }
        b.append(...kids);
        return b;
    };
    const sep = () => Object.assign(document.createElement('span'), { className: 'sep' });
    const tools = Object.assign(document.createElement('div'), { className: 'tools' });
    tools.setAttribute('role', 'toolbar');
    tools.setAttribute('aria-label', 'Stage tools');
    const btn = {
        play: button(
            { 'data-action': 'play', 'aria-pressed': 'true', 'aria-label': `Pause (${KEYS.play})` },
            svg('play')
        ),
        step: button(
            { 'data-action': 'step', 'aria-label': `Step one frame (${KEYS.step})`, disabled: '' },
            svg('step')
        ),
        focus: button({ 'data-action': 'focus', 'aria-label': 'Focus (F)', disabled: '' }, svg('focus')),
        view: button({ 'data-action': 'view', 'aria-label': 'View from camera', disabled: '' }, svg('view')),
        translate: button(
            { 'data-tool': 'translate', 'aria-pressed': 'true', 'aria-label': 'Move (1)' },
            svg('translate')
        ),
        rotate: button({ 'data-tool': 'rotate', 'aria-pressed': 'false', 'aria-label': 'Rotate (2)' }, svg('rotate')),
        scale: button({ 'data-tool': 'scale', 'aria-pressed': 'false', 'aria-label': 'Scale (3)' }, svg('scale')),
        space: button(
            { 'data-action': 'space', 'aria-pressed': 'false', 'aria-label': 'World axes (X)' },
            svg('world', 'world'),
            svg('local', 'local')
        ),
        snap: button(
            { 'data-action': 'snap', 'aria-pressed': 'false', 'aria-label': 'Snap to 0.1 m and 15° (or hold Shift)' },
            svg('snap')
        ),
        grid: button({ 'data-action': 'grid', 'aria-pressed': 'false', 'aria-label': 'Grid (G)' }, svg('grid')),
        ui: button({ 'data-action': 'ui', 'aria-pressed': 'false', 'aria-label': 'UI (U)' }, svg('ui')),
        undo: button({ 'data-action': 'undo', 'aria-label': 'Undo (Ctrl/⌘ Z)' }, svg('undo')),
        redo: button({ 'data-action': 'redo', 'aria-label': 'Redo (Shift Ctrl/⌘ Z)' }, svg('redo')),
        discard: button({ 'data-action': 'discard', 'aria-label': 'Discard the edits', disabled: '' }, svg('discard')),
        send: button(
            { 'data-action': 'send', 'aria-label': 'Apply: send the edits to the agent', disabled: '' },
            svg('apply'),
            Object.assign(document.createElement('span'), { className: 'count' })
        )
    };
    for (const [k, b] of Object.entries(btn)) {
        b.dataset.tip = TIPS[k] ?? b.getAttribute('aria-label');
    }
    tools.append(
        btn.play,
        btn.step,
        sep(),
        btn.focus,
        btn.view,
        sep(),
        btn.translate,
        btn.rotate,
        btn.scale,
        sep(),
        btn.space,
        btn.snap,
        btn.grid,
        btn.ui,
        sep(),
        btn.undo,
        btn.redo,
        sep(),
        btn.discard,
        btn.send
    );
    const selection = document.createElement('p');
    selection.className = 'selection';
    const status = document.createElement('p');
    status.className = 'status';
    status.setAttribute('role', 'status');
    // Discard asks first: the edits are gone once the page reloads
    const confirm = Object.assign(document.createElement('div'), { className: 'confirm', hidden: true });
    confirm.setAttribute('role', 'alertdialog');
    const title = document.createElement('strong');
    const ask = document.createElement('span');
    const choices = document.createElement('div');
    choices.append(
        button({ 'data-confirm': 'cancel' }, 'Cancel'),
        button({ 'data-confirm': 'discard', class: 'danger' }, 'Discard')
    );
    confirm.append(title, ask, choices);
    root.append(style, tools, confirm, selection, status);

    // in the viewer, the viewer draws the toolbar above the app from the state we report; on its own, it is over the canvas
    if (window.parent !== window) {
        return { host, tools, btn, selection, status, root, confirm, title, ask };
    }
    document.documentElement.append(host);

    // playing, an edge around the canvas, as the viewer draws around the app
    const edge = Object.assign(document.createElement('div'), { className: 'edge' });
    root.append(edge);

    // the hud follows the canvas wherever the app's layout puts it, and the viewer's theme
    const follow = () => {
        const r = canvas.getBoundingClientRect();
        host.style.left = `${Math.max(0, r.left) + 12}px`;
        host.style.top = `${Math.max(0, r.top) + 12}px`;
        Object.assign(edge.style, {
            left: `${r.left}px`,
            top: `${r.top}px`,
            width: `${r.width}px`,
            height: `${r.height}px`
        });
        const t = document.documentElement.dataset.theme;
        if (t) {
            host.dataset.theme = t;
        } else {
            delete host.dataset.theme;
        }
    };
    const loop = () => (follow(), requestAnimationFrame(loop));
    loop();
    return { host, tools, btn, selection, status, root, confirm, title, ask };
};

export const mountTools = async (entry) => {
    const { app } = entry;
    const stage = globalThis[Symbol.for('playcanvas.stage')];
    const canvas = app.graphicsDevice.canvas;
    const db = (await window.agent?.use('db')) ?? null;
    const col = db?.collection(EDITS);
    const label = document.title || 'App';

    // our own entities (the gizmos' roots) never count as the app's
    const mine = new Set();
    const isMine = (e) => {
        for (let n = e; n; n = n.parent) {
            if (mine.has(n)) {
                return true;
            }
        }
        return false;
    };
    const pathOfE = (e) => pathOf(e, app.root);
    const appNodesAt = (path) => nodesAt(app.root, path).filter((n) => n instanceof Entity && !isMine(n));

    // the camera the tools look through: the app's last enabled camera drawing to the screen
    const findCam = () =>
        app.systems.camera.cameras
            .filter((c) => c.enabled && c.entity.enabled && !c.renderTarget && !isMine(c.entity))
            .at(-1)?.entity ?? null;
    let cam = findCam();
    while (!cam) {
        await new Promise((r) => app.once('frameend', r));
        cam = findCam();
    }
    const first = col ? await settle(col.get()) : null;

    // everything below registers its listeners inside ours(), so they are the tools', not the app's
    return stage.ours(() => setup());
    function setup() {
        // `app.on('update')` made in our scope during this setup goes to our list, which runs only while paused;
        // made later (the inspector's) it goes to both, so the inspector reads the app playing and paused
        const updates = new Set();
        const appOn = app.on;
        let both = false;
        app.on = function (name, cb, scope) {
            if (name !== 'update' || !stage.inOurs()) {
                return appOn.call(this, name, cb, scope);
            }
            const h = { off: () => updates.delete(h), run: (dt) => cb.call(scope, dt) };
            updates.add(h);
            if (!both) {
                return h;
            }
            const real = appOn.call(this, name, cb, scope);
            return { off: () => (h.off(), real.off()) };
        };

        const hud = createHud(canvas);
        let sayTimer = 0;
        const say = (text, ms = 0) => {
            clearTimeout(sayTimer);
            hud.status.textContent = text;
            if (ms) {
                sayTimer = setTimeout(() => (hud.status.textContent = ''), ms);
            }
        };

        // picking: the mesh instance under a point, and the entity it belongs to
        const picker = new Picker(app, 1, 1, true);
        const ourLayers = new Set();
        const pickLayers = () =>
            cam.camera.layers
                .map((id) => app.scene.layers.getLayerById(id))
                .filter((l) => l && !ourLayers.has(l) && !UNPICKED.includes(l.name));
        const prepare = () => {
            picker.resize(Math.max(1, canvas.clientWidth | 0), Math.max(1, canvas.clientHeight | 0));
            picker.prepare(cam.camera, app.scene, pickLayers());
        };
        // a camera's icon stands for its camera
        const iconOf = new WeakMap();
        const owner = (node) => {
            if (iconOf.has(node)) {
                return iconOf.get(node);
            }
            let n = node;
            while (n && !(n instanceof Entity)) {
                n = n.parent;
            }
            return n && n !== app.root && !isMine(n) ? n : null;
        };
        const gpuPick = async (x, y) => {
            prepare();
            let [mi] = await picker.getSelectionAsync(x, y);
            if (!mi) {
                [mi] = await picker.getSelectionAsync(
                    Math.max(0, x - PICK_SLOP),
                    Math.max(0, y - PICK_SLOP),
                    PICK_SLOP * 2 + 1,
                    PICK_SLOP * 2 + 1
                );
            }
            const e = mi?.node ? owner(mi.node) : null;
            const p = e && (await picker.getWorldPointAsync(x, y));
            return { e, p: p ? [p.x, p.y, p.z] : null };
        };

        // selection outlines in their own layer, drawn as the editor draws them
        const outlineLayer = new Layer({ name: 'StageOutline' });
        app.scene.layers.push(outlineLayer);
        ourLayers.add(outlineLayer);
        const outline = new OutlineRenderer(app, outlineLayer);
        const immediate = app.scene.layers.getLayerByName('Immediate');

        let sel = [];
        let hov = null;
        let marked = [];
        let commenting = false;
        let drafting = false;
        let capturing = 0;
        let paused = false;
        let inspector = null;
        const INSPECTOR = '/_frame/live/inspector';

        // the selection is shown while paused; playing, the view is the app's (and the inspector's, when open)
        const shown = () => (commenting || !paused ? [] : sel);

        const boundsOf = (list, out) => {
            let empty = true;
            for (const e of list) {
                for (const r of e.findComponents('render')) {
                    for (const mi of r.meshInstances) {
                        if (empty) {
                            out.copy(mi.aabb);
                        } else {
                            out.add(mi.aabb);
                        }
                        empty = false;
                    }
                }
            }
            return empty ? null : out;
        };

        const paint = () => {
            outline.removeAllEntities();
            if (capturing) {
                return;
            }
            const on = shown();
            for (const e of on) {
                outline.addEntity(e, SELECT_COLOR);
            }
            for (const e of marked) {
                if (!on.includes(e)) {
                    outline.addEntity(e, COMMENT_COLOR);
                }
            }
            if (commenting && !drafting && hov && !marked.includes(hov)) {
                outline.addEntity(hov, COMMENT_COLOR);
            }
        };

        // camera icons, as the editor's: one per app camera, facing the view at a steady size on screen, while paused.
        // their layer is the editor camera's alone, under the gizmos', and picked, so a click on one selects its camera
        const iconLayer = new Layer({ name: 'StageIcons' });
        app.scene.layers.push(iconLayer);
        const iconRoot = new Entity('StageIcons');
        mine.add(iconRoot);
        app.root.addChild(iconRoot);
        const glyph = Object.assign(document.createElement('canvas'), { width: ICON_TEX, height: ICON_TEX });
        const g2 = glyph.getContext('2d');
        g2.scale(ICON_TEX / 24, ICON_TEX / 24);
        Object.assign(g2, { lineCap: 'round', lineJoin: 'round' });
        for (const [w, c] of [
            [5, 'rgba(0, 0, 0, 0.6)'],
            [2, '#fff']
        ]) {
            Object.assign(g2, { lineWidth: w, strokeStyle: c });
            g2.stroke(new Path2D(ICONS.view.replaceAll('|', ' ')));
        }
        const glyphTex = new Texture(app.graphicsDevice, {
            name: 'StageCameraIcon',
            width: ICON_TEX,
            height: ICON_TEX,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE
        });
        glyphTex.setSource(glyph);
        const [iconFront, iconBack] = [1, ICON_BEHIND].map((opacity) => {
            const m = Object.assign(new StandardMaterial(), {
                useLighting: false,
                useFog: false,
                useSkybox: false,
                diffuse: new Color(0, 0, 0),
                emissive: new Color(1, 1, 1),
                emissiveMap: glyphTex,
                opacityMap: glyphTex,
                opacityMapChannel: 'a',
                opacity,
                alphaTest: ICON_ALPHA_TEST,
                blendType: BLEND_NORMAL,
                depthWrite: false,
                depthTest: opacity === 1,
                cull: CULLFACE_NONE
            });
            m.update();
            return m;
        });
        const quad = (name, material) => {
            const e = new Entity(name);
            e.addComponent('render', { type: 'plane', material, layers: [iconLayer.id], castShadows: false });
            return e;
        };
        const icons = new Map();
        const syncIcons = () => {
            const now = new Set(app.root.findComponents('camera').filter((c) => !isMine(c.entity)));
            for (const [c, icon] of icons) {
                if (now.has(c)) {
                    continue;
                }
                icon.destroy();
                icons.delete(c);
            }
            for (const c of now) {
                if (icons.has(c)) {
                    continue;
                }
                const icon = quad('StageCameraIcon', iconFront);
                const back = quad('StageCameraIconBehind', iconBack);
                back.render.meshInstances[0].pick = false;
                icon.addChild(back);
                iconRoot.addChild(icon);
                iconOf.set(icon, c.entity);
                icons.set(c, icon);
            }
        };
        const toIcon = new Vec3();
        const placeIcons = () => {
            const on = paused && !commenting && !capturing;
            if (iconRoot.enabled !== on) {
                iconRoot.enabled = on;
            }
            if (!on) {
                return;
            }
            const c = cam.camera;
            const px = (2 * ICON_PX) / Math.max(1, canvas.clientHeight);
            const tan = Math.tan((c.fov * Math.PI) / 360);
            for (const [cc, icon] of icons) {
                const p = cc.entity.getPosition();
                const depth = toIcon.sub2(p, cam.getPosition()).dot(cam.forward);
                icon.enabled = cc.entity.enabled && depth > c.nearClip;
                if (!icon.enabled) {
                    continue;
                }
                const s = px * (c.projection === PROJECTION_PERSPECTIVE ? depth * tan : c.orthoHeight);
                icon.setPosition(p);
                icon.setRotation(cam.getRotation());
                icon.rotateLocal(90, 0, 0);
                icon.setLocalScale(s, s, s);
            }
        };

        // the ground grid, in a layer of the editor camera's alone after the world's transparent part, never picked.
        // a plane twice the fade wide follows the camera, so it shows no edge
        const gridLayer = new Layer({ name: 'StageGrid' });
        const world = app.scene.layers.getLayerByName('World');
        if (world) {
            app.scene.layers.insert(gridLayer, app.scene.layers.getTransparentIndex(world) + 1);
        } else {
            app.scene.layers.push(gridLayer);
        }
        ourLayers.add(gridLayer);

        const gridMat = new ShaderMaterial({
            uniqueName: 'stage-grid',
            vertexGLSL: GRID_VS,
            fragmentGLSL: GRID_FS,
            vertexWGSL: GRID_VS_WGSL,
            fragmentWGSL: GRID_FS_WGSL,
            attributes: { vertex_position: SEMANTIC_POSITION }
        });
        Object.assign(gridMat, { blendType: BLEND_NORMAL, depthWrite: false, cull: CULLFACE_NONE });
        gridMat.update();
        const gridMI = new MeshInstance(Mesh.fromGeometry(app.graphicsDevice, new PlaneGeometry()), gridMat);
        gridMI.pick = false;
        const grid = new Entity('StageGrid');
        mine.add(grid);
        grid.addComponent('render', { meshInstances: [gridMI], layers: [gridLayer.id], castShadows: false });
        grid.enabled = false;
        app.root.addChild(grid);
        let gridOn = localStorage.getItem(GRID_KEY) !== '0';
        let gridFar = 0;
        const placeGrid = () => {
            const on = gridOn && paused && !capturing;
            if (grid.enabled !== on) {
                grid.enabled = on;

                // the lines pick their ink from the scene's colour, which the editor camera captures only while it shows
                editor.camera.requestSceneColorMap(on);
                skyInGrab(on);
            }
            if (!on) {
                return;
            }
            const far = cam.camera.farClip;
            if (far !== gridFar) {
                gridFar = far;
                const end = Math.min(GRID_FADE[1], far * GRID_FADE_FAR);
                gridMat.setParameter('uFade', [Math.min(GRID_FADE[0], end * GRID_FADE_START), end]);
                grid.setLocalScale(end * 2, 1, end * 2);
            }
            const p = cam.getPosition();
            grid.setPosition(p.x, 0, p.z);
        };
        // the capture happens where the depth layer is, before the skybox by default: while the grid shows (paused, so
        // only the editor camera and the app's render-target cameras draw), the depth layer moves after the skybox, so
        // the lines pick their ink over a sky too, and goes back after
        let depthAt = -1;
        const skyInGrab = (on) => {
            const L = app.scene.layers;
            const [depth, sky] = [L.getLayerById(LAYERID_DEPTH), L.getLayerById(LAYERID_SKYBOX)];
            if (!depth || !sky) {
                return;
            }
            if (on && depthAt < 0 && L.getOpaqueIndex(depth) < L.getOpaqueIndex(sky)) {
                depthAt = L.getOpaqueIndex(depth);
                L.removeOpaque(depth);
                L.insertOpaque(depth, L.getOpaqueIndex(sky) + 1);
            } else if (!on && depthAt >= 0) {
                L.removeOpaque(depth);
                L.insertOpaque(depth, depthAt);
                depthAt = -1;
            }
        };
        const setGrid = (on) => {
            gridOn = on;
            localStorage.setItem(GRID_KEY, on ? '1' : '0');
            hud.btn.grid.setAttribute('aria-pressed', String(on));
        };
        setGrid(gridOn);

        const uiSheet = attempt(() => new CSSStyleSheet())[1];
        attempt(() => uiSheet?.replaceSync(UI_HIDDEN));
        let uiOn = localStorage.getItem(UI_KEY) === '1';
        const showUi = () => {
            const rest = document.adoptedStyleSheets.filter((x) => x !== uiSheet);
            document.adoptedStyleSheets = uiSheet && paused && !uiOn ? [...rest, uiSheet] : rest;
        };
        const setUi = (on) => {
            uiOn = on;
            localStorage.setItem(UI_KEY, on ? '1' : '0');
            hud.btn.ui.setAttribute('aria-pressed', String(on));
            showUi();
        };
        setUi(uiOn);

        // a selected camera shows what it sees, as the editor's camera gizmo does: its near and far planes, joined
        const frustum = Array.from({ length: 24 }, () => new Vec3());
        const frustumTM = new Mat4();
        const drawFrustum = (e) => {
            const c = e.camera;
            const [n, f] = [c.nearClip, c.farClip];
            const d = app.graphicsDevice;
            const aspect = (d.width * c.rect.z) / (d.height * c.rect.w);
            const tan = Math.tan((c.fov * Math.PI) / 360);
            const [ny, fy] =
                c.projection === PROJECTION_PERSPECTIVE ? [n * tan, f * tan] : [c.orthoHeight, c.orthoHeight];
            const corner = (k, h, z, out) =>
                out.set((k === 0 || k === 1 ? 1 : -1) * h * aspect, (k === 1 || k === 2 ? 1 : -1) * h, -z);
            let i = 0;
            for (let k = 0; k < 4; k++) {
                corner(k, ny, n, frustum[i++]);
                corner((k + 1) % 4, ny, n, frustum[i++]);
                corner(k, fy, f, frustum[i++]);
                corner((k + 1) % 4, fy, f, frustum[i++]);
                corner(k, ny, n, frustum[i++]);
                corner(k, fy, f, frustum[i++]);
            }
            frustumTM.setTRS(e.getPosition(), e.getRotation(), Vec3.ONE);
            for (const v of frustum) {
                frustumTM.transformPoint(v, v);
            }
            app.drawLines(frustum, BOX_BEHIND, false, immediate);
            app.drawLines(frustum, SELECT_COLOR, true, immediate);
        };

        // gizmos, created before our canvas listeners so a handle press is known when ours runs
        const glayer = Gizmo.createLayer(app, 'StageGizmo');
        ourLayers.add(glayer);
        const gizmos = {
            translate: new TranslateGizmo(cam.camera, glayer),
            rotate: new RotateGizmo(cam.camera, glayer),
            scale: new ScaleGizmo(cam.camera, glayer)
        };
        for (const g of Object.values(gizmos)) {
            mine.add(g.root);
            if (typeof g._getSelection === 'function') {
                g._getSelection = hitTest;
            }
        }

        // the outline and box follow the camera once the frame's pose is final, playing or paused
        const selBox = new BoundingBox();
        const boxLines = Array.from({ length: 48 }, () => new Vec3());
        app.on('prerender', () => {
            outline.frameUpdate(cam, immediate, false);
            placeIcons();
            placeGrid();
            eyeCheck();
            if (!capturing) {
                for (const e of shown()) {
                    if (e.camera && !isMine(e)) {
                        drawFrustum(e);
                    }
                }
            }
            const b = !capturing && boundsOf(shown(), selBox);
            if (!b) {
                return;
            }
            b.halfExtents.add(BOX_MIN);
            const { center: c, halfExtents: h } = b;
            let i = 0;
            for (const x of [-1, 1]) {
                for (const y of [-1, 1]) {
                    for (const z of [-1, 1]) {
                        for (const k of ['x', 'y', 'z']) {
                            const [from, to] = [boxLines[i++], boxLines[i++]];
                            from.set(c.x + h.x * x, c.y + h.y * y, c.z + h.z * z);
                            to.copy(from);
                            to[k] -= h[k] * BOX_ARM * { x, y, z }[k];
                        }
                    }
                }
            }
            app.drawLines(boxLines, BOX_BEHIND, false, immediate);
            app.drawLines(boxLines, SELECT_COLOR, true, immediate);
        });

        // edits: one doc per entity path, applied once when the entity appears; the app's own writes win after that
        const editable = !!col;
        const docs = new Map();
        const base = new WeakMap();
        const applied = new WeakSet();
        const dragging = new Set();
        const pending = new Map();
        const put = (e, t) => {
            if (!base.has(e)) {
                base.set(e, read(e));
            }
            place(e, t);
            tellControls(e);
        };

        // the engine's camera-controls script keeps its own pose and writes it every frame, so a camera it drives is
        // told where it was put: it looks the way it was turned, at the distance it orbited at
        const tellControls = (e) => {
            const s = e.script?.get?.('cameraControls');
            if (!s || !('focusPoint' in s)) {
                return;
            }
            const d = s.focusPoint.distance(e.getPosition()) || FOCUS_DEFAULT;
            s.focusPoint = e.forward.clone().mulScalar(d).add(e.getPosition());
        };
        const apply = (paths, again = false) => {
            for (const path of paths) {
                const t = validEdit(docs.get(path));
                const at = appNodesAt(path);
                if (!t || at.length !== 1) {
                    continue;
                }
                const [e] = at;
                if ((applied.has(e) && !again) || dragging.has(e) || pending.get(e)) {
                    continue;
                }
                put(e, t);
                applied.add(e);
            }
        };
        const sync = (r) => {
            const next = new Map();
            const changed = [];
            for (const d of r.docs) {
                const data = d.data();
                if (typeof data?.path !== 'string') {
                    continue;
                }
                next.set(data.path, { ...data, version: d.version });
                if (docs.get(data.path)?.version !== d.version) {
                    changed.push(data.path);
                }
            }
            const gone = [...docs.keys()].filter((p) => !next.has(p));
            docs.clear();
            for (const [k, v] of next) {
                docs.set(k, v);
            }
            if (gone.length) {
                repin(gone);
            }
            apply(changed, true);
            showSend();
        };
        const showSend = () => {
            const n = docs.size;
            hud.btn.send.disabled = !editable || !n;
            hud.btn.send.setAttribute(
                'aria-label',
                n ? `Apply: send ${n} edit${n > 1 ? 's' : ''} to the agent` : 'Apply: no edits to send'
            );
            hud.btn.send.dataset.tip = n
                ? `Apply: send the ${n} edit${n > 1 ? 's' : ''} to the agent, to write into the app's source`
                : 'Apply: send the edits to the agent, to write into the source';
            hud.btn.send.dataset.off = editable ? 'No edits yet: move something while paused' : '';
            hud.btn.send.querySelector('.count').textContent = editable && n ? String(n) : '';
            hud.btn.discard.disabled = !editable || !n;
            hud.btn.discard.dataset.tip = n
                ? `Discard: put the ${n} edited entit${n > 1 ? 'ies' : 'y'} back where the app placed ${n > 1 ? 'them' : 'it'}, and send nothing (Ctrl/⌘ Z brings ${n > 1 ? 'them' : 'it'} back)`
                : 'Discard: put edited entities back where the app placed them, and send nothing';
            hud.btn.discard.dataset.off = hud.btn.send.dataset.off;
        };

        // Discard: each edited entity back where the app placed it, and its edit deleted, as one undoable change; an
        // edit whose entity isn't here (or was never moved in this view) is just deleted
        const discard = async () => {
            const n = docs.size;
            const op = [];
            const loose = [];
            for (const path of docs.keys()) {
                const at = appNodesAt(path);
                if (at.length === 1 && base.has(at[0])) {
                    op.push({ id: at[0], before: read(at[0]), after: base.get(at[0]) });
                } else {
                    loose.push(path);
                }
            }
            if (op.length) {
                history.push(op);
                await commit(op.map((o) => ({ id: o.id, to: o.after })));
            }
            if (loose.length) {
                const [e] = await settle(
                    db.batch(loose.map((p) => ({ op: 'delete', path: `${EDITS}/${docIdOf(p)}` })))
                );
                if (e) {
                    return say(`Not discarded — ${e.message}`);
                }
            }
            say(`Discarded ${n} edit${n > 1 ? 's' : ''}`, 2000);
        };

        // Apply: the daemon lists the stage's pending edits in one message to the agent
        const send = async () => {
            const [e, r] = await settle(fetch('/_frame/api/apply', { method: 'POST' }));
            if (e || !r.ok) {
                return say(`Not sent — ${e?.message ?? (await r.text())}`);
            }
            const { count } = await r.json();
            say(`Sent ${count} edit${count > 1 ? 's' : ''} to the agent`, 3000);
        };
        // a collection read keeps the runtime's version pin of a deleted doc; a doc read resets it
        const repin = (paths) => Promise.all(paths.map((p) => settle(col.doc(docIdOf(p)).get())));
        if (col) {
            const [ge, r] = first;
            if (ge) {
                console.error(`Stage: edits could not be read: ${ge.message}`);
            } else {
                sync(r);
            }
            col.onSnapshot(sync, (err) => console.error(`Stage: edits stopped syncing: ${err.message}`));
            setInterval(() => !paused && docs.size && apply([...docs.keys()]), APPEAR_MS);
        }

        // an entity whose path others share can't be keyed, so it can't be moved
        const shared = (e) => appNodesAt(pathOfE(e)).length > 1;

        const commit = async (changes) => {
            for (const c of changes) {
                put(c.id, c.to);
            }
            const writesOf = () =>
                changes
                    .map((c) => editWrite(pathOfE(c.id), c.to, base.get(c.id), docs.has(pathOfE(c.id))))
                    .filter(Boolean);
            let writes = writesOf();
            if (!writes.length) {
                return;
            }
            for (const c of changes) {
                pending.set(c.id, (pending.get(c.id) ?? 0) + 1);
            }
            say('Saving…');
            let [e] = await settle(db.batch(writes));
            if (e) {
                // refresh the version pins of every written doc, then retry once
                const [re, r] = await settle(col.get());
                if (!re) {
                    sync(r);
                }
                await repin(changes.map((c) => pathOfE(c.id)));
                writes = writesOf();
                [e] = re ? [re] : writes.length ? await settle(db.batch(writes)) : [null];
            }
            for (const c of changes) {
                pending.set(c.id, pending.get(c.id) - 1);
            }
            if (e) {
                console.error(`Stage: edits not saved: ${e.message}`);
                return say(`Not saved — ${e.message}`);
            }
            say('Saved', 1500);
        };

        const history = createHistory();
        let tool = 'translate';
        let space = 'world';
        let snapLatch = false;
        let snapHeld = false;
        let onHandle = false;
        let before = null;

        const skewed = (e) => {
            for (let n = e.parent; n && n !== app.root; n = n.parent) {
                const s = n.getLocalScale();
                if (Math.abs(s.x - s.y) > SKEW_EPS || Math.abs(s.y - s.z) > SKEW_EPS) {
                    return true;
                }
            }
            return false;
        };
        const moveOnly = () => sel.some(skewed);
        let atEye = false;
        const selMid = new Vec3();
        const eyeCheck = () => {
            let near = false;
            if (paused && sel.length) {
                selMid.set(0, 0, 0);
                for (const e of sel) {
                    selMid.add(e.getPosition());
                }
                selMid.mulScalar(1 / sel.length).sub(cam.getPosition());
                near = selMid.dot(cam.forward) < GIZMO_MIN_DEPTH;
            }
            if (near === atEye) {
                return;
            }
            atEye = near;
            attach();
        };
        const movable = () => paused && editable && !atEye && shown().length > 0 && !sel.some(shared);
        const attach = () => {
            for (const [name, g] of Object.entries(gizmos)) {
                const on = movable() && name === tool;
                if (on) {
                    g.attach(sel);
                } else {
                    g.detach();
                }
                g.enabled = on;
            }
        };
        // View from camera needs a camera selected, and the editor camera, so a pause
        const selCam = () => sel.find((e) => e.camera && !isMine(e));
        const showView = () => {
            hud.btn.view.disabled = !paused || !selCam();
            hud.btn.view.dataset.off = paused ? 'Select a camera first' : `Pause first (${KEYS.play})`;
        };

        // one selection with the inspector panel: each side follows the other
        let syncing = false;
        const select = (list) => {
            sel = list.slice(0, MAX_SELECTION);
            if (inspector && !syncing) {
                syncing = true;
                inspector._hierarchy.select(sel.at(-1) ?? null);
                syncing = false;
            }
            hud.selection.textContent = sel.map(pathOfE).join(', ');
            const only = moveOnly();
            for (const n of ['rotate', 'scale']) {
                hud.btn[n].disabled = only;
            }
            if (only && tool !== 'translate') {
                setTool('translate');
            }
            const dup = sel.find(shared);
            if (dup) {
                say(
                    `Can't move ${pathOfE(dup)}: ${appNodesAt(pathOfE(dup)).length} entities share that path, so an edit can't be kept for this one. Give it a unique name in the app's source to move it.`
                );
            } else if (hud.status.textContent.startsWith("Can't move")) {
                say('');
            }
            showView();
            attach();
            paint();
        };

        for (const [name, g] of Object.entries(gizmos)) {
            g.coordSpace = space;
            g.snapIncrement = SNAP[name];
            g.enabled = false;
            g.on('pointer:down', (_x, _y, mi) => {
                if (name !== tool) {
                    return;
                }
                onHandle = !!mi;
            });
            g.on('pointer:up', () => {
                if (name !== tool) {
                    return;
                }
                onHandle = false;
            });
            g.on('transform:start', () => {
                before = sel.map((e) => ({ id: e, before: read(e) }));
                for (const b of before) {
                    dragging.add(b.id);
                }
            });
            g.on('transform:end', () => {
                const op = (before ?? [])
                    .map((b) => ({ ...b, after: read(b.id) }))
                    .filter((o) => !sameTransform(o.before, o.after));
                for (const b of before ?? []) {
                    dragging.delete(b.id);
                    if (!base.has(b.id)) {
                        base.set(b.id, b.before);
                    }
                }
                before = null;
                if (!op.length) {
                    return;
                }
                history.push(op);
                commit(op.map((o) => ({ id: o.id, to: o.after })));
            });
        }

        const setSnap = () => {
            for (const g of Object.values(gizmos)) {
                g.snap = snapLatch || snapHeld;
            }
            hud.btn.snap.setAttribute('aria-pressed', String(snapLatch));
        };
        const setTool = (t) => {
            if (t !== 'translate' && moveOnly()) {
                return;
            }
            tool = t;
            for (const n of ['translate', 'rotate', 'scale']) {
                hud.btn[n].setAttribute('aria-pressed', String(n === t));
            }
            attach();
        };
        const setSpace = (s) => {
            space = s;
            for (const g of Object.values(gizmos)) {
                g.coordSpace = s;
            }
            hud.btn.space.setAttribute('aria-label', `${s === 'local' ? 'Local' : 'World'} axes (X)`);
            hud.btn.space.dataset.tip = `${s === 'local' ? "Local axes (X): the gizmo follows the entity's own axes" : 'World axes (X): the gizmo follows the world axes'}`;
            hud.btn.space.setAttribute('aria-pressed', String(s === 'local'));
        };
        const undoRedo = (redo) => {
            const ch = redo ? history.redo() : history.undo();
            if (ch) {
                commit(ch);
            }
        };
        // a press on the hud keeps focus where it was, so keys go back to the game after Play
        hud.tools.addEventListener('pointerdown', (e) => e.target.closest('button') && e.preventDefault());
        // a press on the toolbar here asks before Discard; the viewer's asks in its own strip and then sends it
        const act = (b, asked = false) => {
            if (b === hud.btn.discard && !asked) {
                const n = docs.size;
                hud.title.textContent = `Discard ${n} edit${n === 1 ? '' : 's'}?`;
                hud.ask.textContent = `${n === 1 ? 'The entity goes' : 'The entities go'} back to where the app placed ${n === 1 ? 'it' : 'them'}, and nothing is sent to the agent.`;
                hud.confirm.hidden = false;
                return;
            }
            if (b.dataset.tool) {
                setTool(b.dataset.tool);
            } else if (b === hud.btn.focus) {
                focus();
            } else if (b === hud.btn.view) {
                viewFrom();
            } else if (b === hud.btn.space) {
                setSpace(space === 'world' ? 'local' : 'world');
            } else if (b === hud.btn.snap) {
                snapLatch = !snapLatch;
                setSnap();
            } else if (b === hud.btn.grid) {
                setGrid(!gridOn);
            } else if (b === hud.btn.ui) {
                setUi(!uiOn);
            } else if (b === hud.btn.undo || b === hud.btn.redo) {
                undoRedo(b === hud.btn.redo);
            } else if (b === hud.btn.play) {
                toggle();
            } else if (b === hud.btn.step) {
                step();
            } else if (b === hud.btn.send) {
                send();
            } else if (b === hud.btn.discard) {
                discard();
            }
        };
        hud.tools.addEventListener('click', (e) => {
            const b = e.target.closest('button');
            if (b) {
                act(b);
            }
        });
        hud.confirm.addEventListener('pointerdown', (e) => e.target.closest('button') && e.preventDefault());
        hud.confirm.addEventListener('click', (e) => {
            const c = e.target.closest('[data-confirm]')?.dataset.confirm;
            if (!c) {
                return;
            }
            hud.confirm.hidden = true;
            if (c === 'discard') {
                discard();
            }
        });

        // the viewer's toolbar: it clicks by id, and draws what the toolbar here shows whenever that changes
        document.addEventListener('agent:tool', (e) => {
            const b = hud.btn[e.detail?.id];
            if (b && !b.disabled && !b.hidden) {
                act(b, true);
            }
        });
        let reporting = false;
        const report = () => {
            reporting = false;
            const buttons = {};
            for (const [k, b] of Object.entries(hud.btn)) {
                buttons[k] = {
                    label: b.getAttribute('aria-label') ?? '',
                    pressed: b.getAttribute('aria-pressed'),
                    disabled: b.disabled,
                    hidden: b.hidden,
                    tip: b.dataset.tip ?? '',
                    off: b.dataset.off ?? '',
                    count: b.querySelector('.count')?.textContent ?? ''
                };
            }
            const detail = { buttons, selection: hud.selection.textContent, status: hud.status.textContent };
            document.dispatchEvent(new CustomEvent('agent:tools', { detail }));
        };
        new MutationObserver(() => reporting || ((reporting = true), queueMicrotask(report))).observe(hud.root, {
            subtree: true,
            attributes: true,
            childList: true,
            characterData: true
        });

        // keys reach the tools only while something is selected, so the app keeps its own otherwise
        addEventListener('keydown', (e) => {
            if (typing(e.target)) {
                return;
            }
            if (e.key === 'Escape' && !hud.confirm.hidden) {
                return void (hud.confirm.hidden = true);
            }
            const k = e.key.toLowerCase();
            if ((e.metaKey || e.ctrlKey) && k === 'z') {
                if (!editable) {
                    return;
                }
                e.preventDefault();
                return undoRedo(e.shiftKey);
            }
            if (e.key === 'Shift') {
                snapHeld = true;
                return setSnap();
            }
            if (!sel.length || e.metaKey || e.ctrlKey || e.altKey) {
                return;
            }
            if (k === 'escape') {
                select([]);
            } else if (editable && TOOL_KEYS[k]) {
                setTool(TOOL_KEYS[k]);
            } else if (editable && k === 'x') {
                setSpace(space === 'world' ? 'local' : 'world');
            }
        });
        addEventListener('keyup', (e) => {
            if (e.key !== 'Shift') {
                return;
            }
            snapHeld = false;
            setSnap();
        });
        addEventListener('blur', () => {
            snapHeld = false;
            setSnap();
        });

        // comment mode: what a click would comment on is outlined, down to the part under the cursor
        const anchorOf = (e, p) => {
            const a = anchorAttrs(e ? pathOfE(e) : null, p);
            canvas.dataset.entity = a.entity;
            canvas.dataset.point = a.point;
        };
        const corner = new Vec3();
        const screen = new Vec3();
        const screenBox = (e, c) => {
            const b = boundsOf([e], new BoundingBox());
            if (!b) {
                return null;
            }
            const [lo, hi] = [b.getMin(), b.getMax()];
            let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
            for (let i = 0; i < 8; i++) {
                corner.set(i & 1 ? hi.x : lo.x, i & 2 ? hi.y : lo.y, i & 4 ? hi.z : lo.z);
                cam.camera.worldToScreen(corner, screen);
                [x0, y0, x1, y1] = [
                    Math.min(x0, screen.x),
                    Math.min(y0, screen.y),
                    Math.max(x1, screen.x),
                    Math.max(y1, screen.y)
                ];
            }
            [x0, y0, x1, y1] = [Math.max(x0, 0), Math.max(y0, 0), Math.min(x1, c.width), Math.min(y1, c.height)];
            return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
        };

        // the page's own visible ui over an area of the canvas (a game's html hud), not stage's
        const uiOver = (r) =>
            [...document.body.querySelectorAll('*')].some((n) => {
                if (n.contains(canvas) || stage.gate.ui.has(n)) {
                    return false;
                }
                const b = n.getBoundingClientRect();
                return (
                    b.width * b.height > 0 &&
                    b.right > r.left &&
                    b.left < r.left + r.width &&
                    b.bottom > r.top &&
                    b.top < r.top + r.height &&
                    n.checkVisibility({ opacityProperty: true, visibilityProperty: true })
                );
            });

        // the canvas as the viewer saw it, without outlines, and the page's ui over it: a webgl canvas is readable only
        // as a frame ends
        const capture = (r) => {
            capturing++;
            paint();
            return new Promise((ok) =>
                app.once('frameend', () =>
                    app.once('frameend', async () => {
                        const c = canvas.getBoundingClientRect();
                        const [sx, sy] = [canvas.width / c.width, canvas.height / c.height];
                        const [x, y, w, h] = [
                            (r.left - c.left) * sx,
                            (r.top - c.top) * sy,
                            r.width * sx,
                            r.height * sy
                        ];
                        const k = Math.min(1, AREA_IMAGE_PX / Math.max(w, h));
                        const out = document.createElement('canvas');
                        [out.width, out.height] = [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
                        const g = out.getContext('2d');
                        g.drawImage(canvas, x, y, w, h, 0, 0, out.width, out.height);
                        const snap = uiOver(r) && document.createElement('canvas');
                        if (snap) {
                            [snap.width, snap.height] = [Math.ceil(canvas.width * k), Math.ceil(canvas.height * k)];
                            snap.getContext('2d').drawImage(canvas, 0, 0, snap.width, snap.height);
                        }
                        capturing--;
                        paint();
                        const [, page] = snap
                            ? await settle(
                                  Promise.race([
                                      pageImage(canvas, snap.toDataURL('image/webp'), stage.gate.ui),
                                      new Promise((ok) => setTimeout(ok, PAGE_IMAGE_MS, null))
                                  ])
                              )
                            : [];

                        // a browser that taints a canvas drawn an svg of html keeps the canvas alone
                        const ui = page && document.createElement('canvas');
                        if (ui) {
                            [ui.width, ui.height] = [out.width, out.height];
                            const u = ui.getContext('2d');
                            u.drawImage(page, r.left, r.top, r.width, r.height, 0, 0, out.width, out.height);
                            if (!attempt(() => u.getImageData(0, 0, 1, 1))[0]) {
                                g.drawImage(ui, 0, 0);
                            }
                        }
                        const [, webp] = attempt(() => out.toDataURL('image/webp', AREA_IMAGE_QUALITY));
                        ok(
                            webp?.startsWith('data:image/webp')
                                ? webp
                                : attempt(() => out.toDataURL('image/jpeg', AREA_IMAGE_QUALITY))[1]
                        );
                    })
                )
            );
        };

        window.agent?.pick?.(canvas, async (x, y, how) => {
            const c = canvas.getBoundingClientRect();
            const { e, p } = await gpuPick(x - c.left, y - c.top);
            if (!e) {
                return false;
            }
            const a = anchorAttrs(pathOfE(e), p);
            const b = how?.clicks && screenBox(e, c);
            const pad = b && Math.max(Math.max(b.x1 - b.x0, b.y1 - b.y0) * OBJECT_IMAGE_PAD, OBJECT_IMAGE_PAD_PX);
            const image = b
                ? await capture({
                      left: c.left + Math.max(0, b.x0 - pad),
                      top: c.top + Math.max(0, b.y0 - pad),
                      width: Math.min(c.width, b.x1 + pad) - Math.max(0, b.x0 - pad),
                      height: Math.min(c.height, b.y1 + pad) - Math.max(0, b.y0 - pad)
                  })
                : undefined;
            return {
                label: `${label} › ${a.entity}`,
                snippet: `<canvas data-entity="${a.entity}" data-point="${a.point}">`,
                image
            };
        });

        const entityOfSnippet = (s) => {
            const path = /data-entity="([^"]+)"/.exec(s ?? '')?.[1];
            const at = path ? appNodesAt(path) : [];
            return at.length === 1 ? at[0] : null;
        };
        canvas.addEventListener('agent:focus', (ev) => {
            const d = ev.detail;
            marked = d ? [d.snippet, ...d.inside].map(entityOfSnippet).filter(Boolean) : [];
            if (marked.length) {
                ev.preventDefault();
            }
            paint();
        });

        // a pin sits on the world point it was placed at, or on the centre of the objects a drawn area lists
        const pinWorld = new Vec3();
        const pinScreen = new Vec3();
        const toPin = new Vec3();
        const pinBox = new BoundingBox();
        canvas.addEventListener('agent:pin', (ev) => {
            const d = ev.detail;
            const b = boundsOf(d.inside.map(entityOfSnippet).filter(Boolean), pinBox);
            const p = /data-point="([^"]+)"/.exec(d.snippet)?.[1]?.split(',').map(Number);
            if (b) {
                pinWorld.copy(b.center);
            } else if (p?.length === 3 && p.every(Number.isFinite)) {
                pinWorld.set(...p);
            } else {
                return;
            }
            toPin.sub2(pinWorld, cam.getPosition());
            const c = canvas.getBoundingClientRect();
            cam.camera.worldToScreen(pinWorld, pinScreen);
            d.hidden =
                toPin.dot(cam.forward) <= 0 ||
                pinScreen.x < 0 ||
                pinScreen.y < 0 ||
                pinScreen.x > c.width ||
                pinScreen.y > c.height;
            [d.x, d.y] = [c.left + pinScreen.x, c.top + pinScreen.y];
        });

        window.agent?.pickRect?.(canvas, async (r) => {
            const c = canvas.getBoundingClientRect();
            const [rx0, ry0, rx1, ry1] = [
                r.left - c.left,
                r.top - c.top,
                r.left - c.left + r.width,
                r.top - c.top + r.height
            ];
            prepare();
            const [px, py] = [Math.max(0, rx0 | 0), Math.max(0, ry0 | 0)];
            const seen = new Set();
            for (const mi of await picker.getSelectionAsync(
                px,
                py,
                Math.max(1, (Math.min(rx1, c.width) - px) | 0),
                Math.max(1, (Math.min(ry1, c.height) - py) | 0)
            )) {
                const e = owner(mi.node);
                if (e) {
                    seen.add(e);
                }
            }

            // the outermost of them at least half inside the area
            const found = [];
            for (const e of seen) {
                let under = false;
                for (let n = e.parent; n && !under; n = n.parent) {
                    under = seen.has(n);
                }
                const b = screenBox(e, c);
                if (under || !b) {
                    continue;
                }
                const w = Math.max(0, Math.min(b.x1, rx1) - Math.max(b.x0, rx0));
                const h = Math.max(0, Math.min(b.y1, ry1) - Math.max(b.y0, ry0));
                if (w * h >= ((b.x1 - b.x0) * (b.y1 - b.y0)) / 2) {
                    found.push({ e, cover: w * h });
                }
            }
            const inside = found
                .sort((a, b) => b.cover - a.cover)
                .slice(0, MAX_AREA_OBJECTS)
                .map((f) => `<canvas data-entity="${pathOfE(f.e)}">`);
            const cp = cam.getPosition();
            const fw = cam.forward;
            const pose = [
                ...round([cp.x, cp.y, cp.z], 2),
                ...round([cp.x + fw.x, cp.y + fw.y, cp.z + fw.z], 2),
                cam.camera.fov
            ].join(',');
            const [p, image] = await Promise.all([
                inside.length ? null : gpuPick((rx0 + rx1) / 2, (ry0 + ry1) / 2).then((h) => h.p),
                capture(r)
            ]);
            const point = p ? ` data-point="${anchorAttrs(null, p).point}"` : '';
            return {
                label: `${label} › area`,
                snippet: `<canvas data-camera="${pose}"${point}>`,
                inside,
                image
            };
        });

        // pointer: a click selects what it landed on, Shift adds or removes; in comment mode the viewer takes clicks
        let hoverAt = null;
        let hoverRaf = 0;
        let over = false;
        let down = null;

        // a crosshair over the whole canvas in comment mode: a click comments on what it lands on, a drag on an area
        const showCursor = () =>
            commenting && !drafting
                ? canvas.style.setProperty('cursor', 'crosshair', 'important')
                : canvas.style.removeProperty('cursor');
        document.addEventListener('agent:draft', (e) => {
            drafting = !!e.detail?.open;
            if (drafting) {
                hov = null;
            }
            showCursor();
            paint();
        });
        document.addEventListener('agent:comment-mode', (e) => {
            commenting = !!e.detail?.on;
            showCursor();

            // a comment started while playing pauses at the game camera's view
            if (commenting && !paused) {
                pause(true);
            }
            attach();
            paint();
        });
        const hover = async () => {
            hoverRaf = 0;
            const { e, p } = await gpuPick(...hoverAt);
            if (!over) {
                return;
            }
            if (e !== hov) {
                hov = e;
                paint();
            }
            anchorOf(e, p);
        };
        canvas.addEventListener('pointermove', (e) => {
            if (e.pointerType !== 'mouse' || down || !commenting) {
                return;
            }
            over = true;
            hoverAt = [e.offsetX, e.offsetY];
            hoverRaf ||= requestAnimationFrame(hover);
        });
        canvas.addEventListener('pointerleave', () => {
            over = false;
            hov = null;
            paint();
            anchorOf(null, null);
        });
        let lastPose = NaN;
        app.on('prerender', () => {
            const [c, r] = [cam.getPosition(), cam.getRotation()];
            const pose = c.x + c.y * 7 + c.z * 13 + r.x * 17 + r.y * 19 + r.z * 23 + r.w * 29;
            if (pose === lastPose) {
                return;
            }
            lastPose = pose;
            document.dispatchEvent(new Event('agent:layout'));
        });
        canvas.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) {
                return;
            }
            down = { x: e.offsetX, y: e.offsetY, handle: onHandle };
        });
        canvas.addEventListener('pointerup', async (e) => {
            const d = down;
            down = null;
            if (!d || d.handle || Math.hypot(e.offsetX - d.x, e.offsetY - d.y) > CLICK_SLOP) {
                return;
            }
            const { e: hit } = await gpuPick(e.offsetX, e.offsetY);
            const toggled = hit && (sel.includes(hit) ? sel.filter((x) => x !== hit) : [...sel, hit]);
            select(hit ? (e.shiftKey ? toggled : [hit]) : e.shiftKey ? sel : []);
        });

        // pause: the app's update is replaced on the instance, so the engine still renders but runs none of the app's
        // systems or update handlers; ours run from it instead. an editor camera renders while paused
        let game = cam;
        let editor = null;

        // a game camera whose look comes from the engine's camera-frame script (tone mapping, bloom, ssao and the
        // rest) lends the editor camera one of the same kind, or the paused view is the untouched hdr image
        let gameFrame = null;
        let editorFrame = null;
        const FRAME_PARTS = [
            'rendering',
            'ssao',
            'bloom',
            'grading',
            'colorLUT',
            'vignette',
            'taa',
            'fringing',
            'colorEnhance',
            'dof'
        ];
        const frameOf = (e) => e?.script?.scripts.find((x) => x.engineCameraFrame && x.rendering) ?? null;
        const followFrame = () => {
            gameFrame = frameOf(game);
            if (!gameFrame) {
                return;
            }
            if (editorFrame?.constructor !== gameFrame.constructor) {
                if (!editor.script) {
                    editor.addComponent('script');
                }
                editorFrame = editor.script.create(gameFrame.constructor);
            }
            copyFrame();
        };
        const copyFrame = () => {
            for (const part of FRAME_PARTS) {
                if (gameFrame[part] && editorFrame[part]) {
                    Object.assign(editorFrame[part], gameFrame[part]);
                }
            }
        };
        let gameCams = [];
        let audio = null;
        const scene = new BoundingBox();

        // one editor camera, as in the PlayCanvas Editor: drag to orbit, middle or Shift-drag to pan, the wheel to zoom,
        // right-drag to look and W/A/S/D/Q/E to fly, F to focus. it is driven by the inspector's orbit and fly, swapped
        // as the input asks for one or the other, and extended for an editor: the pose it writes stays (the inspector
        // puts the camera back after each frame), it is written first in the paused tick so the outline, gizmos and pins
        // see the pose the frame is drawn from, it eases as camera-controls did, and the pointer is shared with selection
        // and gizmos. this reads the inspector's internals, so an app's own copy of another version may need this updated
        let drives = null;
        let car = null;
        let kind = null;
        let span = 0;
        const pivot = new GraphNode('StagePivot');
        const pivotBox = new BoundingBox();

        // a drive holds no roll: one that starts from a rolled view turns its pose about the view's axis by the roll
        // left, which eases out as it moves rather than going at once
        const lean = new Quat();
        const leaned = new Quat();
        const steered = (Base) =>
            class extends Base {
                constructor(...a) {
                    super(...a);
                    this.app.off('prerender', this._onPrerender, this);
                    this.app.off('postrender', this._onPostrender, this);
                    this._capture.destroy();
                    window.removeEventListener('keydown', this._keyDownListener, true);
                    window.removeEventListener('keyup', this._keyUpListener, true);
                    window.removeEventListener('blur', this._blurListener);
                    Object.assign(this._controller, { moveDamping: EASE, rotateDamping: EASE, zoomDamping: EASE });

                    // the pose it writes stays
                    this._onPostrender = () => {};
                }

                _onPrerender() {
                    super._onPrerender();
                    editor.setRotation(leaned.mul2(editor.getRotation(), lean));
                }
            };
        const uncontrolled = (err) => console.warn(`Stage: the editor camera has no controls: ${err?.message ?? err}`);
        import(`${INSPECTOR}/src/viewport-tools.js`)
            .then((m) => {
                drives = { orbit: steered(m.CameraOrbit), fly: steered(m.CameraFly) };
                restart();
            })
            .catch(uncontrolled);

        // a new drive starts where the camera is; orbit turns about a point ahead, as far as the last orbit was. as
        // a drive holds no roll, one starts only once the view is driven: until then it keeps the pose it was given
        const drive = (k) =>
            stage.ours(() => {
                if (kind === 'orbit' && car) {
                    span = pivot.getPosition().distance(editor.getPosition());
                }
                car?.destroy();
                car = null;
                kind = null;
                if (!k || !drives || !paused || !editor) {
                    return;
                }
                if (k === 'orbit') {
                    pivot.setPosition(
                        span
                            ? editor.getPosition().clone().add(editor.forward.clone().mulScalar(span))
                            : focusOf(editor)
                    );
                }
                const [err, d] = attempt(() =>
                    k === 'fly'
                        ? new drives.fly(app, editor.camera, () => {})
                        : new drives.orbit(app, editor.camera, pivot, () => {})
                );
                if (err) {
                    return uncontrolled(err);
                }
                [car, kind] = [d, k];
                const { x, y, z } = d._pose.angles;
                lean.setFromEulerAngles(x, y, z).invert().mul(editor.getRotation());
            });
        const use = (k) => kind === k || drive(k);
        const restart = () => {
            span = 0;
            drive();
        };

        // F: the selection, or the whole scene, framed from where the camera looks, and orbited
        const focus = () => {
            const list = sel.length
                ? sel
                : app.root
                      .findComponents('render')
                      .map((r) => r.entity)
                      .filter((x) => !isMine(x));
            let b = boundsOf(list, pivotBox);

            // what has no mesh, as a camera, is framed where it stands
            if (!b && sel.length) {
                b = pivotBox;
                b.center.copy(sel[0].getPosition());
                b.halfExtents.set(0, 0, 0);
                for (const e of sel) {
                    b.add(new BoundingBox(e.getPosition(), new Vec3()));
                }
            }
            if (!b) {
                return;
            }
            use('orbit');
            if (kind !== 'orbit') {
                return;
            }
            const at = b.center.clone();
            const fit = Math.min(
                Math.max(b.halfExtents.length() * FOCUS_FIT, FOCUS_MIN),
                editor.camera.farClip * FOCUS_FAR
            );
            const from = at.clone().sub(editor.forward.clone().mulScalar(fit));
            pivot.setPosition(at);
            car._center.set(0, 0, 0);
            car._focus.copy(at);
            car._controller.attach(new car._pose.constructor().look(from, at), true);
        };

        // the drive hears the canvas's pointer and keys, but not a press on a gizmo handle: a right-drag flies, any
        // other drag orbits, and so does the wheel
        let steering = false;
        let press = null;
        const steer = (e) => {
            if (!drives) {
                return;
            }
            if (e.type === 'pointerdown') {
                if (onHandle) {
                    return;
                }
                steering = true;
                canvas.setPointerCapture?.(e.pointerId);

                // with no drive yet, a press waits to be a drag, so a click that selects leaves the view as it is
                if (!car) {
                    return void (press = e);
                }
                use(e.button === 2 ? 'fly' : 'orbit');
            } else if (e.type === 'pointermove' && press) {
                if (Math.hypot(e.clientX - press.clientX, e.clientY - press.clientY) <= CLICK_SLOP) {
                    return;
                }
                use(press.button === 2 ? 'fly' : 'orbit');
                car?._pointerListener(press);
                press = null;
            } else if (e.type === 'pointerup') {
                press = null;
                if (!steering) {
                    return;
                }
                steering = false;
            } else if (e.type === 'wheel') {
                e.preventDefault();
                use('orbit');
            }
            car?._pointerListener(e);
        };
        for (const t of ['pointerdown', 'pointermove', 'pointerup']) {
            canvas.addEventListener(t, steer);
        }
        canvas.addEventListener('wheel', steer, { passive: false });
        canvas.addEventListener('contextmenu', (e) => paused && e.preventDefault());

        // in the capture phase, as the inspector's panel keeps the keys pressed on it to itself
        addEventListener(
            'keydown',
            (e) => {
                if (!paused || typing(e.composedPath()[0]) || e.metaKey || e.ctrlKey || e.altKey) {
                    return;
                }
                if (FLY_KEYS.test(e.code)) {
                    use('fly');
                } else if (e.code === 'KeyF' && !e.repeat && !e.shiftKey) {
                    return focus();
                } else if (e.code === 'KeyG' && !e.repeat && !e.shiftKey) {
                    return setGrid(!gridOn);
                } else if (e.code === 'KeyU' && !e.repeat && !e.shiftKey) {
                    return setUi(!uiOn);
                }
                car?._onKey(e, true);
            },
            true
        );
        addEventListener('keyup', (e) => car?._onKey(e, false), true);
        addEventListener('blur', () => ((press = null), car?._onBlur()));

        const tick = (dt) => {
            app.graphicsDevice.update();
            if (car) {
                lean.slerp(lean, Quat.IDENTITY, 1 - LEVEL ** (dt * 1000));
            }
            car?._onPrerender();
            if (gameFrame && editorFrame) {
                copyFrame();
                editorFrame.postUpdate(dt);
            }
            for (const h of [...updates]) {
                h.run(dt);
            }
        };
        const focusOf = (e) => {
            const b = boundsOf(
                app.root
                    .findComponents('render')
                    .map((r) => r.entity)
                    .filter((x) => !isMine(x)),
                scene
            );
            const d = b ? Math.min(Math.max(b.center.distance(e.getPosition()), 1), 50) : FOCUS_DEFAULT;
            return e.getPosition().clone().add(e.forward.clone().mulScalar(d));
        };
        const poseFrom = (src) => {
            editor.setPosition(src.getPosition());
            editor.setRotation(src.getRotation());
        };

        // the editor camera sees what the game camera does, from its own view
        const makeEditor = () => {
            const g = game.camera;
            editor = new Entity('StageCamera');
            mine.add(editor);
            editor.addComponent('camera', {
                fov: g.fov,
                nearClip: g.nearClip,
                farClip: g.farClip,
                projection: g.projection,
                orthoHeight: g.orthoHeight,
                clearColor: g.clearColor.clone(),
                clearColorBuffer: g.clearColorBuffer,
                clearDepthBuffer: g.clearDepthBuffer,
                toneMapping: g.toneMapping,
                gammaCorrection: g.gammaCorrection,
                priority: g.priority,
                rect: g.rect.clone(),
                layers: [
                    ...g.layers.filter((id) => id !== glayer.id),
                    iconLayer.id,
                    gridLayer.id,

                    // the grid's scene colour is captured where the depth layer is drawn
                    ...(g.layers.includes(LAYERID_DEPTH) ? [] : [LAYERID_DEPTH])
                ]
            });
            app.root.addChild(editor);
            poseFrom(game);
        };
        const useCam = (c) => {
            cam = c;
            for (const g of Object.values(gizmos)) {
                g.camera = cam.camera;
            }
            attach();
        };
        const showPlay = () => {
            // lit while playing, as Unity's play button is
            hud.btn.play.setAttribute('aria-pressed', String(!paused));
            hud.btn.play.setAttribute('aria-label', `${paused ? 'Play' : 'Pause'} (${KEYS.play})`);
            hud.btn.play.dataset.tip = paused
                ? `Play (${KEYS.play}): run the app again; it hears your input`
                : `Playing: ${KEYS.play} or a click pauses it, to look around, select and edit\n${CAMERA_HELP}`;
            if (paused) {
                delete hud.host.dataset.playing;
            } else {
                hud.host.dataset.playing = '';
            }
            showUi();
            for (const n of ['step', 'focus', 'grid', 'ui']) {
                hud.btn[n].disabled = !paused;
                hud.btn[n].dataset.off = `Pause first (${KEYS.play})`;
            }
            showView();
            for (const n of ['translate', 'rotate', 'scale', 'space', 'snap', 'undo', 'redo']) {
                const only = ['rotate', 'scale'].includes(n) && moveOnly();
                hud.btn[n].disabled = !paused || !editable || only;
                hud.btn[n].dataset.off = !paused
                    ? `Pause first (${KEYS.play})`
                    : !editable
                      ? "This stage has no database, so edits can't be kept"
                      : 'Only Move here: a parent of the selection is scaled unevenly';
            }
        };
        const pause = (atGame = false) => {
            if (paused) {
                return;
            }
            paused = true;
            stage.gate.paused = true;
            game = findCam() ?? game;

            // the app lets go of the pointer and of every key and button it holds
            document.exitPointerLock?.();
            stage.release();
            stage.toApp(() => dispatchEvent(new FocusEvent('blur')));
            app.update = tick;
            gameCams = app.systems.camera.cameras.filter((c) => c.enabled && !c.renderTarget && !isMine(c.entity));
            if (!editor) {
                makeEditor();
            } else if (atGame) {
                poseFrom(game);
            }
            editor.enabled = true;
            followFrame();
            for (const c of gameCams) {
                c.enabled = false;
            }
            syncIcons();
            useCam(editor);
            restart();
            const ctx = app.soundManager?._context;
            if (ctx?.state === 'running') {
                audio = ctx;
                ctx.suspend().catch(() => {});
            }
            attempt(() => entry.pause?.());
            showPlay();
            paint();
        };
        const resume = () => {
            if (!paused) {
                return;
            }
            paused = false;
            stage.gate.paused = false;
            delete app.update;
            restart();
            for (const c of gameCams) {
                c.enabled = true;
            }
            editor.enabled = false;
            useCam(findCam() ?? game);
            audio?.resume().catch(() => {});
            audio = null;
            attempt(() => entry.resume?.());

            // the selection is kept, shown again on the next pause
            hov = null;
            showPlay();
            paint();
        };
        const toggle = () => (paused ? resume() : pause());

        // the app's real update, once, with a fixed delta; its own clocks (pause/resume) are not advanced
        const step = () => {
            if (!paused) {
                return;
            }
            delete app.update;
            app.update(STEP_DT);
            app.update = tick;
            syncIcons();
        };
        const viewFrom = () => {
            const c = selCam();
            if (!paused || !c || !editor) {
                return;
            }
            poseFrom(c);
            restart();
        };
        stage.gate.ui.add(hud.host);

        // the inspector panel: a read-only view of the app beside our toolbar, on the engines it supports. the toolbar
        // holds every viewport control, so the panel's pause, step, pick, fly, orbit and gizmos are hidden (our picker also
        // finds world points and areas); the selection is shared, and shown once, as our outline while paused
        // its toggle is the viewer's, beside the comments panel's: we say whether it can open and whether it is open
        let canInspect = false;
        let inspecting = false;
        const tellInspector = () =>
            document.dispatchEvent(
                new CustomEvent('agent:inspector', { detail: { available: canInspect, open: inspecting } })
            );
        fetch(`${INSPECTOR}/package.json`)
            .then((r) => r.json())
            .then((p) => {
                canInspect = satisfies(p.peerDependencies?.playcanvas, version);
                tellInspector();
            })
            .catch(() => {});
        document.addEventListener('agent:inspector-toggle', () => canInspect && inspect());
        const inspect = async () => {
            if (inspector) {
                return void (inspector.visible = !inspector.visible);
            }
            const [e, m] = await settle(import(`${INSPECTOR}/src/index.js`));
            if (e) {
                return say(`The inspector did not load: ${e.message}`);
            }
            const before = new Set(document.body.children);
            stage.ours(() => {
                const [ie, x] = attempt(
                    () =>
                        new m.Inspector(app, {
                            dock: 'right',
                            pauseKey: '',
                            stepKey: '',
                            toggleKey: '',
                            storageKey: 'stage-inspector',
                            onVisibleChange: (v) => {
                                inspecting = v;
                                tellInspector();
                            }
                        })
                );
                if (ie) {
                    return say(`The inspector did not open: ${ie.message}`);
                }
                inspector = x;
            });
            if (!inspector) {
                return;
            }
            for (const b of [
                inspector._pauseBtn,
                inspector._stepBtn,
                inspector._pickBtn,
                inspector._flyBtn,
                inspector._orbitBtn,
                ...Object.values(inspector._transformBtns ?? {})
            ]) {
                b?.style.setProperty('display', 'none');
            }

            // its transform fields would edit past our undo and kept edits, so they stay read-only
            const render = inspector._properties._renderSections;
            inspector._properties._renderSections = function (model) {
                for (const s of model) {
                    for (const r of s.rows) {
                        delete r.value.edit;
                    }
                }
                render.call(this, model);
            };

            const own = inspector._hierarchy.onSelect;
            inspector._hierarchy.onSelect = (node) => {
                own(node);
                if (syncing) {
                    return;
                }
                syncing = true;
                const e = node && owner(node);
                select(e ? [e] : []);
                syncing = false;
            };
            const draw = inspector._drawHighlight;
            inspector._drawHighlight = function (node, color) {
                if (!(paused && sel.includes(node))) {
                    draw.call(this, node, color);
                }
            };
            if (sel.length) {
                select(sel);
            }
            const host = [...document.body.children].find((n) => !before.has(n));
            if (host) {
                stage.gate.ui.add(host);
            }

            // in the viewer, the panel moves beside the app into its inspector frame, as it would to a pop-out window,
            // and stays there hidden; a page on its own keeps it docked over the canvas
            const [, side] = attempt(() => parent !== window && parent.frames['stage-inspector']?.document);
            if (side?.body) {
                stage.ours(() => {
                    const win = side.defaultView;
                    side.body.replaceChildren(side.adoptNode(inspector._host));
                    const css = side.createElement('style');
                    css.textContent = INSPECTOR_SIDE_CSS;
                    inspector._host.shadowRoot.append(css);
                    win.addEventListener('keydown', inspector._onKeyDown);
                    inspector._popup = win;
                    const dock = inspector._dockBack;
                    inspector._dockBack = function () {
                        if (this._popup !== win || win.closed) {
                            dock.call(this);
                        }
                    };
                    inspector._applyLayout();
                    inspector._popBtn.style.setProperty('display', 'none');

                    // a reload takes its panel with it
                    addEventListener('pagehide', () => inspector._host?.remove());
                });
            }
            inspecting = true;
            tellInspector();
        };
        // the mini-stats over the app's canvas: frame time and its gpu and cpu passes, draw calls and memory. its
        // toggle is the viewer's too, and a reload keeps it as it was
        let stats = null;
        const tellStats = () =>
            document.dispatchEvent(
                new CustomEvent('agent:stats', { detail: { available: true, open: !!stats?.enabled } })
            );
        const showStats = (on) => {
            if (on && !stats) {
                stage.ours(() => {
                    const [e, x] = attempt(() => createStats(app, canvas));
                    if (e) {
                        return say(`MiniStats did not open: ${e.message}`);
                    }
                    stats = x;
                    stage.gate.ui.add(stats.div);
                });
            } else if (stats) {
                stats.enabled = on;
            }
            if (on && !stats) {
                return;
            }
            localStorage.setItem(STATS_KEY, on ? '1' : '0');
            tellStats();
        };
        document.addEventListener('agent:stats-toggle', () => showStats(!stats?.enabled));
        if (localStorage.getItem(STATS_KEY) === '1') {
            showStats(true);
        } else {
            tellStats();
        }

        stage.gate.hotkey = (e) => {
            if (e.code !== 'KeyP' || !(MAC ? e.metaKey : e.ctrlKey) || e.shiftKey) {
                return false;
            }
            if (!e.altKey) {
                toggle();
            } else if (paused) {
                step();
            }
            return true;
        };
        showPlay();
        report();

        both = true;
        canvas.dataset.stageTools = '';
        console.info('Stage tools ready', { editable, camera: pathOfE(cam) });
        return {
            app,
            select,
            gizmos,
            hud,
            pause,
            resume,
            step,
            paused: () => paused,
            drive: () => car,
            inspector: () => inspector,
            grid: () => grid.enabled,
            stats: () => stats,
            inspectable: () => canInspect
        };
    }
};
