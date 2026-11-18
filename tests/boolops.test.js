const { polyBool } = require(require('path').join(__dirname, '..', 'jog', 'tools', 'boolops.js'));

let seed = 12345;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }

const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const circle = (cx, cy, r, n, ph = 0) => Array.from({ length: n }, (_, i) => {
  const a = ph + 2 * Math.PI * i / n; return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
});
const star = (cx, cy, R, r) => Array.from({ length: 10 }, (_, i) => {
  const a = -Math.PI / 2 + Math.PI * i / 5, q = i % 2 ? r : R; return [cx + q * Math.cos(a), cy + q * Math.sin(a)];
});
function blob(cx, cy, R, n, amp) {
  const ph = [rnd() * 6, rnd() * 6, rnd() * 6];
  return Array.from({ length: n }, (_, i) => {
    const a = 2 * Math.PI * i / n;
    const r = R * (1 + amp * Math.sin(5 * a + ph[0]) + amp * 0.6 * Math.sin(13 * a + ph[1]) + amp * 0.2 * Math.sin(41 * a + ph[2]));
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
}

function inside(polys, x, y) {
  let c = false;
  for (const p of polys) for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const a = p[i], b = p[j];
    if ((a[1] > y) !== (b[1] > y) && x < a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1])) c = !c;
  }
  return c;
}
function nearEdge(polys, x, y, tol) {
  for (const p of polys) for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const a = p[j], b = p[i], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    let t = l2 ? ((x - a[0]) * dx + (y - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
    const ex = a[0] + t * dx - x, ey = a[1] + t * dy - y;
    if (ex * ex + ey * ey < tol * tol) return true;
  }
  return false;
}
const sArea = p => { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
// even-odd area for non-crossing loops: sign by nesting depth
function eoArea(polys) {
  let t = 0;
  polys.forEach((p, i) => {
    const others = polys.filter((_, j) => j !== i);
    // probe point just inside edge 0 of p
    const a = p[0], b = p[1], mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const depth = others.reduce((d, o) => d + (inside([o], mx, my) ? 1 : 0), 0);
    t += (depth % 2 ? -1 : 1) * Math.abs(sArea(p));
  });
  return t;
}
const OPS = { union: (a, b) => a || b, intersect: (a, b) => a && b, subtract: (a, b) => a && !b, xor: (a, b) => a !== b };

let pass = 0, fail = 0;
const rows = [];
function check(name, A, B, op, extra, nSamples = 20000) {
  const Ac = JSON.stringify(A), Bc = JSON.stringify(B);
  const t0 = process.hrtime.bigint();
  let out, err = '';
  try { out = polyBool(A, B, op); } catch (e) { out = []; err = 'THROW ' + e.message; }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (JSON.stringify(A) !== Ac || JSON.stringify(B) !== Bc) err += ' inputs mutated;';
  for (const p of out) {
    if (p.length < 3) err += ' poly<3pts;';
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) { err += ' repeated point;'; break; }
    }
    if (Math.abs(sArea(p)) < 1e-6) err += ' sliver;';
  }
  // sampling
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of A.concat(B)) for (const q of p) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); }
  const pad = (x1 - x0 + y1 - y0) * 0.03 + 1e-3; x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  let bad = 0, tested = 0;
  const all = A.concat(B);
  for (let i = 0; i < nSamples; i++) {
    const x = x0 + rnd() * (x1 - x0), y = y0 + rnd() * (y1 - y0);
    if (nearEdge(all, x, y, 1e-4)) continue;
    tested++;
    if (inside(out, x, y) !== OPS[op](inside(A, x, y), inside(B, x, y))) bad++;
  }
  if (bad) err += ` ${bad}/${tested} sample mismatches;`;
  if (extra) { const m = extra(out); if (m) err += ' ' + m + ';'; }
  const ok = !err;
  ok ? pass++ : fail++;
  rows.push(`${ok ? 'PASS' : 'FAIL'}  ${name} [${op}]  polys=${out.length} pts=${out.reduce((s, p) => s + p.length, 0)}  ${ms.toFixed(2)}ms ${err}`);
  return out;
}
const count = n => out => out.length === n ? '' : `expected ${n} polys got ${out.length}`;
const area = (want, tol = 1e-6) => out => Math.abs(eoArea(out) - want) <= tol * Math.max(1, Math.abs(want)) ? '' : `area ${eoArea(out)} want ${want}`;
const both = (...fs) => out => fs.map(f => f(out)).filter(Boolean).join(', ');
const pts = (...ns) => out => out.every(p => ns.includes(p.length)) ? '' : `point counts ${out.map(p => p.length)} not in ${ns}`;

// 1 overlapping rectangles
{
  const A = [rect(0, 0, 100, 60)], B = [rect(50, 30, 100, 60)];
  check('overlap rects', A, B, 'union', both(count(1), area(6000 + 6000 - 1500), pts(8)));
  check('overlap rects', A, B, 'intersect', both(count(1), area(1500), pts(4)));
  check('overlap rects', A, B, 'subtract', both(count(1), area(4500), pts(6)));
  check('overlap rects', A, B, 'xor', both(area(9000)));
}
// 2 rect with circle inside
{
  const A = [rect(0, 0, 200, 200)], c = circle(100, 100, 50, 120), B = [c], ca = Math.abs(sArea(c));
  check('rect + inner circle', A, B, 'subtract', both(count(2), area(40000 - ca), pts(4, 120)));
  check('rect + inner circle', A, B, 'union', both(count(1), area(40000), pts(4)));
  check('rect + inner circle', A, B, 'intersect', both(count(1), area(ca), pts(120)));
  check('rect + inner circle', A, B, 'xor', both(count(2), area(40000 - ca)));
  check('circle - enclosing rect', B, A, 'subtract', count(0));
}
// 3 disjoint
{
  const A = [rect(0, 0, 10, 10)], B = [circle(50, 50, 8, 100)], ca = Math.abs(sArea(B[0]));
  check('disjoint', A, B, 'union', both(count(2), area(100 + ca)));
  check('disjoint', A, B, 'intersect', count(0));
  check('disjoint', A, B, 'subtract', both(count(1), area(100), pts(4)));
  check('disjoint', A, B, 'xor', both(count(2), area(100 + ca)));
}
// 4 full shared edge
{
  const A = [rect(0, 0, 50, 40)], B = [rect(50, 0, 30, 40)];
  check('shared full edge', A, B, 'union', both(count(1), area(3200), pts(4, 6)));
  check('shared full edge', A, B, 'intersect', count(0));
  check('shared full edge', A, B, 'subtract', both(count(1), area(2000), pts(4)));
  check('shared full edge', A, B, 'xor', both(area(3200)));
  const B2 = [rect(50, 10, 30, 50)];
  check('shared partial edge', A, B2, 'union', both(count(1), area(2000 + 1500), pts(8)));
  check('shared partial edge', A, B2, 'intersect', count(0));
  check('shared partial edge', A, B2, 'subtract', both(count(1), area(2000), pts(4)));
  check('shared partial edge', A, B2, 'xor', area(3500));
  const B3 = [rect(20, 0, 30, 40)]; // inside, sharing 3 edges partially
  check('inner rect sharing edges', A, B3, 'union', both(count(1), area(2000), pts(4)));
  check('inner rect sharing edges', A, B3, 'subtract', both(count(1), area(800), pts(4)));
  check('inner rect sharing edges', A, B3, 'intersect', both(count(1), area(1200), pts(4)));
  check('inner rect sharing edges', A, B3, 'xor', both(count(1), area(800), pts(4)));
}
// 5 identical
{
  const A = [rect(10, 10, 80, 30)], B = [rect(10, 10, 80, 30).reverse()];
  check('identical rects', A, B, 'union', both(count(1), area(2400), pts(4)));
  check('identical rects', A, B, 'intersect', both(count(1), area(2400), pts(4)));
  check('identical rects', A, B, 'subtract', count(0));
  check('identical rects', A, B, 'xor', count(0));
  const c1 = [circle(0, 0, 30, 180)], c2 = [circle(1e-9, -1e-9, 30, 180)];
  check('near-identical circles (1e-9 off)', c1, c2, 'union', both(count(1), pts(180)));
  check('near-identical circles (1e-9 off)', c1, c2, 'subtract', count(0));
  check('near-identical circles (1e-9 off)', c1, c2, 'xor', count(0));
}
// 6 ring minus rect
{
  const ring = [circle(100, 100, 80, 200), circle(100, 100, 50, 150).reverse()], B = [rect(90, 0, 20, 200)];
  check('ring - crossing rect', ring, B, 'subtract', count(2));
  check('ring - crossing rect', ring, B, 'union', count(3));
  check('ring - crossing rect', ring, B, 'intersect', count(2));
  check('ring - crossing rect', ring, B, 'xor');
  check('rect - ring', B, ring, 'subtract', count(3));
}
// 7 star union circle
{
  const A = [star(100, 100, 90, 35)], B = [circle(100, 100, 55, 120)];
  for (const op of Object.keys(OPS)) check('star vs circle', A, B, op, op === 'union' ? count(1) : op === 'subtract' ? count(5) : null);
}
// 8 shared vertex
{
  const A = [rect(0, 0, 10, 10)], B = [rect(10, 10, 10, 10)];
  check('shared vertex', A, B, 'union', both(count(2), area(200), pts(4)));
  check('shared vertex', A, B, 'intersect', count(0));
  check('shared vertex', A, B, 'subtract', both(count(1), area(100)));
  check('shared vertex', A, B, 'xor', both(count(2), area(200)));
  const T = [[5, 10], [15, 10], [10, 20]]; // vertex-on-edge touch (T-junction) + shared edge part
  for (const op of Object.keys(OPS)) check('triangle on rect top', A, T, op);
  const D = [[10, 5], [20, 0], [20, 10]]; // vertex touching edge midpoint
  check('vertex touches edge', A, [D], 'union', both(count(2), area(150)));
  check('vertex touches edge', A, [D], 'subtract', both(count(1), area(100), pts(4)));
}
// 9 operands with holes on both sides
{
  const A = [rect(0, 0, 100, 100), rect(20, 20, 60, 60), rect(40, 40, 20, 20)]; // frame + island
  const B = [circle(100, 50, 45, 90), circle(100, 50, 20, 60)];
  for (const op of Object.keys(OPS)) check('holes+island vs ring', A, B, op);
  const B2 = [rect(20, 20, 60, 60)]; // exactly fills the hole
  check('plug fills hole exactly', A, B2, 'union', both(count(1), area(10000), pts(4)));
  check('plug fills hole exactly', A, B2, 'intersect', both(count(1), area(400), pts(4)));
  check('plug fills hole exactly', A, B2, 'xor', both(count(2), area(9600), pts(4)));
  check('empty B', A, [], 'union', both(count(3), area(10000 - 3600 + 400)));
  check('empty A', [], B2, 'subtract', count(0));
  check('empty A', [], B2, 'xor', count(1));
}
// 10 fuzz: grid-aligned rectangles (many coincident edges/vertices), multi-polygon operands
{
  let fuzzFail = 0, n = 0, tms = 0;
  const pf = fail, pp = pass, keep = rows.length;
  for (let it = 0; it < 300; it++) {
    const mk = () => { // 1-3 rects whose union via our own op (so operand is valid, non-self-crossing)
      let acc = [];
      const k = 1 + Math.floor(rnd() * 3);
      for (let i = 0; i < k; i++) {
        const x = Math.floor(rnd() * 6) * 10, y = Math.floor(rnd() * 6) * 10;
        acc = polyBool(acc, [rect(x, y, 10 + Math.floor(rnd() * 4) * 10, 10 + Math.floor(rnd() * 4) * 10)], rnd() < 0.3 ? 'xor' : 'union');
      }
      return acc;
    };
    const A = mk(), B = mk();
    for (const op of Object.keys(OPS)) { n++; const t = Date.now(); check('fuzz' + it, A, B, op, null, 1500); tms += Date.now() - t; }
  }
  fuzzFail = fail - pf;
  const failedRows = rows.slice(keep).filter(r => r.startsWith('FAIL'));
  rows.length = keep; pass = pp; fail = pf;
  if (fuzzFail) { fail++; rows.push(`FAIL  grid-rect fuzz: ${fuzzFail}/${n} failed`, ...failedRows.slice(0, 5)); }
  else { pass++; rows.push(`PASS  grid-rect fuzz (300 random operand pairs x 4 ops = ${n} cases, coincident edges everywhere)`); }
}
// 11 fuzz: random circles/stars/rotated shapes (general position)
{
  const pf = fail, pp = pass, keep = rows.length; let n = 0;
  for (let it = 0; it < 80; it++) {
    const shape = () => { const r = rnd(); const cx = rnd() * 100, cy = rnd() * 100, R = 10 + rnd() * 40;
      return r < 0.4 ? circle(cx, cy, R, 24 + Math.floor(rnd() * 100), rnd()) : r < 0.7 ? star(cx, cy, R, R * 0.4) : blob(cx, cy, R, 150, 0.08); };
    let A = [shape()], B = [shape()];
    if (rnd() < 0.5) A = polyBool(A, [shape()], 'xor');
    if (rnd() < 0.5) B = polyBool(B, [shape()], 'subtract');
    for (const op of Object.keys(OPS)) { n++; check('gfuzz' + it, A, B, op, null, 3000); }
  }
  const ff = fail - pf, failedRows = rows.slice(keep).filter(r => r.startsWith('FAIL'));
  rows.length = keep; pass = pp; fail = pf;
  if (ff) { fail++; rows.push(`FAIL  general fuzz: ${ff}/${n} failed`, ...failedRows.slice(0, 5)); }
  else { pass++; rows.push(`PASS  general-position fuzz (80 pairs x 4 ops = ${n} cases, operands with holes)`); }
}
// 12 timing: two ~1500 point noisy blobs
{
  const A = [blob(500, 500, 300, 1500, 0.06)], B = [blob(620, 540, 300, 1500, 0.06)];
  for (const op of Object.keys(OPS)) check('1500pt blobs', A, B, op, null, 6000);
  const A2 = [blob(1500, 1500, 1200, 2000, 0.05), circle(1500, 1500, 400, 360)], B2 = [];
  for (let i = 0; i < 18; i++) B2.push(blob(300 + (i % 6) * 480, 600 + Math.floor(i / 6) * 800, 180, 2000, 0.07));
  check('20 polys / 40k edges', A2, B2, 'subtract', null, 1500);
  check('20 polys / 40k edges', A2, B2, 'union', null, 1500);
}

console.log(rows.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
