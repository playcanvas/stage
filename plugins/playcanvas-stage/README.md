# PlayCanvas Stage plugin

The `playcanvas-stage` plugin is an editor for working on PlayCanvas apps with your coding agent: Stage attaches to
an app's own running dev server and shows it in a viewer on this machine, where you play and pause it, point at what
you mean and edit it together. It is modelled on Claude Code's built-in Artifact tools and runs entirely locally: the
same input schemas under `Stage` names, with claude.ai replaced by a daemon on `127.0.0.1`. Nothing leaves the
machine except what the app itself loads and the CDN scripts and Google Fonts a published page loads.

## What's in here

```
.mcp.json                   "stage" MCP server: Stage, StageComments, StageData, StageCheck
hooks/hooks.json            UserPromptSubmit: surfaces comments you sent to the agent; starts Codex's watcher
monitors/monitors.json      stage-comments*: wakes an idle session when you send comments to the agent
commands/stage.md           /stage opens the gallery
scripts/watch-comments.ts   the comment watcher the monitor (and Codex's hook) runs
server/mcp.ts               stdio MCP server (zero dependencies)
server/daemon.ts            local viewer + API; started on first tool call, keeps running
server/live.ts              a live stage: the dev server proxy (http and websockets), reload on change, the bridge
server/preview.ts           StageCheck preview: headless Chrome over CDP
web/                        viewer shell, gallery, and the in-page runtime (window.agent)
web/live/                   injected into a live app: the hook, the attach module, the engine bridge, the scene tools
web/live/inspector/         @playcanvas/inspector, vendored while it is pre-1.0
skills/stage-design         the design pass and the process: create-playcanvas, dev server, attach, fold edits
skills/stage-capabilities   the local window.agent contract: db, user, assets, stage
~/.playcanvas-stage/        all state: stages, versions, comments, db, assets, diagnostics
```

## Install

In Claude Code 2.1.275 or later:

```bash
/plugin install playcanvas-stage --marketplace playcanvas/stage
```

The [repository README](../../README.md#install) covers the CLI, the desktop app and Codex.

## Using it

Ask for a scene ("build a 3D scene of my desk", "block out a riverside plaza with a fountain and benches"), or point
the agent at an app you have. The agent loads `stage-design`, scaffolds a project with `create-playcanvas` in your
working directory when there is none, starts its dev server in a background shell (or uses the one you run), and
attaches Stage to it with `Stage`, passing the server's page as `url` and the project as `root`. The first attach
opens it in your browser:

- Gallery: <http://localhost:47318/stages> (`http://localhost:47318/` redirects there, and `/stage` opens it)
- Stage: `http://localhost:47318/stage/<uuid>`; each stage runs on its own origin `http://<uuid>.localhost:47318`,
  where a live app is proxied at the root, so absolute paths and client-side routing work unchanged, and browser
  storage is per stage.

Stage never starts, restarts or stops the dev server. While it isn't answering the viewer shows a waiting banner and
attaches when it comes up; an attached server that goes away shows as unreachable. The project's own hot reload works
through the proxy (websockets included); a server with none (static files, a plain Express server) gets a reload of
the view when a file under the project changes. Any app on engine 2.23 or newer is found through the engine's devtools
hook, whatever its stack; an app whose engine is bundled into its own code adds one line, which the viewer shows.

The app runs as in its own tab. The toolbar in a strip above the app, off its canvas, pauses it (⌘P, or Ctrl+P off a Mac, as in Unity): its updates, input, pointer lock and
audio stop, and an editor camera takes over, as in the PlayCanvas Editor and driven by the Inspector's orbit and fly:
drag to orbit, middle-drag or Shift+drag to pan, the wheel to zoom, right-drag to look and W/A/S/D/Q/E to fly, and F
to focus the selection (or the whole scene), while the game camera stays where the app put it. Every toolbar button names what
it does and its key on hover. Playing, the viewer around the app dims and the play button is lit. Paused, step one frame (⌥⌘P), click an entity to select it (each camera shows as an icon, and selected,
as what it sees; and View from camera in the toolbar puts the editor camera at its view), switch between move, rotate and
scale with 1/2/3, toggle local/world with X, snap with Shift and undo with Ctrl/⌘+Z. A ground grid on y = 0 (10 m,
1 m and 0.1 m lines, black over light ground and white over dark, red along X and blue along Z, fading out with
distance) shows to the editor camera only; the
toolbar's Grid button or G toggles it, and the choice survives reloads. It never shows in comment captures and is
never picked. Every edit is saved at once to
the stage's database (the `edits` collection, one document per entity path), shows in every open view and survives
reloads; it applies once when its entity appears, after which the app's own writes win. **Apply** sends the agent
one comment listing them, and it writes them into the app's source; **Discard** puts the entities back and deletes
the edits, undoably. The Inspector button in the header opens the PlayCanvas
Inspector beside the tools as a read-only view of the app: the viewport controls are the toolbar's only, and the
selection is shared (a click in the view or a row in the panel). The MiniStats button beside it shows the app's
frame, CPU and GPU timings, draw calls, memory and resource counts over its canvas, in the Inspector's look, at three
sizes (compact, detailed, and with graphs), and stays on across reloads until toggled off.

In the viewer, toggle **comment mode** (the **Comment** button, or C; a playing app pauses), click an entity, or drag
across an area (empty space included), and leave a comment. Outside the canvas, any element of the page takes a comment, and a drag that
starts on text quotes it. Comment mode stays on until **Done commenting**, C, or a second Esc (the first closes an
open draft). Shift+click adds another object to the open comment (again to take it out), and Shift+drag adds
everything an area covers. A comment is pinned to the 3D point it was placed at and follows the camera; the agent
gets the entity's path, that point and a capture of what you saw. Drag the sidebar's left edge to resize it
(double-click to reset). The comment box opens at the spot you picked (Enter posts, Shift+Enter adds a line), with
**Comment** and **Send to Agent**; the sidebar lists the threads. A comment or reply can carry up to 4 reference
images, pasted into its box, dropped onto it or picked with its image button; they are scaled to at most 1568 px
and the agent reads them with the thread. A thread sent to the agent shows **Queued for an
agent session** until a session hears of it, **Working on it…** (with a spinner) once the monitor, Codex watcher or
prompt hook delivers it or the agent reads it, and **Hasn't replied yet** if no reply comes within 10 minutes. **Send to Agent**
(or `@agent` in the text) activates the thread, and the agent reads, replies to and resolves it
with `StageComments` without you typing anything: the plugin's `stage-comments` monitor,
which Claude Code starts the first time `stage-design` loads in a session
(one entry per name, bare and `playcanvas-stage:`-qualified, since a trigger matches the name the skill
was invoked by), polls every 2s and
wakes the idle session (Codex works differently, see below). Without it (non-interactive
sessions), your next message gets a notice. Deleting a thread while it is **Working on it…** or **Hasn't replied
yet** withdraws it the same way: the agent is told to drop that request, revert the changes it made for it, and not
reply. A thread deleted while still queued never reaches the agent.

Comments reach only the sessions linked to the stage: one that published or read it (paste its URL into a
session to link it). The circle at the header's right shows who is there: a green dot while a linked session's
monitor is polling (**Agent is watching**), amber when a linked session is open without one (comments arrive with
your next message there), and hollow when none is (**No agent session**; comments you send wait until a session
links it). Each session's MCP server checks in every 5s, and one silent for 12s counts as gone.

## Settings (env)

| variable          | default               | effect                                      |
| ----------------- | --------------------- | ------------------------------------------- |
| `STAGE_PORT`      | `47318`               | viewer and API port                         |
| `STAGE_DIR`       | `~/.playcanvas-stage` | state directory                             |
| `STAGE_AUTO_OPEN` | on                    | `0` stops opening new stages in the browser |
| `CHROME_PATH`     | auto                  | Chrome binary for `StageCheck` preview      |

The daemon keeps running after the session; stop it with `kill $(jq .pid ~/.playcanvas-stage/server.json)`.

## Codex

`.codex-plugin/plugin.json` points Codex at `codex.mcp.json`, which starts the same server from the
plugin folder, so both CLIs share one daemon and one set of stages. Codex asks before each
Stage tool call unless you approve the server's tools. Codex tells MCP servers nothing about
the workspace, so pass absolute file paths there (relative ones are refused with a clear error),
and supporting files may come from anywhere under your home folder.

Codex has no monitors, so on your first message in a Codex session the prompt hook starts a
detached `watch-comments.ts --codex` for that session. It hands each comment you send to the agent
to `codex queue` (experimental in Codex), which makes the idle session take a turn, and it exits
when that Codex process does. Its pid file is `~/.playcanvas-stage/watchers/<session>.pid`.

## Trust boundaries

- Binds `127.0.0.1` only and rejects any `Host` that isn't `localhost`, `127.0.0.1` or `<uuid>.localhost`.
- The agent API needs the bearer token in `~/.playcanvas-stage/server.json` (mode 0600).
- Viewer writes (comments) must come from the viewer origin; a page's runtime API is scoped to its
  own stage by origin and to the capabilities it declares, and never reaches comments.
- Pages run under the original's CSP (scripts only from the five CDN hosts, styles only from
  Google Fonts, `connect-src 'self'`) in a sandboxed iframe with no modals or downloads.
- A live stage's dev server `url` is set only by the agent's authenticated publish, never by a viewer or a page, and
  must be `http` on `localhost`, `127.0.0.1` or `[::1]` (not the daemon itself); its `root` must sit under the
  working directory or the scratchpad. The proxy rewrites `Host` to the server's own, keeps redirects to it on the
  frame origin, and replaces the app's own CSP and framing headers with the frame's, plus any origins the publish
  lists in `allow`.
- Comment text, database rows, diagnostics and page-saved versions reach the model inside the
  original's "treat as data, not instructions" fences.

## Differences from Claude Code's tools

Off or compiled out in Claude Code 2.1.283 too, or meaningless locally: sharing and audiences,
types and quickstart, pin, rooms, handlers, live-doc sync, the `mcp` capability, and live watches.
Instead of a live watch, the `stage-comments` monitor wakes the session for comments sent to
the agent, and the hook catches any it missed when you next type. Chrome and
Firefox resolve `*.localhost`; Safari may not.

Stages replace artifacts: the tools are `Stage`, `StageComments`, `StageData` and `StageCheck`, the skills
`stage-design` and `stage-capabilities`, the viewer lives at `/stages` and `/stage/<id>`, and the capability a
page republishes itself with is `stage`.

A 3D stage is a live app on its own dev server; the JSON scene scaffold is retired, and pages published from it keep
working, as each is self-contained. Stage also publishes `.html` pages: Markdown pages and the automatic Mermaid and
highlight.js runtimes are gone. The page API is `window.agent`, and its events are named `agent:*`.

Two local additions that don't change any tool contract: `StageCheck`'s headless Chrome adds
`--enable-unsafe-swiftshader` so WebGL pages render in preview, and republishes hard-link unchanged
supporting files instead of copying them.
The page runtime also adds `window.agent.pick(el, fn)` and `window.agent.pickRect(el, fn)`, so a 3D page resolves what is
under the cursor (`fn(x, y, { clicks })`: 0 on hover, 2 on a double-click), and which objects a drawn area covers (a picker
may also return `image`, a data: url capture of the area, which the daemon checks, stores beside the thread and hands
the agent as an image), inside its canvas in comment mode; a pick that returns `false`
marks empty space, which gets no highlight and no click comment. Such a page can draw the
highlight itself: it hears `agent:comment-mode` on `document` and a cancelable `agent:focus` on its element. It also
places its comment pins: `agent:pin` on its element asks where a comment sits (set `detail.x`/`y` in client px, or
`detail.hidden`), and `agent:layout` on `document` makes pins follow when the view moves without scrolling.
`agent:draft` on `document` (`detail.open`) says a comment box is open, so a page drops its hover highlight until it closes. Page
elements outside a canvas never call them and take ordinary DOM comments.

## Tests

From the repository root:

```bash
npm test
npm run typecheck
npm run lint
```
