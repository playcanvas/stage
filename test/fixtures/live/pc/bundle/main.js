// bundled with the engine; ?noline leaves out the line that hands the engine module to the viewer
import * as pc from 'playcanvas';

import { build } from '../scene.mjs';

const app = build(pc, document.getElementById('c'));
if (!location.search.includes('noline'))
    {globalThis[Symbol.for('playcanvas.inspector')]?.register(app, {
        version: pc.version,
        revision: pc.revision,
        protocol: 1,
        pc,

        // the app's own clocks, which the engine doesn't own
        pause: () => (window.clocks.paused += 1),
        resume: () => (window.clocks.resumed += 1)
    });}
window.clocks = { paused: 0, resumed: 0 };
