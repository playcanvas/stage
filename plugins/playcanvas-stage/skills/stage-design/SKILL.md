---
name: stage-design
description: Design guidance and the process for Stages - real PlayCanvas apps, scaffolded with create-playcanvas and running on their own dev server, with Stage attached so viewers select, move, rotate and scale entities, play and pause, and comment on what they see. Load before building any 3D scene, model viewer, level or spatial study, and before changing one that is attached.
---

Work the way a lighting and layout lead at a small visualisation studio would: every scene gets a deliberate camera, a real light and materials that belong to its subject. Precedence is always the user's own words, then the project's existing assets and conventions, then your choices.

## Read the request first

Decide the treatment; designing is a given. A model viewer, a layout study or a spatial explainer is utilitarian: honest scale, clear light, no flourish. A showcase scene is editorial: one strong light direction, a composed camera, one bold material. A well-lit, well-framed plain scene is always acceptable; a busy one sometimes isn't.

## Fundamentals for every scene

**Respect what exists.** Use the project's GLBs, material libraries, units and PlayCanvas conventions when they exist. When this session offers them, load `build-app` for the app's structure, `inspect-glb` and `calibrate-model` before placing any model, `light-scene` for lighting, and `apply-conventions` or `assemble-scene` for engine patterns; this skill fills the gaps they leave.

**Ground it in the subject, at real scale.** Units are metres. A desk is 0.72 m high; a mug is 0.1 m across. Build from the subject's own objects and materials, and include one detail only this subject would have (the brand of lamp head, the joint on the shelf) as geometry, not decoration.

**Plan before building.** Write a short scene plan:

- **Materials:** 4-6 named PBR swatches (diffuse RGB, gloss, metalness), taken from the subject's world. Without environment lighting a metal has nothing to reflect and renders dark: give the scene an environment, or suggest metal with a warm diffuse and high gloss.
- **Light:** one key light with a clear direction and shadows; ambient low enough that shadows read; no more lights than the image needs.
- **Camera:** a fov (35-50 for objects, wider only for rooms), a position and a target that frame the subject with room to breathe, slightly above eye level unless the subject says otherwise.
- **Composition:** one sentence on what the eye lands on first.

**Ground everything.** Objects sit on a surface: a floor, a plinth, a desk. Nothing floats and nothing sinks through the ground; calibrate each model's scale, grounding offset and yaw once.

**Make it complete at rest.** The first frame is the picture: framed, lit, grounded, with shadows. Motion the subject doesn't need (an auto-spin, a fly-in) only gets in the way of reviewing it.

**Avoid AI-generated 3D.** It clusters around a spinning cube, the default blue-grey clear colour, a grey grid floor, flat unshadowed light, a tiny object centred in a void, heavy bloom and rainbow primitives. When the user asks for one of these, follow them; otherwise don't spend the freedom there.

**Name entities for people.** An entity's path, its name and its ancestors' from the root (`/Desk/Lamp`), is how the person, the comments and the edits refer to it, so give every entity a short, meaningful name (`Lamp`, `DeskLeft`), never `Cube` or `Object 1`, and keep names unique among siblings and stable once attached: viewer edits are kept by path. Entities that share a path (spawned copies) can't be moved in the viewer.

## Process

1. Write the scene plan above.
2. **The project.** With an existing app, use it: run `npm ls playcanvas` there, and below 2.23.0 upgrade it with `npm i playcanvas@^2.23`. With none, scaffold one in the working directory (never in Stage's own folders; the project is the person's):

    ```bash
    npx create-playcanvas@latest <dir> -f engine -s <starter> --no-skills -y
    cd <dir> && npm install && npm i playcanvas@^2.23
    ```

    Starters: `spinning-cube`, `interactive-sphere`, `model-viewer`, `splat-viewer`, `product-configurator`, `physics-playground`, `first-person-controller`, `third-person-controller`, `sprite-game`, `scene-editor`, `vr-starter`, `ar-placement`; pick the nearest to the request. `--no-skills` leaves out the starter's own agent skills, since this plugin's cover PlayCanvas.

3. **Its dev server.** If one is already running for the project (the person's terminal, or a background shell of this session), use it. Otherwise start the project's own dev command (its `package.json` scripts say which, usually `npm run dev`) in a background shell and read the page URL from its output (Vite prints `Local: http://localhost:5173/`). Stage never starts, restarts or stops it, and you never stop one the person started.
4. **Attach.** Call `Stage` with `url` set to that page (path and query kept, such as `http://localhost:5173/?level=forest`), `root` set to the project directory, a `title` that names the scene in two to four words, an `icon` and a one-sentence `description`. The result says whether the server answered; if it didn't, start it and the open view attaches on its own. An app that calls another origin (an API server) lists it in `allow`. To compare design options, give each its own stage (a query or a project per option).
5. **Iterate.** Edit the project's source; the app hot-reloads in the viewer (or reloads when a file changes, for servers with no hot reload). After a change, `StageCheck` `verify` reads the app's console and the proxy's diagnostics as the viewer saw them.
6. **A bundled engine.** An app whose engine is bundled into its own code (a production build, webpack, esbuild) needs one line right after the app is created, with `import * as pc from 'playcanvas'`; the viewer shows it when it's missing. It is harmless outside the viewer:

    ```js
    globalThis[Symbol.for('playcanvas.inspector')]?.register(app, {
        version: pc.version,
        revision: pc.revision,
        protocol: 1,
        pc
    });
    ```

    Apps with their own clocks (wall-clock timers, tweens) add `pause` and `resume` functions to the same object, which the viewer's pause calls.

## In the viewer

The app runs as it does in its own tab. The toolbar in a strip above it (off the app's canvas) pauses and plays it (⌘P, or Ctrl+P off a Mac, as in Unity), and steps one frame while paused (⌥⌘P). Paused, the app stops (its update, input and audio) and the tools take the view: an editor camera orbits with a drag, pans with a middle-drag or Shift+drag, zooms with the wheel, looks with a right-drag and flies with W/A/S/D/Q/E, and F focuses the selection (or the whole scene), while the game camera stays where the app put it. Each of the app's cameras shows as an icon that a click selects, drawn as what it sees while selected; with a camera selected, View from camera in the toolbar puts the editor camera at its view. Viewers select entities (click, Shift+click), switch between move, rotate and scale with 1/2/3 or the toolbar, toggle local/world with X, snap with Shift, toggle a ground grid on y = 0 with G (editor camera only, never in comment captures), and undo with Ctrl/⌘+Z. The Inspector button in the viewer's header opens the PlayCanvas Inspector beside the app, read-only, sharing their selection; the toolbar holds every viewport control. The MiniStats button beside it shows the app's frame time, GPU and CPU timings, draw calls, memory and resource counts over the app, never in comment captures. Playing, the app hears all the input and the tools none of it.

Every edit is saved at once to the stage's database, in the `edits` collection, one document per entity path: `{ path, pos, rot, scale }`, the local position, euler rotation in degrees and scale. An edit applies once, when its entity appears (at attach, after each reload, or when the app adds it later); after that the app's own writes win, so an entity the app moves or respawns shows where the app puts it, and its edit stays in the database for you to fold.

## Folding edits into the source

Apply (the toolbar button) sends you one comment listing every pending edit by path with its transform; Discard deletes them instead, so only fold what is in the collection when you read it. Before changing a scene's source, fold its edits in the same way, whether or not Apply was pressed:

1. `StageData` `list` with `collection: "edits"` and the stage's `url`.
2. For each document, find the code that creates or places the entity at its `path`, and write `pos`, `rot` and `scale` there as its local transform. An entity the app positions every frame, or one whose path no longer exists, can't take a fixed transform: say so instead.
3. Once the app has reloaded with the change (it hot-reloads; check the viewer or `StageCheck` `verify`), `StageData` `batch` with a `delete` write for each folded document (`{ "op": "delete", "collection": "edits", "doc_id": "<id>" }`). Tell the user which edits you folded and which you couldn't.

## Comments on a scene

In comment mode the app pauses at the game camera's view, the viewer outlines what a click would comment on, keeps what a comment is on outlined while it is written or its thread is open, and pins each comment on the 3D point it was placed at. A comment placed on an entity arrives labelled `<Title> › /Desk/Lamp` with `[anchored element] <canvas data-entity="/Desk/Lamp" data-point="0.91,0.02,1.2">`: `data-entity` is the entity path and `data-point` the world point, in metres, that was clicked; it arrives with a `[view image]`, a capture of that entity and some of what surrounds it as the viewer saw it. Shift+click adds more entities to the open comment and Shift+drag adds what an area covers; each arrives as an `[also on]` line after the first, and "these" means all of them. Empty space takes no click comment. A viewer can also drag across an area, empty space included: that comment arrives as `[region of]` the canvas, with one `[inside region] <canvas data-entity="/Desk">` per entity at least half inside it that shows there (outermost entities only, up to 16), the snippet carries `data-camera="x,y,z,tx,ty,tz,fov"` (the camera position, a point it looked at, and its fov), and the comment arrives with a `[region image]` of the area, for things only visible on screen (a shadow, a seam, a z-fighting flicker). A comment or reply can also carry up to 4 reference images the viewer pasted or uploaded, each marked `[attached image]` under that comment (a look to match, a screenshot of a bug). Look at these images before changing the scene. Find the entity by its path in the project's source, fold any edits first, and make the change.
