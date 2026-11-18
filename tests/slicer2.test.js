'use strict';
const TOOLS = require('path').join(__dirname, '..', 'jog', 'tools') + '/';
const { sliceModel, nestParts } = require(TOOLS + 'slicer.js');
const { polyBool } = require(TOOLS + 'boolops.js');
const { slicePlan, bestPlans } = require(TOOLS + 'slicer2.js');
const fs = require('fs'), vm = require('vm');

let pass = 0, fail = 0;
const results = [];
function test(name, fn) {
  const t0 = Date.now();
  try { fn(); pass++; results.push('PASS  ' + name + '  (' + (Date.now() - t0) + ' ms)'); }
  catch (e) { fail++; results.push('FAIL  ' + name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e)); }
}
function ok(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }
function near(a, b, tol, msg) { if (!(Math.abs(a - b) <= tol)) throw new Error((msg || 'near') + ': ' + a + ' vs ' + b + ' (tol ' + tol + ')'); }

/* ---------- meshes ---------- */
function mk(tris) { return { tris: new Float32Array(tris), count: tris.length / 9 }; }
function boxTris(x0, y0, z0, x1, y1, z1) {
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const out = [];
  for (const t of f) for (const i of t) out.push(v[i][0], v[i][1], v[i][2]);
  return out;
}
const box = (w, d, h) => mk(boxTris(0, 0, 0, w, d, h));
function sphere(r, nLat, nLon) {
  const P = (i, j) => { const th = Math.PI * i / nLat, ph = 2 * Math.PI * (j % nLon) / nLon; return [r + r * Math.sin(th) * Math.cos(ph), r + r * Math.sin(th) * Math.sin(ph), r - r * Math.cos(th)]; };
  const out = [];
  for (let i = 0; i < nLat; i++) for (let j = 0; j < nLon; j++) {
    const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
    if (i > 0) out.push(...a, ...b, ...d);
    if (i < nLat - 1) out.push(...b, ...c, ...d);
  }
  return mk(out);
}
function torus(R, r, nu, nv) {
  const P = (i, j) => { const u = 2 * Math.PI * (i % nu) / nu, v = 2 * Math.PI * (j % nv) / nv; return [(R + r * Math.cos(v)) * Math.cos(u), (R + r * Math.cos(v)) * Math.sin(u), r * Math.sin(v)]; };
  const out = [];
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
    out.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  return mk(out);
}
function cone(r, h, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a0 = 2 * Math.PI * i / n, a1 = 2 * Math.PI * ((i + 1) % n) / n;
    const p = [r + r * Math.cos(a0), r + r * Math.sin(a0), 0], q = [r + r * Math.cos(a1), r + r * Math.sin(a1), 0];
    out.push(...p, ...q, r, r, h, r, r, 0, ...q, ...p);
  }
  return mk(out);
}
const LPOLY = [[0, 0], [60, 0], [60, 20], [20, 20], [20, 40], [0, 40]];
function lPrism(h) {
  const tr = [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 5]], out = [];
  for (const t of tr) {
    out.push(LPOLY[t[0]][0], LPOLY[t[0]][1], 0, LPOLY[t[2]][0], LPOLY[t[2]][1], 0, LPOLY[t[1]][0], LPOLY[t[1]][1], 0);
    out.push(LPOLY[t[0]][0], LPOLY[t[0]][1], h, LPOLY[t[1]][0], LPOLY[t[1]][1], h, LPOLY[t[2]][0], LPOLY[t[2]][1], h);
  }
  for (let i = 0; i < 6; i++) {
    const a = LPOLY[i], b = LPOLY[(i + 1) % 6];
    out.push(a[0], a[1], 0, b[0], b[1], 0, b[0], b[1], h, a[0], a[1], 0, b[0], b[1], h, a[0], a[1], h);
  }
  return mk(out);
}
function tetra() {   // asymmetric in every axis: x/100 + y/60 + z/40 <= 1
  const A = [0, 0, 0], B = [100, 0, 0], C = [0, 60, 0], D = [0, 0, 40];
  return mk([...A, ...C, ...B, ...A, ...B, ...D, ...A, ...D, ...C, ...B, ...C, ...D]);
}
const twoBoxes = () => mk(boxTris(0, 0, 0, 30, 30, 20).concat(boxTris(50, 0, 0, 90, 30, 20)));
const hollowBox = () => mk(boxTris(0, 0, 0, 100, 60, 12).concat(boxTris(30, 20, -1, 70, 40, 13)));   // inner box = hole under even-odd

/* ---------- geometry helpers (independent of slicer2) ---------- */
function sArea(l) { let s = 0; for (let i = 0, j = l.length - 1; i < l.length; j = i++) s += l[j][0] * l[i][1] - l[i][0] * l[j][1]; return s / 2; }
function inLoop(x, y, l) { let c = false; for (let i = 0, j = l.length - 1; i < l.length; j = i++) { if ((l[i][1] > y) !== (l[j][1] > y) && x < (l[j][0] - l[i][0]) * (y - l[i][1]) / (l[j][1] - l[i][1]) + l[i][0]) c = !c; } return c; }
function inLoops(x, y, loops) { let c = false; for (const l of loops) if (inLoop(x, y, l)) c = !c; return c; }
function eoArea(loops) {
  let a = 0;
  loops.forEach((l, i) => { let d = 0; const m = [(l[0][0] + l[1][0]) / 2, (l[0][1] + l[1][1]) / 2]; loops.forEach((o, j) => { if (j !== i && Math.abs(sArea(o)) > Math.abs(sArea(l)) && inLoop(m[0], m[1], o)) d++; }); a += (d & 1 ? -1 : 1) * Math.abs(sArea(l)); });
  return a;
}
function perim(l) { let s = 0; for (let i = 0, j = l.length - 1; i < l.length; j = i++) s += Math.hypot(l[i][0] - l[j][0], l[i][1] - l[j][1]); return s; }
function isSimple(loops) {
  const segs = [];
  loops.forEach((l, li) => l.forEach((p, i) => segs.push([p, l[(i + 1) % l.length], li, i, l.length])));
  const orient = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const s = segs[i], t = segs[j];
    if (s[2] === t[2] && (t[3] === s[3] + 1 || (s[3] === 0 && t[3] === s[4] - 1))) continue;   // neighbours share a vertex
    const d1 = orient(s[0], s[1], t[0]), d2 = orient(s[0], s[1], t[1]), d3 = orient(t[0], t[1], s[0]), d4 = orient(t[0], t[1], s[1]);
    const E = 1e-7;
    if (((d1 > E && d2 < -E) || (d1 < -E && d2 > E)) && ((d3 > E && d4 < -E) || (d3 < -E && d4 > E))) return false;
  }
  return true;
}
const to3 = (p, a, b, t) => [0, 1, 2].map(k => p.origin[k] + a * p.u[k] + b * p.v[k] + (t || 0) * p.n[k]);
const toPlane = (p, P) => [0, 1].map(i => { const ax = i ? p.v : p.u; return (P[0] - p.origin[0]) * ax[0] + (P[1] - p.origin[1]) * ax[1] + (P[2] - p.origin[2]) * ax[2]; });
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function checkLoopsSane(plan) {
  for (const p of plan.pieces) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    ok(p.loops.length >= 1, 'piece has loops');
    for (const l of p.loops) {
      ok(l.length >= 3, p.name + ' loop has >= 3 points');
      l.forEach((q, i) => {
        ok(isFinite(q[0]) && isFinite(q[1]), 'finite');
        const r = l[(i + 1) % l.length];
        ok(Math.hypot(q[0] - r[0], q[1] - r[1]) > 1e-7, p.name + ' repeated consecutive point');
        x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]);
      });
    }
    near(x0, 0, 1e-9, 'min u'); near(y0, 0, 1e-9, 'min v');
    near(x1, p.w, 1e-9, 'w'); near(y1, p.h, 1e-9, 'h');
    const c = cross(p.u, p.v);
    for (let k = 0; k < 3; k++) near(c[k], p.n[k], 1e-12, 'u x v = n');
    near(Math.hypot(...p.u), 1, 1e-12); near(Math.hypot(...p.v), 1, 1e-12);
  }
  plan.pieces.forEach((p, i) => ok(p.id === i, 'ids in order'));
}

/* ---------- tests ---------- */
const CONE = cone(50, 80, 48), coneBase = 48 / 2 * 2500 * Math.sin(2 * Math.PI / 48);

test('stack envelope: cone layers cover every height in the slab and the mid-plane', () => {
  const T = 4, env = slicePlan(CONE, { mode: 'stack', axes: ['z'], thickness: T });
  const mid = slicePlan(CONE, { mode: 'stack', axes: ['z'], thickness: T, envelope: false });
  ok(env.pieces.length === 20, 'layers ' + env.pieces.length);
  checkLoopsSane(env); checkLoopsSane(mid);
  for (const p of env.pieces) {
    const lo = p.index * T;
    for (let s = 0; s <= 20; s++) {
      const z = lo + T * s / 20, a = coneBase * Math.pow(1 - z / 80, 2);
      if (s === 0) { ok(p.area >= a * 0.9995 - 1, 'bottom face ' + p.name + ' ' + p.area + ' < ' + a); continue; }   // faces are sampled a hair inside
      ok(p.area >= a - 0.05 * Math.sqrt(a) * 4 - 0.01, p.name + ' area ' + p.area + ' < section ' + a + ' at z=' + z);
    }
    const m = mid.pieces.find(q => q.index === p.index);
    if (m) ok(p.area >= m.area - 1e-6, 'envelope >= mid-plane');
    near(p.origin[2], lo, 1e-9, 'layer lower face');
  }
  // envelope must genuinely be bigger than the mid-plane for a cone
  ok(env.stats.area > mid.stats.area * 1.03, 'envelope adds material');
});

test('stack envelope false reproduces sliceModel layer areas (cone, sphere, torus; all axes)', () => {
  for (const m of [CONE, sphere(40, 24, 32), torus(40, 12, 40, 16)]) for (const axis of ['x', 'y', 'z']) {
    const ref = sliceModel(m, { axis, thickness: 5 }), plan = slicePlan(m, { mode: 'stack', axes: [axis], thickness: 5, envelope: false });
    for (const L of ref.layers) {
      const a = plan.pieces.filter(p => p.index === L.index).reduce((s, p) => s + p.area, 0);
      near(a, L.area, 1e-6 * Math.max(1, L.area), axis + ' layer ' + L.index);
    }
    near(plan.stats.area, ref.layers.reduce((s, L) => s + L.area, 0), 1e-3, 'total area');
  }
});

test('stack envelope: box envelope == mid-plane', () => {
  for (const axis of ['x', 'y', 'z']) {
    const a = slicePlan(box(100, 60, 30), { mode: 'stack', axes: [axis], thickness: 3 });
    const b = slicePlan(box(100, 60, 30), { mode: 'stack', axes: [axis], thickness: 3, envelope: false });
    ok(a.pieces.length === b.pieces.length && a.pieces.length > 0);
    a.pieces.forEach((p, i) => { near(p.area, b.pieces[i].area, 1e-6); ok(p.loops[0].length === 4, 'rectangle'); });
  }
});

test('allowance: box grows by mitred offset, contains the original, polygons simple', () => {
  const p0 = slicePlan(box(100, 60, 6), { mode: 'stack', axes: ['z'], thickness: 3 }).pieces[0];
  const p = slicePlan(box(100, 60, 6), { mode: 'stack', axes: ['z'], thickness: 3, allowance: 2 }).pieces[0];
  ok(p.area <= 104 * 64 + 1e-6 && p.area >= 104 * 64 - (4 - Math.PI) * 4 - 1e-6, 'area ' + p.area);
  near(p.w, 104, 1e-6); near(p.h, 64, 1e-6);
  near(p.origin[0], -2, 1e-6); near(p.origin[1], -2, 1e-6);
  ok(isSimple(p.loops), 'simple');
  // contains the original: original minus grown (both in model coordinates) is empty
  const grown = p.loops.map(l => l.map(q => [q[0] + p.origin[0], q[1] + p.origin[1]]));
  ok(polyBool(p0.loops, grown, 'subtract').length === 0, 'contains original');
});

test('allowance: hollow box hole shrinks / vanishes; L-prism concave corner; cone; simple polygons', () => {
  const hb = hollowBox();
  const a0 = slicePlan(hb, { mode: 'stack', axes: ['z'], thickness: 4 }).pieces[1];
  ok(a0.loops.length === 2, 'hole present'); near(a0.area, 6000 - 800, 1e-6);
  const a2 = slicePlan(hb, { mode: 'stack', axes: ['z'], thickness: 4, allowance: 2 }).pieces[1];
  ok(a2.loops.length === 2); near(a2.area, 104 * 64 - 36 * 16, 1e-6, 'hole shrank to 36x16');
  near(Math.abs(sArea(a2.loops[1])), 36 * 16, 1e-6);
  ok(isSimple(a2.loops));
  const a12 = slicePlan(hb, { mode: 'stack', axes: ['z'], thickness: 4, allowance: 12 }).pieces[1];
  ok(a12.loops.length === 1, 'hole vanished'); near(a12.area, 124 * 84, 1e-6);
  // L: outward 3 mm -> exact mitre area = area + perimeter*d + (5 convex - 1 concave) * d^2
  const L = slicePlan(lPrism(6), { mode: 'stack', axes: ['z'], thickness: 3, allowance: 3 }).pieces[0];
  near(L.area, 1600 + 200 * 3 + 4 * 9, 1e-6, 'L offset area');
  ok(L.loops[0].length === 6 && isSimple(L.loops));
  // cone layers (48-gon): offset area between round and mitre expectations
  const c0 = slicePlan(CONE, { mode: 'stack', axes: ['z'], thickness: 4, envelope: false });
  const c1 = slicePlan(CONE, { mode: 'stack', axes: ['z'], thickness: 4, envelope: false, allowance: 1.5 });
  c0.pieces.forEach((p, i) => {
    const q = c1.pieces[i], per = p.cutLength;
    ok(q.area >= p.area + per * 1.5 + Math.PI * 2.25 - 1e-3 && q.area <= p.area + per * 1.5 + 4 * 2.25 + 1e-3, 'cone offset area ' + i);
    ok(isSimple(q.loops));
  });
  // torus slices seen along x: two islands that grow and merge, holes that close
  for (const al of [1, 5, 13]) {
    const t = slicePlan(torus(40, 12, 40, 16), { mode: 'stack', axes: ['z'], thickness: 4, allowance: al });
    checkLoopsSane(t);
    t.pieces.forEach(p => ok(isSimple(p.loops), 'torus simple'));
    const t0 = slicePlan(torus(40, 12, 40, 16), { mode: 'stack', axes: ['z'], thickness: 4 });
    t.pieces.forEach((p, i) => ok(p.area > t0.pieces[i].area, 'grew'));
    if (al === 13) ok(t.pieces[2].loops.length === 2, 'hole r=28 still there shrunk'), ok(t.pieces.every(p => p.loops.length <= 2));
  }
});

test('allowance: timing well under 50 ms per piece of a few hundred points', () => {
  const s = sphere(150, 200, 400), o = { mode: 'stack', axes: ['z'], thickness: 10, envelope: false, tolerance: 0.002 };
  const t0 = Date.now(), a = slicePlan(s, o), t1 = Date.now(), b = slicePlan(s, Object.assign({ allowance: 2 }, o)), t2 = Date.now();
  const pts = a.pieces.reduce((n, p) => n + p.loops[0].length, 0) / a.pieces.length;
  const per = ((t2 - t1) - (t1 - t0)) / b.pieces.length;
  results.push('      offset: avg ' + Math.round(pts) + ' points/piece, ' + per.toFixed(2) + ' ms/piece extra');
  ok(pts > 200 && per < 50, 'per piece ' + per);
  a.pieces.forEach((p, i) => { const R = Math.sqrt(p.area / Math.PI), q = b.pieces[i]; near(q.area, Math.PI * (R + 2) * (R + 2), 0.002 * q.area, 'disc offset'); });
});

test('placement: box corners land on the box for all three stack axes', () => {
  const W = 100, D = 60, H = 30;
  for (const axis of ['x', 'y', 'z']) {
    const plan = slicePlan(box(W, D, H), { mode: 'stack', axes: [axis], thickness: 5 });
    const ai = 'xyz'.indexOf(axis), ext = [W, D, H];
    ok(plan.pieces.length === ext[ai] / 5);
    near(plan.size[0], W, 1e-9); near(plan.size[1], D, 1e-9); near(plan.size[2], H, 1e-9);
    checkLoopsSane(plan);
    plan.pieces.forEach((p, i) => {
      ok(p.name === 'Panel ' + (i + 1) && p.axis === axis && p.index === i);
      ok(p.n[ai] === 1, 'n is the stack axis');
      for (const q of p.loops[0]) for (const t of [0, 5]) {
        const P = to3(p, q[0], q[1], t);
        for (let k = 0; k < 3; k++) {
          if (k === ai) near(P[k], i * 5 + t, 1e-9, 'slab position');
          else ok(Math.abs(P[k]) < 1e-9 || Math.abs(P[k] - ext[k]) < 1e-9, axis + ' corner on a face: ' + P);
        }
      }
    });
  }
});

test('placement: no mirroring (L-prism corners along z; tetra + L sampled in 3D for x, y, z)', () => {
  const pl = slicePlan(lPrism(9), { mode: 'stack', axes: ['z'], thickness: 3 });
  for (const p of pl.pieces) {
    const got = p.loops[0].map(q => to3(p, q[0], q[1]));
    ok(got.length === 6);
    for (const c of LPOLY) ok(got.some(g => Math.hypot(g[0] - c[0], g[1] - c[1]) < 1e-6), 'L corner ' + c);
  }
  const insideT = P => P[0] / 100 + P[1] / 60 + P[2] / 40;
  const insideL = P => inLoop(P[0], P[1], LPOLY);
  for (const axis of ['x', 'y', 'z']) {
    for (const [m, f, ext] of [[tetra(), P => insideT(P) < 0.97 ? 1 : (insideT(P) > 1.03 ? 0 : -1), [100, 60, 40]], [lPrism(40), P => insideL(P) ? 1 : 0, [60, 40, 40]]]) {
      const plan = slicePlan(m, { mode: 'stack', axes: [axis], thickness: 4, envelope: false });
      let checked = 0;
      for (const p of plan.pieces) {
        for (let a = -2.37; a < p.w + 3; a += 3.1) for (let b = -2.41; b < p.h + 3; b += 3.3) {
          const P = to3(p, a, b, 2), want = f(P);
          if (want < 0) continue;
          if (m.count > 4) {   // L: skip points near its walls
            if (LPOLY.some((c, i) => { const d = LPOLY[(i + 1) % 6]; return Math.abs((d[0] - c[0]) * (P[1] - c[1]) - (d[1] - c[1]) * (P[0] - c[0])) / Math.hypot(d[0] - c[0], d[1] - c[1]) < 0.2; })) continue;
            if (P[2] < 0.1 || P[2] > 39.9) continue;
          }
          const inBox = P.every((c, k) => c > 0 && c < ext[k]);
          ok(inLoops(a, b, p.loops) === (want === 1 && inBox), axis + ' ' + p.name + ' mismatch at ' + P.map(x => x.toFixed(2)));
          checked++;
        }
      }
      ok(checked > 300, 'sampled ' + checked);
    }
  }
});

test('islands split: two boxes -> Panel 1a / 1b; torus islands where expected', () => {
  const plan = slicePlan(twoBoxes(), { mode: 'stack', axes: ['z'], thickness: 5 });
  ok(plan.pieces.length === 8);
  ok(plan.pieces.map(p => p.name).join(',') === 'Panel 1a,Panel 1b,Panel 2a,Panel 2b,Panel 3a,Panel 3b,Panel 4a,Panel 4b', plan.pieces.map(p => p.name).join(','));
  near(plan.pieces[0].w, 30, 1e-9); near(plan.pieces[1].w, 40, 1e-9);
  near(plan.pieces[0].origin[0], 0, 1e-9); near(plan.pieces[1].origin[0], 50, 1e-9);
  ok(plan.pieces[0].index === 0 && plan.pieces[1].index === 0 && plan.pieces[2].index === 1);
  // along x the boxes are separate layers, and there is an empty gap (x 30..50)
  const px = slicePlan(twoBoxes(), { mode: 'stack', axes: ['x'], thickness: 5 });
  ok(px.pieces.length === 14 && px.pieces.every(p => !/[a-z]$/.test(p.name)), 'x: 6 + 8 single panels');
  ok(px.pieces[6].name === 'Panel 11', 'numbering keeps the gap: ' + px.pieces[6].name);
  // torus (axis z, R=40, r=12): along z each layer is one ring with a hole; along x the middle layers are two islands
  const tz = slicePlan(torus(40, 12, 48, 24), { mode: 'stack', axes: ['z'], thickness: 4 });
  ok(tz.pieces.length === 6 && tz.pieces.every(p => p.loops.length === 2), 'rings');
  const tx = slicePlan(torus(40, 12, 48, 24), { mode: 'stack', axes: ['x'], thickness: 4 });
  const byLayer = {};
  tx.pieces.forEach(p => { (byLayer[p.index] = byLayer[p.index] || []).push(p); });
  for (const i in byLayer) {
    const xLo = i * 4 - 52, xHi = xLo + 4, minAbs = (xLo < 0 && xHi > 0) ? 0 : Math.min(Math.abs(xLo), Math.abs(xHi));
    if (minAbs < 27.5) ok(byLayer[i].length === 2 && /a$/.test(byLayer[i][0].name) && /b$/.test(byLayer[i][1].name), 'two islands at layer ' + i);
    if (Math.max(Math.abs(xLo), Math.abs(xHi)) > 29 && minAbs > 20) ok(byLayer[i].length === 1, 'one island at layer ' + i + ' got ' + byLayer[i].length);
  }
  // nested island inside a hole: box frame with a separate block inside
  const nested = mk(boxTris(0, 0, 0, 100, 100, 10).concat(boxTris(20, 20, 0, 80, 80, 10), boxTris(40, 40, 0, 60, 60, 10)));
  const pn = slicePlan(nested, { mode: 'stack', axes: ['z'], thickness: 5 });
  ok(pn.pieces.filter(p => p.index === 0).length === 2, 'frame + inner block');
  const fr = pn.pieces[0], blk = pn.pieces[1];
  ok(fr.loops.length === 2 && blk.loops.length === 1); near(fr.area, 10000 - 3600, 1e-6); near(blk.area, 400, 1e-6);
});

function gridChecks(model, opts, analytic) {
  const plan = slicePlan(model, opts), T = opts.thickness, cl = opts.clearance == null ? 0.3 : opts.clearance;
  checkLoopsSane(plan);
  const [a, b] = opts.axes, c = 'xyz'.replace(a, '').replace(b, ''), ai = 'xyz'.indexOf(a), bi = 'xyz'.indexOf(b), ci = 'xyz'.indexOf(c);
  const A = plan.pieces.filter(p => p.axis === a), B = plan.pieces.filter(p => p.axis === b);
  ok(A.length >= 2 && B.length >= 2, 'two families');
  ok(plan.pieces.indexOf(B[0]) === A.length, 'all of the first axis, then the second');
  A.forEach((p, i) => ok(p.name === a.toUpperCase() + (p.index + 1), 'name ' + p.name));
  ok(plan.jointStats.splitPlates === 0 && new Set(plan.pieces.map(p => p.name)).size === plan.pieces.length, 'each plate one piece');
  // plates symmetric about the centre and inside the box by half a thickness
  for (const [fam, k] of [[A, ai], [B, bi]]) {
    const pos = fam.map(p => p.origin[k] + T / 2);
    pos.forEach((x, i) => { near(x + pos[pos.length - 1 - i], plan.size[k], 1e-9, 'symmetric'); ok(x - T / 2 >= T / 2 - 1e-9 && x + T / 2 <= plan.size[k] - T / 2 + 1e-9, 'inside'); });
    for (let i = 1; i < pos.length; i++) near(pos[i] - pos[i - 1], pos[1] - pos[0], 1e-9, 'even spacing');
  }
  ok(plan.joints.length > 0);
  let samples = 0;
  for (const j of plan.joints) {
    near(j.width, T + cl, 1e-12, 'slot width');
    ok(j.c1 - j.c0 >= 2 * T, 'joint long enough');
    near(j.mid, (j.c0 + j.c1) / 2, 1e-9);
    // complementary: A [mid, >= c1], B [<= c0, mid]; together they cover [c0, c1] and do not overlap
    ok(j.aSlot[0] === j.mid && j.bSlot[1] === j.mid, 'meet at mid, no overlap');
    ok(j.aSlot[1] > j.c1 && j.bSlot[0] < j.c0, 'cover the common interval and open past it');
    if (analytic) { const e = analytic(j.a.pos, j.b.pos); near(j.c0, e[0], T, 'analytic c0'); near(j.c1, e[1], T, 'analytic c1'); ok(j.c0 <= e[0] + 0.5 && j.c1 >= e[1] - 0.5, 'envelope not smaller'); }
    const pa = A.find(p => p.index === j.a.index), pb = B.find(p => p.index === j.b.index);
    // measured slot width in each plate: walk across the slot at a height well inside it
    for (const [pc, other, cc] of [[pa, j.b.pos, j.mid + (j.c1 - j.mid) * 0.5], [pb, j.a.pos, j.mid - (j.mid - j.c0) * 0.5]]) {
      const oi = pc === pa ? bi : ai, at = d => { const P = [0, 0, 0]; P[pc === pa ? ai : bi] = (pc === pa ? j.a.pos : j.b.pos); P[oi] = other + d; P[ci] = cc; const q = toPlane(pc, P); return inLoops(q[0], q[1], pc.loops); };
      const half = (T + cl) / 2;
      ok(!at(0) && !at(half - 0.01) && !at(-half + 0.01), 'slot is empty across its width');
      ok(at(half + 0.01) && at(-half - 0.01), 'material right beside the slot (width == T + clearance)');
    }
    // assembly: along the crossing line exactly one plate has material; test the neighbourhood (T/2 either way)
    for (let s = 1; s < 20; s++) {
      const cc = j.c0 + (j.c1 - j.c0) * s / 20;
      if (Math.abs(cc - j.mid) < 0.05) continue;
      let ina = 0, inb = 0, n = 0;
      for (const da of [-T / 2 + 0.01, 0, T / 2 - 0.01]) for (const db of [-T / 2 + 0.01, 0, T / 2 - 0.01]) {
        const P = [0, 0, 0]; P[ai] = j.a.pos + da; P[bi] = j.b.pos + db; P[ci] = cc;
        const qa = toPlane(pa, P), qb = toPlane(pb, P);
        // plate A's solid spans a.pos +/- T/2 along a, so its outline is evaluated at the b, c of P
        if (inLoops(qa[0], qa[1], pa.loops)) ina++;
        if (inLoops(qb[0], qb[1], pb.loops)) inb++;
        n++;
      }
      ok((ina === 0 || inb === 0), 'plates overlap at ' + cc + ' (' + pa.name + '/' + pb.name + ')');
      // on the crossing line itself exactly one plate has material: A below mid, B above
      const P0 = [0, 0, 0]; P0[ai] = j.a.pos; P0[bi] = j.b.pos; P0[ci] = cc;
      const q0a = toPlane(pa, P0), q0b = toPlane(pb, P0), hasA = inLoops(q0a[0], q0a[1], pa.loops), hasB = inLoops(q0b[0], q0b[1], pb.loops);
      ok(cc < j.mid ? (hasA && !hasB) : (hasB && !hasA), 'exactly one plate has material at c=' + cc.toFixed(2) + ' ' + pa.name + '/' + pb.name);
      ok(cc < j.mid ? inb === 0 : ina === 0, 'the slotted plate is clear across the whole neighbourhood');
      samples++;
    }
  }
  ok(samples > 100);
  return plan;
}

test('grid: sphere r=60 t=3, all three axis pairs: complementary slots, width, one piece per plate, no overlap in 3D', () => {
  const S = sphere(60, 48, 64);
  for (const axes of [['x', 'y'], ['x', 'z'], ['y', 'z'], ['y', 'x'], ['z', 'x']]) {
    const plan = gridChecks(S, { mode: 'grid', axes, thickness: 3 }, (pa, pb) => { const h = Math.sqrt(Math.max(0, 3600 - (pa - 60) * (pa - 60) - (pb - 60) * (pb - 60))); return [60 - h, 60 + h]; });
    ok(plan.pieces.length === 14, '7 + 7 plates, got ' + plan.pieces.length);          // spacing max(18, 15) = 18 over 114 usable
    const nPairs = 49;
    ok(plan.joints.length + plan.jointStats.skipped <= nPairs && plan.joints.length >= 37, 'joints ' + plan.joints.length);
    // each A plate keeps the lower half connected, so cut length rose and area fell versus the plain disc
    plan.pieces.forEach(p => ok(p.loops.length === 1, 'slots open into the outline, no closed windows'));
  }
});

test('grid: box, asymmetric tetra and custom spacing/clearance/allowance', () => {
  const b = gridChecks(box(200, 150, 80), { mode: 'grid', axes: ['x', 'y'], thickness: 4, spacing: 40, clearance: 0.5 }, () => [0, 80]);
  ok(b.pieces.filter(p => p.axis === 'x').length === 5 && b.pieces.filter(p => p.axis === 'y').length === 4, 'counts');
  ok(b.joints.length === 20);
  // X plate: 150 x 80 rectangle with 4 slots 4.5 wide x 40 deep
  near(b.pieces[0].area, 150 * 80 - 4 * 4.5 * 40, 1e-6); near(b.pieces[0].cutLength, 2 * (150 + 80) + 4 * 2 * 40, 1e-6);
  ok(b.pieces[0].name === 'X1' && b.pieces[5].name === 'Y1');
  gridChecks(tetra(), { mode: 'grid', axes: ['x', 'y'], thickness: 2, spacing: 14 });
  gridChecks(tetra(), { mode: 'grid', axes: ['z', 'x'], thickness: 2, spacing: 9 });
  const al = gridChecks(box(200, 150, 80), { mode: 'grid', axes: ['y', 'z'], thickness: 4, spacing: 30, allowance: 2 }, () => [-2, 202]);
  near(al.pieces[0].w, 204, 1e-6);
  // narrow model still gets two plates per family when they fit
  const nb = slicePlan(box(60, 30, 40), { mode: 'grid', axes: ['x', 'y'], thickness: 3 });
  ok(nb.pieces.filter(p => p.axis === 'y').length === 2 && nb.pieces.filter(p => p.axis === 'x').length >= 2, 'at least two plates');
});

test('grid: torus (several intervals per crossing), split/skip warnings, errors', () => {
  const t = slicePlan(torus(60, 15, 64, 24), { mode: 'grid', axes: ['x', 'y'], thickness: 3, spacing: 24 });
  checkLoopsSane(t);
  ok(t.pieces.some(p => /[a-z]$/.test(p.name)), 'torus plates through the hole come as two islands');
  ok(t.joints.length > 10);
  t.pieces.forEach(p => ok(isSimple(p.loops)));
  // too coarse: thick sheet on a small ball -> warnings in plain English, no crash
  const w = slicePlan(sphere(20, 16, 24), { mode: 'grid', axes: ['x', 'y'], thickness: 6, spacing: 13 });
  ok(Array.isArray(w.warnings));
  let threw = '';
  try { slicePlan(box(100, 100, 100), { mode: 'grid', axes: ['x', 'y'], thickness: 5, spacing: 6 }); } catch (e) { threw = e.message; }
  ok(/spacing/.test(threw), 'spacing error: ' + threw);
  threw = '';
  try { slicePlan(box(100, 100, 100), { mode: 'stack', axes: ['z'], thickness: 1, maxPieces: 50 }); } catch (e) { threw = e.message; }
  ok(/limit is 50/.test(threw), 'maxPieces error: ' + threw);
  threw = '';
  try { slicePlan(box(100, 100, 100), { mode: 'grid', axes: ['x', 'x'], thickness: 3 }); } catch (e) { threw = e.message; }
  ok(/two different directions/.test(threw));
});

test('stats: recomputed independently', () => {
  for (const plan of [slicePlan(torus(40, 12, 40, 16), { mode: 'stack', axes: ['x'], thickness: 4 }), slicePlan(sphere(60, 32, 48), { mode: 'grid', axes: ['x', 'z'], thickness: 3 }),
                      slicePlan(hollowBox(), { mode: 'stack', axes: ['z'], thickness: 4, allowance: 1 })]) {
    const st = plan.stats, P = plan.pieces;
    ok(st.count === P.length);
    let cut = 0, pierces = 0, area = 0, minS = Infinity, minP = '', minA = Infinity, maxW = 0, maxH = 0, maxLong = 0, maxShort = 0;
    for (const p of P) {
      const a = eoArea(p.loops), c = p.loops.reduce((s, l) => s + perim(l), 0);
      near(p.area, a, 1e-6, 'piece area'); near(p.cutLength, c, 1e-6, 'piece cut');
      cut += c; pierces += p.loops.length; area += a;
      const sh = Math.min(p.w, p.h), lg = Math.max(p.w, p.h);
      if (sh < minS) { minS = sh; minP = p.name; }
      minA = Math.min(minA, a); maxW = Math.max(maxW, p.w); maxH = Math.max(maxH, p.h); maxLong = Math.max(maxLong, lg); maxShort = Math.max(maxShort, sh);
    }
    near(st.cutLength, cut, 1e-6); ok(st.pierces === pierces); near(st.area, area, 1e-6); near(st.minSize, minS, 1e-9); ok(st.minPiece === minP);
    near(st.minArea, minA, 1e-6); near(st.maxW, maxW, 1e-9); near(st.maxH, maxH, 1e-9); near(st.maxLong, maxLong, 1e-9); near(st.maxShort, maxShort, 1e-9);
    near(st.pieceVolume, area * plan.thickness, 1e-5);
  }
});

test('scale: number and [sx,sy,sz]', () => {
  const p = slicePlan(box(10, 10, 10), { mode: 'stack', axes: ['z'], thickness: 5, scale: [10, 6, 3] });
  ok(p.pieces.length === 6); near(p.pieces[0].w, 100, 1e-6); near(p.pieces[0].h, 60, 1e-6); near(p.size[2], 30, 1e-6);
  const q = slicePlan(mk(boxTris(5, 5, 5, 15, 15, 15)), { mode: 'stack', axes: ['y'], thickness: 5, scale: 2 });
  ok(q.pieces.length === 4); near(q.pieces[0].origin[1], 0, 1e-9); near(q.pieces[0].origin[2], 20, 1e-9, 'y-frame origin sits at the top (v runs down z)');
});

test('bestPlans: flat wide box -> z stack; sorted; sphere gives six readable candidates; oversize penalised; prefer', () => {
  const flat = box(200, 150, 12), r = bestPlans(flat, { thickness: 3, bedW: 1250, bedH: 1250 });
  ok(r.length === 6);
  ok(r[0].mode === 'stack' && r[0].axes[0] === 'z' && r[0].stats.count === 4, 'best is ' + r[0].mode + ' ' + r[0].axes);
  for (let i = 1; i < r.length; i++) ok(r[i].score >= r[i - 1].score, 'sorted');
  r.forEach(c => ok(!('pieces' in c)));
  results.push('      flat box: ' + r.map(c => c.mode + ' ' + c.axes.join('') + ' [' + Math.round(c.score) + '] ' + c.reason).join('\n                '));
  const s = bestPlans(sphere(60, 48, 64), { thickness: 3, bedW: 600, bedH: 400 });
  ok(s.length === 6 && new Set(s.map(c => c.mode + c.axes.join(''))).size === 6);
  s.forEach(c => { ok(!c.error, c.error); ok(/^\d+ pieces, smallest [\d.]+ mm, about [\d.]+ m of cutting, fits on \d+ sheets?/.test(c.reason), c.reason); ok(c.sheets >= 1 && c.oversize === 0); });
  results.push('      sphere:   ' + s.map(c => c.mode + ' ' + c.axes.join('') + ' [' + Math.round(c.score) + '] ' + c.reason).join('\n                '));
  ok(bestPlans(sphere(60, 48, 64), { thickness: 3, bedW: 600, bedH: 400, prefer: 'solid' })[0].mode === 'stack');
  ok(bestPlans(sphere(60, 48, 64), { thickness: 3, bedW: 600, bedH: 400, prefer: 'frame' })[0].mode === 'grid');
  // bed too small for the 200 x 150 panels: z stack is oversize and must lose
  const small = bestPlans(flat, { thickness: 3, bedW: 180, bedH: 180 });
  const z = small.find(c => c.mode === 'stack' && c.axes[0] === 'z');
  ok(z.oversize === 4 && z.score > 1000 && /too big for the bed/.test(z.reason), z.reason);
  ok(small[0] !== z && small[0].oversize === 0, 'a candidate that fits wins: ' + small[0].mode + small[0].axes);
  // a candidate that throws goes last with error set
  const e = bestPlans(box(400, 20, 20), { thickness: 1, bedW: 1000, bedH: 1000, maxPieces: 100 });
  const last = e[e.length - 1];
  ok(last.error && !last.stats && last.mode === 'stack' && last.axes[0] === 'x', 'error candidate last');
  ok(!e[0].error);
});

test('concatenated classic script in a fresh vm context', () => {
  const src = ['boolops.js', 'slicer.js', 'slicer2.js'].map(f => fs.readFileSync(TOOLS + f, 'utf8')).join('\n');
  const ctx = vm.createContext({});
  vm.runInContext(src, ctx);
  ok(vm.runInContext('typeof slicePlan + typeof bestPlans + typeof polyBool + typeof sliceModel + typeof module', ctx) === 'functionfunctionfunctionfunctionundefined');
  ctx.tris = new Float32Array(boxTris(0, 0, 0, 100, 60, 30));
  const n = vm.runInContext('var p = slicePlan({tris: tris}, {mode:"grid", axes:["x","y"], thickness:3}); var q = slicePlan({tris: tris}, {mode:"stack", axes:["z"], thickness:3, allowance:1});' +
    'var b = bestPlans({tris: tris}, {thickness:3, bedW:500, bedH:500}); [p.pieces.length, q.pieces.length, b.length].join(",")', ctx);
  ok(/^\d+,10,6$/.test(n), n);
  // only s2-prefixed globals are added beyond the two exports
  const own = vm.runInContext('Object.keys(this).join(",")', ctx).split(',').filter(k => !/^(s2|sl[A-Z])/.test(k) && ['polyBool', 'parseModel', 'sliceModel', 'nestParts', 'slicePlan', 'bestPlans', 'tris', 'p', 'q', 'b'].indexOf(k) < 0);
  ok(own.length === 0, 'unexpected globals: ' + own);
  // also when a page already defined some of the clash-prone names
  const ctx2 = vm.createContext({});
  vm.runInContext('var area=1, inside=2, bbox=3, rdp=4, draw=5, store=6; function esc(){}\n' + src + '\n;var ok2 = slicePlan({tris: new Float32Array([0,0,0, 10,0,0, 0,10,0, 0,0,0, 0,10,0, 0,0,10, 0,0,0, 0,0,10, 10,0,0, 10,0,0, 0,0,10, 0,10,0])}, {thickness:2}).pieces.length', ctx2);
  ok(vm.runInContext('ok2 === 5 && area === 1 && draw === 5', ctx2));
});

test('performance: 50,000-triangle sphere', () => {
  const S = sphere(60, 158, 158);
  results.push('      triangles: ' + S.count);
  let t = Date.now();
  const st = slicePlan(S, { mode: 'stack', axes: ['z'], thickness: 2 });
  const tStack = Date.now() - t; t = Date.now();
  const st0 = slicePlan(S, { mode: 'stack', axes: ['z'], thickness: 2, envelope: false });
  const tStack0 = Date.now() - t; t = Date.now();
  const stA = slicePlan(S, { mode: 'stack', axes: ['z'], thickness: 2, allowance: 1 });
  const tStackA = Date.now() - t; t = Date.now();
  const gr = slicePlan(S, { mode: 'grid', axes: ['x', 'y'], thickness: 2, spacing: 12 });
  const tGrid = Date.now() - t; t = Date.now();
  const bp = bestPlans(S, { thickness: 2, bedW: 1250, bedH: 1250 });
  const tBest = Date.now() - t;
  results.push('      stack z, ' + st.pieces.length + ' layers, envelope on: ' + tStack + ' ms (envelope off: ' + tStack0 + ' ms, envelope + allowance 1: ' + tStackA + ' ms)');
  results.push('      grid xy, ' + gr.pieces.filter(p => p.axis === 'x').length + ' + ' + gr.pieces.filter(p => p.axis === 'y').length + ' plates, ' + gr.joints.length + ' joints: ' + tGrid + ' ms');
  results.push('      bestPlans (6 candidates): ' + tBest + ' ms; best = ' + bp[0].mode + ' ' + bp[0].axes.join('') + ': ' + bp[0].reason);
  ok(st.pieces.length === 60 && st0.pieces.length === 60 && stA.pieces.length === 60);
  ok(gr.pieces.filter(p => p.axis === 'x').length === 10);
  ok(tStack < 3000 && tGrid < 3000 && tBest < 6000, 'too slow');
  checkLoopsSane(st); checkLoopsSane(gr);
});

console.log(results.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
