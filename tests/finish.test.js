// Material-removal maps: a known stepped stack against a known model.
const path = require('path');
const { fnVoxelize, fnCarve } = require(path.join(__dirname, '..', 'jog', 'tools', 'finish.js'));
const { slicePlan } = require(path.join(__dirname, '..', 'jog', 'tools', 'slicer2.js'));
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('PASS ', name, extra || ''); } else { fail++; console.log('FAIL ', name, extra || ''); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

function boxTris(x0, y0, z0, x1, y1, z1) {
  const V = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const I = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return I.flatMap(i => V[i]);
}
function pyramid(base, height, n) {           // square pyramid as stacked facets
  const t = [], h = base / 2;
  const B = [[-h, -h, 0], [h, -h, 0], [h, h, 0], [-h, h, 0]].map(p => [p[0] + h, p[1] + h, p[2]]), A = [h, h, height];
  for (let i = 0; i < 4; i++) t.push(...B[i], ...B[(i + 1) % 4], ...A);
  t.push(...B[0], ...B[2], ...B[1], ...B[0], ...B[3], ...B[2]);
  return t;
}
const asmOf = plan => ({ thickness: plan.thickness, size: plan.size, pieces: plan.pieces });

// 1. a box model and a stack that is exactly the box: nothing to remove
{
  const tris = new Float32Array(boxTris(0, 0, 0, 60, 40, 30));
  const model = { tris, count: 12, min: [0, 0, 0], max: [60, 40, 30], warnings: [] };
  const plan = slicePlan(model, { mode: 'stack', axes: ['z'], thickness: 6 });
  const g = fnVoxelize(asmOf(plan), tris, 120), res = fnCarve(g, ['top', 'front', 'right']);
  const vol = 60 * 40 * 30;
  ok('box: stack volume about right', near(res.stackVolume, vol, vol * .06), res.stackVolume.toFixed(0));
  ok('box: almost no excess', res.excess < vol * .03, res.excess.toFixed(0));
  ok('box: nothing left', res.left <= res.excess + 1e-9);
}
// 2. a pyramid against its stepped stack: the excess is the steps, top view removes all of it
{
  const tris = new Float32Array(pyramid(80, 60));
  const model = { tris, count: tris.length / 9, min: [0, 0, 0], max: [80, 80, 60], warnings: [] };
  const plan = slicePlan(model, { mode: 'stack', axes: ['z'], thickness: 10, envelope: true });
  ok('pyramid: 6 layers', plan.pieces.length === 6, plan.pieces.length);
  const g = fnVoxelize(asmOf(plan), tris, 160);
  const modelVol = 80 * 80 * 60 / 3;
  let mv = 0; for (let i = 0; i < g.model.length; i++) mv += g.model[i];
  ok('pyramid: model volume', near(mv * g.r ** 3, modelVol, modelVol * .04), (mv * g.r ** 3).toFixed(0) + ' vs ' + modelVol.toFixed(0));
  const top = fnCarve(g, ['top']);
  ok('pyramid: there is excess', top.excess > modelVol * .1, top.excess.toFixed(0));
  ok('pyramid: top reaches all of it', top.left < top.excess * .02, 'left ' + top.left.toFixed(0));
  ok('pyramid: no shortfall to speak of', top.shortfall < modelVol * .02, top.shortfall.toFixed(0));
  const m = top.maps[0];
  ok('pyramid: deepest cut is about one layer', m.maxDepth > 8 && m.maxDepth < 12.5, m.maxDepth.toFixed(2));
  ok('pyramid: map volume matches removed volume', near(m.depth.reduce((a, b) => a + b, 0) * g.r * g.r, m.volume, m.volume * .01 + 1));
  // from the bottom nothing can be reached: the model's flat base is in the way everywhere
  const bottom = fnCarve(g, ['bottom']);
  ok('pyramid: bottom reaches almost nothing', bottom.maps[0].volume < top.excess * .03, bottom.maps[0].volume.toFixed(0));
  // sides in sequence never remove the same material twice
  const seq = fnCarve(g, ['front', 'back', 'left', 'right', 'top']);
  const sum = seq.maps.reduce((a, mm) => a + mm.volume, 0);
  ok('pyramid: sequence adds up', near(sum, seq.excess - seq.left, 1), sum.toFixed(0));
  ok('pyramid: later sides have less to do', seq.maps[4].volume < top.maps[0].volume);
}
// 3. extra allowance all round shows up as excess on every side
{
  const tris = new Float32Array(boxTris(0, 0, 0, 50, 50, 20));
  const model = { tris, count: 12, min: [0, 0, 0], max: [50, 50, 20], warnings: [] };
  const plan = slicePlan(model, { mode: 'stack', axes: ['z'], thickness: 5, allowance: 3 });
  const g = fnVoxelize(asmOf(plan), tris, 140), res = fnCarve(g, ['front']);
  const m = res.maps[0];
  ok('allowance: front cut about 3 mm deep', m.maxDepth > 2 && m.maxDepth < 60, m.maxDepth.toFixed(2));
  ok('allowance: some of it passes right through beside the model', m.through.some(v => v === 1));
  ok('allowance: one side cannot reach it all', res.left > 0);
  const all = fnCarve(g, ['front', 'back', 'left', 'right']);
  ok('allowance: four sides clear it', all.left < all.excess * .03, all.left.toFixed(0) + ' of ' + all.excess.toFixed(0));
}
// 4. a stack along x is handled the same way
{
  const tris = new Float32Array(pyramid(60, 60));
  const model = { tris, count: tris.length / 9, min: [0, 0, 0], max: [60, 60, 60], warnings: [] };
  const plan = slicePlan(model, { mode: 'stack', axes: ['x'], thickness: 6 });
  const g = fnVoxelize(asmOf(plan), tris, 120), res = fnCarve(g, ['left', 'right', 'top']);
  const modelVol = 60 * 60 * 60 / 3;
  ok('x stack: stack contains the model', res.shortfall < modelVol * .03, res.shortfall.toFixed(0));
  ok('x stack: three sides clear most of it', res.left < res.excess * .25, res.left.toFixed(0) + ' of ' + res.excess.toFixed(0));
}
// 5. a depth limit stops each side early and leaves the rest
{
  const tris = new Float32Array(pyramid(80, 60));
  const model = { tris, count: tris.length / 9, min: [0, 0, 0], max: [80, 80, 60], warnings: [] };
  const plan = slicePlan(model, { mode: 'stack', axes: ['z'], thickness: 10 });
  const g = fnVoxelize(asmOf(plan), tris, 160);
  const free = fnCarve(g, ['top']), lim = fnCarve(g, ['top'], 4);
  ok('limit: no cut deeper than the limit', lim.maps[0].maxDepth <= 4 + g.r, lim.maps[0].maxDepth.toFixed(2));
  ok('limit: removes less and leaves some', lim.maps[0].volume < free.maps[0].volume && lim.left > 0);
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
