// one small game scene for every way an app can load its engine: a desk with a box, a ball, a spinner the app
// moves every frame, two coins sharing a path, and counters of the input the app hears
export const build = (pc, canvas) => {
    // no msaa: the tests render in software gl, where it costs a 2-core ci runner a third of its frame rate
    const app = new pc.Application(canvas, {
        mouse: new pc.Mouse(canvas),
        keyboard: new pc.Keyboard(window),
        graphicsDeviceOptions: { antialias: false }
    });
    app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
    app.setCanvasResolution(pc.RESOLUTION_AUTO);
    window.addEventListener('resize', () => app.resizeCanvas());

    const add = (name, parent, opts = {}) => {
        const e = new pc.Entity(name);
        if (opts.render) {e.addComponent('render', { type: opts.render });}
        if (opts.pos) {e.setLocalPosition(...opts.pos);}
        if (opts.scale) {e.setLocalScale(...opts.scale);}
        parent.addChild(e);
        return e;
    };
    const cam = add('Camera', app.root);
    cam.addComponent('camera', { clearColor: new pc.Color(0.2, 0.22, 0.25) });
    cam.setPosition(0, 2.5, 7);
    cam.lookAt(0, 0.5, 0);
    const sun = add('Sun', app.root);
    sun.addComponent('light', { type: 'directional' });
    sun.setEulerAngles(45, 30, 0);
    const desk = add('Desk', app.root);
    add('Box', desk, { render: 'box', pos: [-1.5, 0.5, 0] });
    add('Ball', app.root, { render: 'sphere', pos: [1.5, 0.5, 0] });
    const spinner = add('Spinner', app.root, { render: 'box', pos: [0, 2, 0], scale: [0.4, 0.4, 0.4] });
    for (const x of [-0.6, 0.6]) {add('Coin', app.root, { render: 'cylinder', pos: [x, 0.1, 2], scale: [0.4, 0.1, 0.4] });}

    let t = 0;
    app.on('update', (dt) => {
        t += dt;
        spinner.setLocalPosition(Math.sin(t), 2, 0);
    });

    window.heard = { key: 0, pointer: 0, wheel: 0, page: 0, lock: 0 };
    app.keyboard.on('keydown', () => window.heard.key++);
    app.mouse.on('mousedown', () => window.heard.pointer++);
    app.mouse.on('mousewheel', () => window.heard.wheel++);
    window.addEventListener('pointerdown', () => window.heard.page++);
    window.held = (key) => app.keyboard.isPressed(pc[`KEY_${key}`]);
    window.lockPointer = () => {
        window.heard.lock++;
        return canvas.requestPointerLock();
    };
    window.app = app;
    app.start();
    return app;
};
