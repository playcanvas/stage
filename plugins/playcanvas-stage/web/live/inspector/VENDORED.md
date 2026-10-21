# @playcanvas/inspector, vendored

`src/`, `LICENSE` and `package.json` are copied unchanged from
[playcanvas/inspector](https://github.com/playcanvas/inspector) at `8ed76de` (0.3.0), while it is pre-1.0.
Fixes go upstream as pull requests, then this copy is refreshed. A copy installed or linked in an app's
`node_modules/@playcanvas/inspector` is served instead of this one.

`../scene-tools.mjs` subclasses `CameraOrbit` and `CameraFly` from `src/viewport-tools.js`, hides the panel's
viewport buttons (`_pauseBtn`, `_stepBtn`, `_pickBtn`, `_flyBtn`, `_orbitBtn`, `_transformBtns`), replaces a few
`Inspector` members (`_drawHighlight`, `_hierarchy.onSelect`, `_dockBack`, `_properties._renderSections`, which
drops the transform fields' `edit` to keep the panel read-only), and moves the panel into the viewer's inspector
frame the way `_popOut` does (`_host`, `_popup`, `_onKeyDown`, `_applyLayout`, `_popBtn`): recheck those after a
refresh.
