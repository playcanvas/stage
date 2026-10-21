import * as pc from 'playcanvas';

import { build } from './scene.mjs';

const app = build(pc, document.getElementById('c'));

// ?hud: an html card over the canvas, styled from a stylesheet, as a game's hud often is
if (new URLSearchParams(location.search).has('hud')) {
    const s = document.createElement('style');
    s.textContent =
        '.hud-card { position: fixed; left: 40px; top: 40px; width: 160px; height: 90px; background: rgb(255, 0, 255); }';
    document.head.append(s);
    document.body.append(Object.assign(document.createElement('div'), { className: 'hud-card', textContent: 'Tap' }));
}

// ?controls:the engine's camera-controls script drives the camera, as in a scaffolded app
if (new URLSearchParams(location.search).has('controls')) {
    const { CameraControls } = await import('playcanvas/scripts/esm/camera-controls.mjs');
    const cam = app.root.findByName('Camera');
    cam.addComponent('script');
    cam.script.create(CameraControls);
}

// ?frame: the engine's camera-frame script gives the game camera its look (tone mapping, bloom), as a polished app does
if (new URLSearchParams(location.search).has('frame')) {
    const { CameraFrame } = await import('playcanvas/scripts/esm/camera-frame.mjs');
    const cam = app.root.findByName('Camera');
    cam.addComponent('script');
    const frame = cam.script.create(CameraFrame);
    frame.rendering.toneMapping = 'aces2';
    frame.bloom.enabled = true;
    frame.bloom.intensity = 0.03;
    window.frame = frame;
}
