// the app's own engine module, filled in by the attach module; every module we serve imports playcanvas from here
let pc = null;
export const set = (m) => (pc = m);
export { pc as default };
