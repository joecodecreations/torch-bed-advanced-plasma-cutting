'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = path.join(__dirname, '..', 'jog', 'tools', 'slicer.js');
const { parseModel, sliceModel, nestParts } = require(SRC);
const DIR = path.join(__dirname, 'fixtures');
fs.mkdirSync(DIR, { recursive: true });
let pass = 0, fail = 0;
const results = [];
function test(name, fn) {
  const t0 = process.hrtime.bigint();
  try { const extra = fn(); const ms = Number(process.hrtime.bigint() - t0) / 1e6; pass++; results.push('PASS ' + name + ' (' + ms.toFixed(0) + ' ms)' + (extra ? ' -- ' + extra : '')); }
  catch (e) { fail++; results.push('FAIL ' + name + ': ' + (e && e.stack || e)); }
}
function ok(c, msg) { if (!c) throw new Error('assert: ' + msg); }
function near(a, b, tol, msg) { if (!(Math.abs(a - b) <= tol)) throw new Error('assert: ' + msg + ' got ' + a + ' want ' + b + ' +-' + tol); }
function rel(a, b, frac, msg) { if (!(Math.abs(a - b) <= frac * Math.abs(b))) throw new Error('assert: ' + msg + ' got ' + a + ' want ' + b + ' (' + (100 * (a - b) / b).toFixed(2) + '%)'); }
function throws(fn, re, msg) { let e = null; try { fn(); } catch (x) { e = x; } ok(e, msg + ' should throw'); if (re) ok(re.test(e.message), msg + ' message: ' + e.message); return e.message; }

// ---------- mesh builders: tris as flat arrays of 9 ----------
function boxTris(x0, y0, z0, x1, y1, z1, invert) {
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const out = [];
  for (const q of quads) for (const t of [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]) {
    const tt = invert ? [t[0], t[2], t[1]] : t;
    for (const i of tt) out.push(v[i][0], v[i][1], v[i][2]);
  }
  return { tris: out, verts: v, quads };
}
function gridMesh(nu, nv, fn, closeU, closeV) { // parametric surface, returns tris
  const out = [];
  const P = (i, j) => fn(i / nu, j / nv);
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
    const push = (p, q, r) => { if (same(p, q) || same(q, r) || same(p, r)) return; out.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]); };
    push(a, b, c); push(a, c, d);
  }
  return out;
}
function same(p, q) { return p[0] === q[0] && p[1] === q[1] && p[2] === q[2]; }
function sphereTris(r, segs, rings, c) {
  c = c || [0, 0, 0];
  // exact vertices via index tables so shared vertices are bit-identical
  const pt = [];
  for (let j = 0; j <= rings; j++) { pt.push([]); const th = Math.PI * j / rings;
    for (let i = 0; i < segs; i++) { const ph = 2 * Math.PI * i / segs;
      pt[j].push(j === 0 ? [c[0], c[1], c[2] + r] : j === rings ? [c[0], c[1], c[2] - r] :
        [c[0] + r * Math.sin(th) * Math.cos(ph), c[1] + r * Math.sin(th) * Math.sin(ph), c[2] + r * Math.cos(th)]); } }
  const out = [];
  const push = (p, q, s) => { if (same(p, q) || same(q, s) || same(p, s)) return; out.push(p[0], p[1], p[2], q[0], q[1], q[2], s[0], s[1], s[2]); };
  for (let j = 0; j < rings; j++) for (let i = 0; i < segs; i++) { const i2 = (i + 1) % segs;
    push(pt[j][i], pt[j + 1][i], pt[j + 1][i2]); push(pt[j][i], pt[j + 1][i2], pt[j][i2]); }
  return out;
}
function torusTris(R, r, nu, nv) {
  const pt = [];
  for (let i = 0; i < nu; i++) { pt.push([]); const a = 2 * Math.PI * i / nu;
    for (let j = 0; j < nv; j++) { const b = 2 * Math.PI * j / nv;
      pt[i].push([(R + r * Math.cos(b)) * Math.cos(a), (R + r * Math.cos(b)) * Math.sin(a), r * Math.sin(b)]); } }
  const out = [];
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) { const i2 = (i + 1) % nu, j2 = (j + 1) % nv;
    for (const t of [[pt[i][j], pt[i2][j], pt[i2][j2]], [pt[i][j], pt[i2][j2], pt[i][j2]]]) for (const p of t) out.push(p[0], p[1], p[2]); }
  return out;
}
function prismTris(poly, z0, z1, map) { // poly CCW [x,y]; map(a,b,h)->[x,y,z]
  map = map || ((a, b, h) => [a, b, h]);
  const out = [], n = poly.length;
  const push = (...ps) => { for (const p of ps) out.push(p[0], p[1], p[2]); };
  // caps via ear-free fan only valid for star-shaped from vertex 0; use simple ear clipping
  const idx = poly.map((_, i) => i); const tris = [];
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const inTri = (p, a, b, c) => cross(a, b, p) > 0 && cross(b, c, p) > 0 && cross(c, a, p) > 0;
  let guard = 0;
  while (idx.length > 3 && guard++ < 1000) {
    for (let k = 0; k < idx.length; k++) {
      const a = poly[idx[(k + idx.length - 1) % idx.length]], b = poly[idx[k]], c = poly[idx[(k + 1) % idx.length]];
      if (cross(a, b, c) <= 0) continue;
      let clear = true;
      for (const m of idx) { const p = poly[m]; if (p === a || p === b || p === c) continue; if (inTri(p, a, b, c)) { clear = false; break; } }
      if (!clear) continue;
      tris.push([a, b, c]); idx.splice(k, 1); break;
    }
  }
  tris.push([poly[idx[0]], poly[idx[1]], poly[idx[2]]]);
  for (const [a, b, c] of tris) { push(map(a[0], a[1], z1), map(b[0], b[1], z1), map(c[0], c[1], z1)); push(map(a[0], a[1], z0), map(c[0], c[1], z0), map(b[0], b[1], z0)); }
  for (let i = 0; i < n; i++) { const a = poly[i], b = poly[(i + 1) % n];
    push(map(a[0], a[1], z0), map(b[0], b[1], z0), map(b[0], b[1], z1)); push(map(a[0], a[1], z0), map(b[0], b[1], z1), map(a[0], a[1], z1)); }
  return out;
}
function modelOf(tris) {
  const a = Float32Array.from(tris); const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < a.length; i++) { const k = i % 3; if (a[i] < min[k]) min[k] = a[i]; if (a[i] > max[k]) max[k] = a[i]; }
  return { tris: a, count: a.length / 9, min, max, format: 'test', warnings: [] };
}
// ---------- file writers ----------
function writeBinStl(file, tris, header) {
  const n = tris.length / 9, buf = Buffer.alloc(84 + 50 * n);
  buf.write(header || 'binary stl test', 0, 'ascii'); buf.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) buf.writeFloatLE(tris[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(file, buf);
}
function writeAsciiStl(file, tris) {
  const L = ['solid test'];
  for (let t = 0; t < tris.length; t += 9) { L.push(' facet normal 0 0 0', '  outer loop');
    for (let k = 0; k < 9; k += 3) L.push('   vertex ' + tris[t + k].toExponential(6) + ' ' + tris[t + k + 1] + ' ' + tris[t + k + 2]);
    L.push('  endloop', ' endfacet'); }
  L.push('endsolid test'); fs.writeFileSync(file, L.join('\r\n'));
}
function writeObjQuads(file, box, style) {
  const L = ['# test obj', 'mtllib nothing.mtl', 'o box'];
  for (const v of box.verts) L.push('v ' + v.join(' '));
  L.push('vt 0 0', 'vn 0 0 1', 'g faces', 'usemtl m', 's off');
  box.quads.forEach((q, qi) => {
    const f = q.map(i => { const st = style === 'mix' ? qi % 5 : 0;
      if (st === 0) return String(i + 1); if (st === 1) return (i + 1) + '/1'; if (st === 2) return (i + 1) + '/1/1';
      if (st === 3) return (i + 1) + '//1'; return String(i - 8); });
    L.push('f ' + f.join(' '));
  });
  L.push('l 1 2', 'p 1'); fs.writeFileSync(file, L.join('\n') + '\n');
}
function load(file) { const b = fs.readFileSync(file); return parseModel(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), path.basename(file)); }

// ---------- generic loop validity ----------
function checkLoops(res) {
  let nl = 0;
  for (const L of res.layers) {
    ok(Number.isInteger(L.index) && isFinite(L.height) && isFinite(L.area), 'layer numbers');
    ok(L.min.concat(L.max).every(isFinite), 'layer bbox finite');
    for (const set of [L.loops, L.open]) for (const lp of set) {
      const closed = set === L.loops; nl++;
      ok(lp.length >= (closed ? 3 : 2), 'loop has too few points: ' + lp.length);
      for (let i = 0; i < lp.length; i++) {
        ok(lp[i].length === 2 && isFinite(lp[i][0]) && isFinite(lp[i][1]), 'finite point');
        const j = (i + 1) % lp.length; if (!closed && j === 0) continue;
        ok(!(lp[i][0] === lp[j][0] && lp[i][1] === lp[j][1]), 'repeated consecutive point');
      }
    }
  }
  return nl;
}
function loopBox(lp) { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const p of lp) { a = Math.min(a, p[0]); b = Math.min(b, p[1]); c = Math.max(c, p[0]); d = Math.max(d, p[1]); } return [a, b, c, d]; }
function absArea(lp) { let s = 0; for (let i = 0, j = lp.length - 1; i < lp.length; j = i++) s += lp[j][0] * lp[i][1] - lp[i][0] * lp[j][1]; return Math.abs(s / 2); }
function signedArea(lp) { let s = 0; for (let i = 0, j = lp.length - 1; i < lp.length; j = i++) s += lp[j][0] * lp[i][1] - lp[i][0] * lp[j][1]; return s / 2; }

// ================= parser tests =================
const cube = boxTris(0, 0, 0, 1, 1, 1), box = boxTris(-10, 5, 2, 90, 65, 42); // 100x60x40, off-origin
for (const [nm, b, mn, mx] of [['cube', cube, [0, 0, 0], [1, 1, 1]], ['box', box, [-10, 5, 2], [90, 65, 42]]]) {
  test('parse ' + nm + ': binary STL / ASCII STL / OBJ agree', () => {
    writeBinStl(path.join(DIR, nm + '_bin.stl'), b.tris);
    writeBinStl(path.join(DIR, nm + '_solid_bin.stl'), b.tris, 'solid looks like ascii but is binary');
    writeAsciiStl(path.join(DIR, nm + '_ascii.stl'), b.tris);
    writeObjQuads(path.join(DIR, nm + '.obj'), b, 'plain');
    writeObjQuads(path.join(DIR, nm + '_mix.obj'), b, 'mix');
    const exp = { '_bin.stl': 'stl-binary', '_solid_bin.stl': 'stl-binary', '_ascii.stl': 'stl-ascii', '.obj': 'obj', '_mix.obj': 'obj' };
    for (const suf in exp) {
      const m = load(path.join(DIR, nm + suf));
      ok(m.format === exp[suf], suf + ' format ' + m.format);
      ok(m.count === 12 && m.tris.length === 108 && m.tris instanceof Float32Array, suf + ' count ' + m.count);
      for (let k = 0; k < 3; k++) { near(m.min[k], mn[k], 1e-6, suf + ' min'); near(m.max[k], mx[k], 1e-6, suf + ' max'); }
      ok(Array.isArray(m.warnings) && m.warnings.length === 0, suf + ' warnings ' + m.warnings);
      // same triangles, same order as the generator
      for (let i = 0; i < 108; i++) near(m.tris[i], b.tris[i], 1e-5, suf + ' tri data');
    }
  });
}
test('parse: sniffing without extension, Buffer/Uint8Array input', () => {
  for (const [f, fmt] of [['box_bin.stl', 'stl-binary'], ['box_ascii.stl', 'stl-ascii'], ['box.obj', 'obj']]) {
    const b = fs.readFileSync(path.join(DIR, f));
    ok(parseModel(b, 'model').format === fmt, 'sniff ' + f);         // Node Buffer with byteOffset
    ok(parseModel(new Uint8Array(b), '').count === 12, 'u8 ' + f);
  }
});
test('parse: errors are plain English', () => {
  const msgs = [];
  msgs.push(throws(() => parseModel(new ArrayBuffer(0), 'a.stl'), /empty/i, 'empty'));
  msgs.push(throws(() => parseModel(null, 'a.stl'), /read/i, 'null'));
  msgs.push(throws(() => parseModel(Buffer.from('hello world this is not a model'), 'a.step'), /not supported.*STL or OBJ/i, 'step'));
  msgs.push(throws(() => parseModel(Buffer.from('PK\u0003\u0004 zipzip'), 'a'), /STL or OBJ/i, 'unknown'));
  msgs.push(throws(() => parseModel(Buffer.from('solid x\nendsolid x\n'), 'a.stl'), /No triangles/i, 'empty ascii'));
  msgs.push(throws(() => parseModel(Buffer.from('# just a comment\nv 0 0 0\n'), 'a.obj'), /No triangles/i, 'empty obj'));
  msgs.push(throws(() => parseModel(Buffer.from('tiny'), 'a.stl'), /./, 'tiny stl'));
  const cut = fs.readFileSync(path.join(DIR, 'box_bin.stl')).subarray(0, 84 + 50 * 7 + 13);
  const m = parseModel(cut, 'cut.stl'); ok(m.count === 7 && m.warnings.length === 1, 'truncated binary -> 7 tris + warning');
  const obj = parseModel(Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\nf 1 2 9\n'), 'x.obj'); ok(obj.count === 1 && obj.warnings.length === 1, 'bad face skipped');
});
test('parse: 500,000-triangle binary STL and OBJ', () => {
  const tris = sphereTris(50, 500, 501); // 500,000 tris
  writeBinStl(path.join(DIR, 'big.stl'), tris);
  let t0 = Date.now(); const m = load(path.join(DIR, 'big.stl')); const tb = Date.now() - t0;
  ok(m.count === tris.length / 9, 'count'); near(m.max[2], 50, 1e-4, 'max z');
  // OBJ with 500k triangle faces (unshared verts)
  const L = []; for (let i = 0; i < tris.length; i += 3) L.push('v ' + tris[i] + ' ' + tris[i + 1] + ' ' + tris[i + 2]);
  for (let i = 0; i < tris.length / 9; i++) L.push('f ' + (3 * i + 1) + ' ' + (3 * i + 2) + ' ' + (3 * i + 3));
  fs.writeFileSync(path.join(DIR, 'big.obj'), L.join('\n'));
  t0 = Date.now(); const o = load(path.join(DIR, 'big.obj')); const to = Date.now() - t0;
  ok(o.count === m.count, 'obj count');
  writeAsciiStl(path.join(DIR, 'big_ascii.stl'), tris);
  t0 = Date.now(); const a = load(path.join(DIR, 'big_ascii.stl')); const ta = Date.now() - t0;
  ok(a.count === m.count && a.format === 'stl-ascii', 'ascii count');
  for (const f of ['big.stl', 'big.obj', 'big_ascii.stl']) fs.unlinkSync(path.join(DIR, f));
  return m.count + ' tris: binary ' + tb + ' ms, OBJ ' + to + ' ms, ASCII STL ' + ta + ' ms';
});

// ================= slicing tests =================
const boxModel = load(path.join(DIR, 'box_bin.stl'));
for (const [axis, n, w, h] of [['z', 10, 100, 60], ['x', 25, 60, 40], ['y', 15, 100, 40]]) {
  test('slice box along ' + axis + ' thickness 4 -> ' + n + ' layers of ' + w + 'x' + h, () => {
    const r = sliceModel(boxModel, { axis, thickness: 4 });
    ok(r.count === n && r.layers.length === n, 'layers ' + r.layers.length);
    ok(r.thickness === 4 && r.stackHeight === n * 4, 'stackHeight');
    near(r.size[0], w, 1e-9, 'size w'); near(r.size[1], h, 1e-9, 'size d'); near(r.size[2], n * 4, 1e-9, 'size h');
    ok(r.warnings.length === 0, 'warnings ' + r.warnings);
    r.layers.forEach((L, i) => {
      ok(L.index === i, 'index'); near(L.height, (i + 0.5) * 4, 1e-9, 'height');
      ok(L.loops.length === 1 && L.open.length === 0, 'one loop'); ok(L.loops[0].length === 4, '4 points, got ' + L.loops[0].length);
      near(L.area, w * h, 1e-6, 'area'); const b = loopBox(L.loops[0]);
      near(b[0], 0, 1e-9, 'min u'); near(b[1], 0, 1e-9, 'min v'); near(b[2], w, 1e-9, 'max u'); near(b[3], h, 1e-9, 'max v');
      near(L.min[0], 0, 1e-9, 'L.min'); near(L.max[0], w, 1e-9, 'L.max u'); near(L.max[1], h, 1e-9, 'L.max v');
    });
    checkLoops(r);
  });
}
test('handedness: L-shaped prism comes out un-mirrored on z, x and y', () => {
  // L in the plane: long arm along +a (30), short arm along +b (20), 10 wide. CCW.
  const Lp = [[0, 0], [30, 0], [30, 10], [10, 10], [10, 20], [0, 20]];
  const has = (lp, u, v) => lp.some(p => Math.abs(p[0] - u) < 1e-6 && Math.abs(p[1] - v) < 1e-6);
  // z: (a,b,h)->(x,y,z).   x: (y,z,x).   y: proper rotation is (u,v)=(x, D - z).
  const cases = { z: [(a, b, h) => [a, b, h], Lp], x: [(a, b, h) => [h, a, b], Lp], y: [(a, b, h) => [a, h, b], Lp.map(p => [p[0], 20 - p[1]])] };
  for (const axis in cases) {
    const m = modelOf(prismTris(Lp, 0, 8, cases[axis][0]));
    const r = sliceModel(m, { axis, thickness: 4 });
    ok(r.layers.length === 2, axis + ' layers'); const lp = r.layers[0].loops[0];
    ok(r.layers[0].loops.length === 1 && lp.length === 6, axis + ' 6-point L, got ' + lp.length);
    near(r.layers[0].area, 400, 1e-6, axis + ' area');
    for (const p of cases[axis][1]) ok(has(lp, p[0], p[1]), axis + ' missing corner ' + p + ' in ' + JSON.stringify(lp));
  }
});
test('handedness: chiral tripod keeps its handedness on every axis (det = +1)', () => {
  // legs from the corner: 30 along +x, 20 along +y, 10 along +z, each 5x5 in section
  const tris = [].concat(boxTris(0, 0, 0, 30, 5, 5).tris, boxTris(0, 0, 0, 5, 20, 5).tris, boxTris(0, 0, 0, 5, 5, 10).tris);
  const m = modelOf(tris);
  for (const axis of ['x', 'y', 'z']) {
    const r = sliceModel(m, { axis, thickness: 5 });
    const bot = r.layers[0], top = r.layers[r.layers.length - 1];
    const cu = (top.min[0] + top.max[0]) / 2, cv = (top.min[1] + top.max[1]) / 2;       // the corner post
    ok(top.max[0] - top.min[0] < 5.001 && top.max[1] - top.min[1] < 5.001, axis + ' top is the post');
    const du = (bot.max[0] - cu) > (cu - bot.min[0]) ? 1 : -1, dv = (bot.max[1] - cv) > (cv - bot.min[1]) ? 1 : -1;
    const lenU = bot.max[0] - bot.min[0], lenV = bot.max[1] - bot.min[1], lenH = r.size[2];
    const vec = {}; vec[lenU] = [du, 0, 0]; vec[lenV] = [0, dv, 0]; vec[lenH] = [0, 0, 1];
    const X = vec[30], Y = vec[20], Z = vec[10]; ok(X && Y && Z, axis + ' legs found ' + [lenU, lenV, lenH]);
    const det = X[0] * (Y[1] * Z[2] - Y[2] * Z[1]) - X[1] * (Y[0] * Z[2] - Y[2] * Z[0]) + X[2] * (Y[0] * Z[1] - Y[1] * Z[0]);
    ok(det === 1, axis + ' mirrored! det=' + det);
  }
});
test('sphere r=50 (~4,900 tris) thickness 5 -> 20 layers, areas within 2%', () => {
  const tris = sphereTris(50, 50, 50, [7, -3, 11]); const m = modelOf(tris);
  const r = sliceModel(m, { thickness: 5 }); let worst = 0;
  ok(r.layers.length === 20 && r.count === 20, 'layers ' + r.layers.length);
  for (const L of r.layers) { const d = L.height - 50, want = Math.PI * (2500 - d * d);
    ok(L.loops.length === 1 && L.open.length === 0, 'one loop'); rel(L.area, want, 0.02, 'area layer ' + L.index);
    worst = Math.max(worst, Math.abs(L.area - want) / want); }
  ok(r.warnings.length === 0, 'warnings ' + r.warnings); checkLoops(r);
  return m.count + ' tris, worst area error ' + (worst * 100).toFixed(2) + '%';
});
const torus = modelOf(torusTris(40, 12, 96, 48));
test('torus along its axis: outer + hole, area within 3%', () => {
  const r = sliceModel(torus, { axis: 'z', thickness: 2 }); ok(r.layers.length === 12, 'layers ' + r.layers.length); let worst = 0;
  for (const L of r.layers) { ok(L.loops.length === 2 && L.open.length === 0, 'two loops on layer ' + L.index + ': ' + L.loops.length);
    const d = L.height - 12, a = Math.sqrt(144 - d * d), want = 4 * Math.PI * 40 * a;
    if (L.index >= 3 && L.index <= 8) { rel(L.area, want, 0.03, 'area layer ' + L.index); worst = Math.max(worst, Math.abs(L.area - want) / want); }
    const A = L.loops.map(absArea).sort((p, q) => q - p); near(L.area, A[0] - A[1], 1e-6, 'even-odd = outer - hole'); }
  checkLoops(r); return 'worst middle-layer error ' + (worst * 100).toFixed(2) + '%';
});
test('torus across its axis: separate islands in the middle, one loop near the ends', () => {
  const r = sliceModel(torus, { axis: 'x', thickness: 4 }); ok(r.layers.length === 26, 'layers ' + r.layers.length);
  let islands = 0, single = 0;
  for (const L of r.layers) { ok(L.open.length === 0, 'closed');
    if (L.loops.length === 2) { const a = loopBox(L.loops[0]), b = loopBox(L.loops[1]);
      const apart = a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1];
      if (apart) { islands++; near(L.area, absArea(L.loops[0]) + absArea(L.loops[1]), 1e-6, 'islands add'); } }
    else if (L.loops.length === 1) single++; }
  ok(islands >= 10 && single >= 4, 'islands ' + islands + ' single ' + single); checkLoops(r);
  return islands + ' layers with 2 islands, ' + single + ' with 1 loop';
});
test('hollow box: 2 loops through the cavity', () => {
  const m = modelOf([].concat(boxTris(0, 0, 0, 50, 40, 30).tris, boxTris(10, 10, 10, 40, 30, 20, true).tris));
  const r = sliceModel(m, { thickness: 2 }); ok(r.layers.length === 15, 'layers');
  for (const L of r.layers) { const inCav = L.height > 10 && L.height < 20;
    ok(L.loops.length === (inCav ? 2 : 1), 'loops at h=' + L.height + ': ' + L.loops.length);
    near(L.area, inCav ? 2000 - 600 : 2000, 1e-6, 'area'); }
  checkLoops(r);
});
test('scale as number and as [sx,sy,sz]; defaults; validation; maxLayers', () => {
  const cubeM = load(path.join(DIR, 'cube_bin.stl'));
  let r = sliceModel(cubeM, { thickness: 5, scale: 25.4 }); ok(r.layers.length === 5, 'inch cube layers'); near(r.layers[0].area, 25.4 * 25.4, 1e-6, 'area');
  near(r.size[0], 25.4, 1e-9, 'size'); ok(r.warnings.length === 1 && /25 mm tall/.test(r.warnings[0]), 'stack height note: ' + r.warnings);
  r = sliceModel(cubeM, { thickness: 2, scale: [30, 20, 10] }); ok(r.layers.length === 5, 'xyz scale layers'); near(r.layers[2].area, 600, 1e-6, 'area 30x20');
  r = sliceModel(cubeM, { thickness: 2, scale: [30, 20, 10], axis: 'x' }); ok(r.layers.length === 15, 'x layers'); near(r.layers[2].area, 200, 1e-6, 'area 20x10');
  r = sliceModel(cubeM, { thickness: 3 }); ok(r.count === 1 && r.layers.length === 1 && r.layers[0].height === 0.5, 'min one layer');
  const msg = throws(() => sliceModel(boxModel, { thickness: 0.01 }), /thicker material/i, 'maxLayers default');
  ok(/4000 layers/.test(msg) && /smaller/.test(msg), msg);
  throws(() => sliceModel(boxModel, { thickness: 4, maxLayers: 5 }), /limit is 5/, 'maxLayers custom');
  ok(sliceModel(boxModel, { thickness: 4, maxLayers: 10 }).count === 10, 'at the limit is fine');
  throws(() => sliceModel(boxModel, {}), /thickness/i, 'no thickness');
  throws(() => sliceModel(boxModel, { thickness: 4, axis: 'q' }), /X, Y or Z/, 'bad axis');
  throws(() => sliceModel(boxModel, { thickness: 4, scale: 0 }), /scale/i, 'zero scale');
  throws(() => sliceModel(null, { thickness: 4 }), /Import/i, 'no model');
  throws(() => sliceModel(modelOf([0, 0, 0, 1, 0, 0, 0, 1, 0]), { thickness: 1 }), /flat/i, 'flat');
  return msg;
});
test('empty layers are omitted but keep their true index', () => {
  const m = modelOf([].concat(boxTris(0, 0, 0, 10, 10, 10).tris, boxTris(0, 0, 30, 10, 10, 40).tris));
  const r = sliceModel(m, { thickness: 5 }); ok(r.count === 8, 'count');
  ok(r.layers.map(L => L.index).join() === '0,1,6,7', 'indices ' + r.layers.map(L => L.index)); near(r.layers[2].height, 32.5, 1e-9, 'height');
});
test('vertices exactly on the slicing plane; touching shapes; tolerance 0', () => {
  // octahedron-ish double pyramid with its equator exactly on a plane (height 20, thickness 20/3 puts no plane there; use 4 layers -> plane at 5,10(no)...)
  const apexUp = [5, 5, 10], apexDn = [5, 5, 0], q = [[0, 0, 5], [10, 0, 5], [10, 10, 5], [0, 10, 5]]; const t = [];
  for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; t.push(...a, ...b, ...apexUp, ...b, ...a, ...apexDn); }
  let r = sliceModel(modelOf(t), { thickness: 10 / 3 }); // 3 layers: planes at 1.667, 5 (the equator, exactly on vertices), 8.333
  ok(r.layers.length === 3, 'layers'); near(r.layers[1].area, 100, 1e-6, 'equator area'); ok(r.layers[1].loops[0].length === 4 && r.layers[1].open.length === 0, 'equator loop');
  near(r.layers[0].area, (10 / 3) * (10 / 3), 1e-6, 'lower'); checkLoops(r);
  // two boxes sharing only an edge: must give two loops, not a figure-eight
  r = sliceModel(modelOf([].concat(boxTris(0, 0, 0, 10, 10, 10).tris, boxTris(10, 10, 0, 20, 20, 10).tris)), { thickness: 5, tolerance: 0 });
  for (const L of r.layers) { ok(L.loops.length === 2 && L.loops.every(l => l.length === 4), 'two squares: ' + JSON.stringify(L.loops)); near(L.area, 200, 1e-6, 'area'); }
  checkLoops(r);
});
test('non-watertight mesh (one triangle deleted): no crash, one warning, other layers fine', () => {
  const tris = sphereTris(50, 50, 50); const cut = tris.slice(0, 9 * 2355).concat(tris.slice(9 * 2356)); // drop one triangle
  const r = sliceModel(modelOf(cut), { thickness: 5 });
  ok(r.warnings.length === 1 && /watertight/.test(r.warnings[0]), 'warning: ' + r.warnings);
  let gaps = 0, good = 0;
  for (const L of r.layers) { if (L.open.length) { gaps++; continue; } const d = L.height - 50; ok(L.loops.length === 1, 'loop'); rel(L.area, Math.PI * (2500 - d * d), 0.02, 'area'); good++; }
  ok(gaps === 1 && good === 19 && r.layers.length === 20, 'gaps ' + gaps + ' good ' + good); checkLoops(r);
  return r.warnings[0];
});
let perfMs = 0;
test('performance: ~200,000-triangle sphere into 200 layers', () => {
  const m = modelOf(sphereTris(50, 317, 317)); const t0 = process.hrtime.bigint();
  const r = sliceModel(m, { thickness: 0.5 }); perfMs = Number(process.hrtime.bigint() - t0) / 1e6;
  ok(r.layers.length === 200, 'layers ' + r.layers.length);
  for (const L of r.layers) { const d = L.height - 50; ok(L.loops.length === 1 && L.open.length === 0, 'loop'); rel(L.area, Math.PI * (2500 - d * d), 0.02, 'area ' + L.index); }
  const nl = checkLoops(r); ok(perfMs < 5000, 'too slow: ' + perfMs);
  const t1 = process.hrtime.bigint(); const r2 = sliceModel(m, { thickness: 0.5, axis: 'x' }); const ms2 = Number(process.hrtime.bigint() - t1) / 1e6;
  ok(r2.layers.length === 200, 'x layers');
  return m.count + ' tris x 200 layers: ' + perfMs.toFixed(0) + ' ms along z, ' + ms2.toFixed(0) + ' ms along x (' + nl + ' loops)';
});
test('performance: 200,000 tris all crossing one plane (single dense layer)', () => {
  const m = modelOf(sphereTris(50, 317, 317)); const t0 = Date.now();
  const r = sliceModel(m, { thickness: 100, axis: 'y' }); ok(r.layers.length === 1 && r.layers[0].loops.length === 1, 'one loop'); rel(r.layers[0].area, Math.PI * 2500, 0.01, 'area');
  return (Date.now() - t0) + ' ms';
});

// ================= nesting tests =================
function checkNest(parts, res, o) {
  const gap = o.gap == null ? 5 : o.gap, margin = o.margin == null ? 5 : o.margin, E = 1e-6; const byId = new Map(parts.map(p => [p.id, p])); const seen = new Set();
  for (const pg of res.pages) { ok(pg.items.length > 0, 'empty page');
    for (const it of pg.items) { ok(!seen.has(it.id), 'placed twice ' + it.id); seen.add(it.id); const p = byId.get(it.id);
      ok(it.rot === 0 || it.rot === 90, 'rot'); ok(it.rot === 0 || o.rotate !== false, 'rotated when not allowed');
      near(it.w, it.rot ? p.h : p.w, 1e-9, 'w'); near(it.h, it.rot ? p.w : p.h, 1e-9, 'h');
      ok(it.x >= margin - E && it.y >= margin - E && it.x + it.w <= o.bedW - margin + E && it.y + it.h <= o.bedH - margin + E, 'outside margin: ' + JSON.stringify(it)); }
    for (let i = 0; i < pg.items.length; i++) for (let j = i + 1; j < pg.items.length; j++) { const a = pg.items[i], b = pg.items[j];
      const sep = a.x + a.w + gap <= b.x + E || b.x + b.w + gap <= a.x + E || a.y + a.h + gap <= b.y + E || b.y + b.h + gap <= a.y + E;
      ok(sep, 'overlap/gap violated: ' + JSON.stringify(a) + ' ' + JSON.stringify(b)); } }
  return seen;
}
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
test('nest: 30 mixed rectangles on a 338x340 bed', () => {
  const parts = []; for (let i = 0; i < 30; i++) parts.push({ id: 'p' + i, w: Math.round(20 + rnd() * 130), h: Math.round(15 + rnd() * 100) });
  parts[7].w = parts[3].w; parts[7].h = parts[3].h; // equal sizes
  const o = { bedW: 338, bedH: 340 }; const r = nestParts(parts, o); const seen = checkNest(parts, r, o);
  ok(seen.size === 30 && r.oversize.length === 0 && r.leftover.length === 0, 'all placed'); ok(JSON.stringify(nestParts(parts, o)) === JSON.stringify(r), 'deterministic');
  const area = parts.reduce((s, p) => s + (p.w + 5) * (p.h + 5), 0), lower = Math.ceil(area / (333 * 335));
  ok(r.pages.length >= lower && r.pages.length <= lower + 1, 'pages ' + r.pages.length + ' vs lower bound ' + lower);
  for (const g of [0, 12]) for (const mg of [0, 9]) for (const rot of [true, false]) { const o2 = { bedW: 338, bedH: 340, gap: g, margin: mg, rotate: rot }; const r2 = nestParts(parts, o2); ok(checkNest(parts, r2, o2).size === 30, 'variant'); }
  const fill = parts.reduce((s, p) => s + p.w * p.h, 0) / (r.pages.length * 338 * 340);
  return r.pages.length + ' pages (area lower bound ' + lower + '), ' + (fill * 100).toFixed(0) + '% of sheet area used';
});
test('nest: 300 random parts stress, several seeds', () => {
  const t0 = Date.now(); let pages = 0;
  for (let s = 0; s < 5; s++) { const parts = []; for (let i = 0; i < 300; i++) parts.push({ id: i, w: 5 + rnd() * 120, h: 5 + rnd() * 90 });
    const o = { bedW: 338, bedH: 340, gap: 3, margin: 4 }; const r = nestParts(parts, o); ok(checkNest(parts, r, o).size === 300, 'all placed'); pages += r.pages.length; }
  return pages + ' pages total, ' + (Date.now() - t0) + ' ms for 5 runs';
});
test('nest: oversize reported, rotation used when it helps, rotate:false respected', () => {
  let parts = [{ id: 'a', w: 100, h: 50 }, { id: 'huge', w: 400, h: 400 }, { id: 'long', w: 500, h: 10 }, { id: 'b', w: 50, h: 50 }];
  let o = { bedW: 338, bedH: 340 }, r = nestParts(parts, o); ok(r.oversize.join() === 'huge,long' && r.pages.length === 1 && r.pages[0].items.length === 2, 'oversize ' + r.oversize);
  ok(r.warnings.length === 1 && /too big/.test(r.warnings[0]), 'warning'); checkNest(parts, r, o);
  parts = [1, 2, 3].map(i => ({ id: i, w: 300, h: 40 })); o = { bedW: 60, bedH: 320 }; r = nestParts(parts, o);
  ok(r.oversize.length === 0 && r.pages.length === 3 && r.pages.every(p => p.items[0].rot === 90 && p.items[0].w === 40 && p.items[0].h === 300), 'rotated: ' + JSON.stringify(r)); checkNest(parts, r, o);
  r = nestParts(parts, { bedW: 60, bedH: 320, rotate: false }); ok(r.oversize.length === 3 && r.pages.length === 0, 'no rotation -> oversize');
  // exact fit with margin, and part fitting only without rotation
  r = nestParts([{ id: 1, w: 328, h: 330 }], { bedW: 338, bedH: 340 }); ok(r.pages.length === 1 && r.pages[0].items[0].x === 5 && r.pages[0].items[0].rot === 0, 'exact fit');
  // two 160-wide parts + gap 5 need 325 <= 328: side by side on one page
  r = nestParts([{ id: 1, w: 160, h: 330 }, { id: 2, w: 160, h: 330 }], { bedW: 338, bedH: 340 }); ok(r.pages.length === 1, 'two side by side');
  r = nestParts([{ id: 1, w: 163, h: 330 }, { id: 2, w: 163, h: 330 }], { bedW: 338, bedH: 340 }); ok(r.pages.length === 2, 'gap forces two pages');
  r = nestParts([], { bedW: 338, bedH: 340 }); ok(r.pages.length === 0 && r.oversize.length === 0, 'empty');
  throws(() => nestParts([{ id: 1, w: 1, h: 1 }], { bedW: 8, bedH: 100 }), /margin/i, 'margin eats bed'); throws(() => nestParts([], {}), /bed size/i, 'no bed');
});
test('nest: onePage places what fits and reports leftover', () => {
  const parts = []; for (let i = 0; i < 12; i++) parts.push({ id: i, w: 150, h: 100 });
  const o = { bedW: 338, bedH: 340, onePage: true }; const r = nestParts(parts, o); const seen = checkNest(parts, r, o);
  ok(r.pages.length === 1 && seen.size === 6, 'placed ' + seen.size); ok(r.leftover.length === 6 && r.leftover.join() === '6,7,8,9,10,11', 'leftover ' + r.leftover);
  ok(r.warnings.length === 1 && /one sheet/.test(r.warnings[0]), 'warning ' + r.warnings);
  const all = nestParts(parts, { bedW: 338, bedH: 340 }); ok(all.pages.length === 2 && all.leftover.length === 0, 'two pages normally');
  const fit = nestParts(parts.slice(0, 4), o); ok(fit.leftover.length === 0 && fit.warnings.length === 0, 'fits -> no leftover');
  return seen.size + ' placed, ' + r.leftover.length + ' leftover';
});
test('end to end: slice a file, nest its layers', () => {
  const r = sliceModel(torus, { axis: 'x', thickness: 4 }); const parts = r.layers.map(L => ({ id: L.index, w: L.max[0] - L.min[0], h: L.max[1] - L.min[1] }));
  const o = { bedW: 338, bedH: 340 }; const n = nestParts(parts, o); ok(checkNest(parts, n, o).size === parts.length, 'all nested'); return parts.length + ' layers on ' + n.pages.length + ' pages';
});

// ================= loads as a plain <script> beside the page's globals =================
test('loads as a classic script; only sl*-prefixed globals added; page globals untouched', () => {
  const pageGlobals = ['area', 'inside', 'bbox', 'rdp', 'rdpClosed', 'pathLen', 'segDist', 'joinPaths', 'cutPlan', 'polyBool'];
  const ctx = {}; for (const g of pageGlobals) ctx[g] = 'page:' + g; vm.createContext(ctx);
  ctx.Float32Array = Float32Array; // not needed, contexts have their own
  const before = new Set(Object.getOwnPropertyNames(ctx).concat(Object.getOwnPropertyNames(vm.runInContext('this', ctx))));
  vm.runInContext('"use strict";\n' + fs.readFileSync(SRC, 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx);
  for (const g of pageGlobals) ok(ctx[g] === 'page:' + g, 'clobbered ' + g);
  const added = Object.getOwnPropertyNames(vm.runInContext('this', ctx)).filter(k => !before.has(k));
  const bad = added.filter(k => !/^sl[A-Z]/.test(k) && !['parseModel', 'sliceModel', 'nestParts'].includes(k)); ok(bad.length === 0, 'unprefixed globals: ' + bad);
  ok(typeof ctx.parseModel === 'function' && typeof ctx.sliceModel === 'function' && typeof ctx.nestParts === 'function', 'functions defined');
  const src = fs.readFileSync(SRC, 'utf8'); ok(!/\?\.|\?\?|\*\*=|\bimport\b|\bexport\b|#private|\.flat\(|\.at\(/.test(src.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')), 'post-ES2017 syntax');
  ok(/if \(typeof module !== 'undefined'\) module\.exports = \{ parseModel, sliceModel, nestParts \};\s*$/.test(src), 'export line');
  return 'globals added: ' + added.sort().join(', ');
});

console.log(results.join('\n')); console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
