/* slicer2.js - slice plans: stacked panels and interlocking ("egg-crate") grids.
 *
 * Builds on slicer.js (sliceModel / parseModel / nestParts) and boolops.js
 * (polyBool).  No DOM, plain ES2017.  In the browser paste boolops.js,
 * slicer.js and this file into one <script>, in that order.
 *
 *   slicePlan(model, opts) -> { mode, axes, thickness, size, pieces, stats, warnings, joints, jointStats }
 *   bestPlans(model, opts) -> [{ mode, axes, stats, sheets, oversize, score, reason, warnings }]
 *
 * Plane coordinates (u, v) of a piece follow slicer.js exactly:
 *   thickness along z: (u, v) = (x, y)
 *   thickness along x: (u, v) = (y, z)
 *   thickness along y: (u, v) = (x, depth - z)      (depth = model size along z)
 * All three are proper rotations (u x v = n), so nothing comes out mirrored.
 *
 * Every helper is prefixed `s2` so it cannot clash with the page's globals.
 */
if (typeof module !== 'undefined' && typeof sliceModel === 'undefined') {
  var { parseModel, sliceModel, nestParts } = require('./slicer.js');
  var { polyBool } = require('./boolops.js');
}

/* ------------------------------------------------------------------ */
/* Small 2D helpers                                                    */
/* ------------------------------------------------------------------ */

function s2SignedArea(pts) {
  var s = 0, n = pts.length;
  for (var i = 0, j = n - 1; i < n; j = i++) s += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return s / 2;
}

function s2Perimeter(pts) {
  var s = 0, n = pts.length;
  for (var i = 0, j = n - 1; i < n; j = i++) {
    var dx = pts[i][0] - pts[j][0], dy = pts[i][1] - pts[j][1];
    s += Math.sqrt(dx * dx + dy * dy);
  }
  return s;
}

function s2InLoop(x, y, pts) {
  var c = false, n = pts.length;
  for (var i = 0, j = n - 1; i < n; j = i++) {
    var yi = pts[i][1], yj = pts[j][1];
    if ((yi > y) !== (yj > y)) {
      var xi = pts[i][0], xj = pts[j][0];
      if (x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
    }
  }
  return c;
}

function s2Box(loops) {
  var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (var i = 0; i < loops.length; i++) {
    var l = loops[i];
    for (var k = 0; k < l.length; k++) {
      var x = l[k][0], y = l[k][1];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return [x0, y0, x1, y1];
}

function s2SameLoops(a, b) {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) {
    var p = a[i], q = b[i];
    if (p.length !== q.length) return false;
    for (var k = 0; k < p.length; k++) {
      if (Math.abs(p[k][0] - q[k][0]) > 1e-9 || Math.abs(p[k][1] - q[k][1]) > 1e-9) return false;
    }
  }
  return true;
}

/* Iterative Ramer-Douglas-Peucker over pts[i0..i1]; marks kept points. */
function s2RdpMark(pts, i0, i1, tol, keep) {
  var stack = [i0, i1], t2 = tol * tol;
  keep[i0] = 1; keep[i1] = 1;
  while (stack.length) {
    var b = stack.pop(), a = stack.pop();
    if (b - a < 2) continue;
    var ax = pts[a][0], ay = pts[a][1], dx = pts[b][0] - ax, dy = pts[b][1] - ay;
    var len2 = dx * dx + dy * dy, worst = -1, wi = -1;
    for (var i = a + 1; i < b; i++) {
      var px = pts[i][0] - ax, py = pts[i][1] - ay, d2;
      if (len2 > 0) {
        var t = (px * dx + py * dy) / len2;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        var ex = px - t * dx, ey = py - t * dy;
        d2 = ex * ex + ey * ey;
      } else d2 = px * px + py * py;
      if (d2 > worst) { worst = d2; wi = i; }
    }
    if (worst > t2) { keep[wi] = 1; stack.push(a, wi, wi, b); }
  }
}

function s2Dedupe(pts) {
  var out = [], E = 1e-9;
  for (var i = 0; i < pts.length; i++) {
    var p = pts[i];
    if (out.length) {
      var q = out[out.length - 1];
      if (Math.abs(p[0] - q[0]) <= E && Math.abs(p[1] - q[1]) <= E) continue;
    }
    out.push(p);
  }
  while (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) <= E &&
         Math.abs(out[0][1] - out[out.length - 1][1]) <= E) out.pop();
  return out;
}

/* Closed simplify, anchored on two true extreme points of the loop. */
function s2Simplify(pts, tol) {
  pts = s2Dedupe(pts);
  var n = pts.length;
  if (n < 4) return pts;
  var a = 0, i;
  for (i = 1; i < n; i++) {
    if (pts[i][0] < pts[a][0] || (pts[i][0] === pts[a][0] && pts[i][1] < pts[a][1])) a = i;
  }
  var ring = new Array(n + 1);
  for (i = 0; i < n; i++) ring[i] = pts[(a + i) % n];
  ring[n] = ring[0];
  var b = 0, far = -1;
  for (i = 1; i < n; i++) {
    var dx = ring[i][0] - ring[0][0], dy = ring[i][1] - ring[0][1], d = dx * dx + dy * dy;
    if (d > far) { far = d; b = i; }
  }
  var keep = new Uint8Array(n + 1), eps = tol > 1e-9 ? tol : 1e-9;
  s2RdpMark(ring, 0, b, eps, keep);
  s2RdpMark(ring, b, n, eps, keep);
  var out = [];
  for (i = 0; i < n; i++) if (keep[i]) out.push(ring[i]);
  return s2Dedupe(out);
}

/* Chain loose segments (x0,y0,x1,y1 per segment) into closed loops.
 * Returns { loops, openLen } where openLen is the length of the longest
 * chain that failed to close (a sign of a leaky mesh). */
function s2Chain(S, ns, eps) {
  var inv = 1 / eps, K = 67108864, e2 = eps * eps;
  var cell = new Map(), nx = [], ny = [], ncell = [];
  var ea = new Int32Array(ns), eb = new Int32Array(ns), ne = 0;

  function node(x, y) {
    var ix = Math.floor(x * inv), iy = Math.floor(y * inv), best = -1, bd = e2;
    for (var dx = -1; dx <= 1; dx++) {
      for (var dy = -1; dy <= 1; dy++) {
        var id = cell.get((ix + dx + 8) * K + (iy + dy + 8));
        while (id !== undefined && id >= 0) {
          var ex = nx[id] - x, ey = ny[id] - y, d = ex * ex + ey * ey;
          if (d <= bd) { bd = d; best = id; }
          id = ncell[id];
        }
      }
    }
    if (best >= 0) return best;
    var key = (ix + 8) * K + (iy + 8), prev = cell.get(key), nid = nx.length;
    nx.push(x); ny.push(y); ncell.push(prev === undefined ? -1 : prev);
    cell.set(key, nid);
    return nid;
  }

  for (var s = 0, p = 0; s < ns; s++, p += 4) {
    var a = node(S[p], S[p + 1]), b = node(S[p + 2], S[p + 3]);
    if (a === b) continue;
    ea[ne] = a; eb[ne] = b; ne++;
  }
  var nn = nx.length;
  var head = new Int32Array(nn).fill(-1), nxt = new Int32Array(2 * ne), deg = new Int32Array(nn);
  for (var e = 0; e < ne; e++) {
    nxt[2 * e] = head[ea[e]]; head[ea[e]] = 2 * e;
    nxt[2 * e + 1] = head[eb[e]]; head[eb[e]] = 2 * e + 1;
    deg[ea[e]]++; deg[eb[e]]++;
  }
  var used = new Uint8Array(ne), where = new Int32Array(nn).fill(-1);
  var loops = [], openLen = 0;

  function walk(start) {
    var path = [start], cur = start, i;
    where[start] = 0;
    for (;;) {
      var h = head[cur];
      while (h >= 0 && used[h >> 1]) h = nxt[h];
      head[cur] = h;
      if (h < 0) break;
      used[h >> 1] = 1;
      var other = (h & 1) ? ea[h >> 1] : eb[h >> 1], at = where[other];
      if (at >= 0) {
        if (path.length - at >= 3) {
          var pts = new Array(path.length - at);
          for (i = at; i < path.length; i++) pts[i - at] = [nx[path[i]], ny[path[i]]];
          loops.push(pts);
        }
        for (i = at + 1; i < path.length; i++) where[path[i]] = -1;
        path.length = at + 1;
      } else {
        where[other] = path.length;
        path.push(other);
      }
      cur = other;
    }
    if (path.length > 1) {
      var len = 0;
      for (i = 1; i < path.length; i++) {
        var ddx = nx[path[i]] - nx[path[i - 1]], ddy = ny[path[i]] - ny[path[i - 1]];
        len += Math.sqrt(ddx * ddx + ddy * ddy);
      }
      if (len > openLen) openLen = len;
    }
    for (i = 0; i < path.length; i++) where[path[i]] = -1;
  }

  var i;
  for (i = 0; i < nn; i++) if (deg[i] & 1) walk(i);
  for (i = 0; i < nn; i++) {
    for (;;) {
      var hh = head[i];
      while (hh >= 0 && used[hh >> 1]) hh = nxt[hh];
      head[i] = hh;
      if (hh < 0) break;
      walk(i);
    }
  }
  return { loops: loops, openLen: openLen };
}

/* ------------------------------------------------------------------ */
/* Model context: scaled triangles, per-axis views, plane sections      */
/* ------------------------------------------------------------------ */

function s2Context(model, scale) {
  if (!model || !model.tris || !(model.tris.length >= 9)) {
    throw new Error('There is no 3D model to slice. Import a model first.');
  }
  var sc = scale == null ? 1 : scale, s;
  if (Array.isArray(sc)) s = [Number(sc[0]), Number(sc[1]), Number(sc[2])];
  else s = [Number(sc), Number(sc), Number(sc)];
  if (!isFinite(s[0]) || !isFinite(s[1]) || !isFinite(s[2]) || s[0] === 0 || s[1] === 0 || s[2] === 0) {
    throw new Error('The model scale must be a number other than zero.');
  }
  var src = model.tris, nt = Math.floor(src.length / 9), n9 = nt * 9;
  var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], i, k, c;
  var P = new Float64Array(n9);
  for (i = 0; i < n9; i += 3) {
    for (k = 0; k < 3; k++) {
      c = src[i + k] * s[k];
      P[i + k] = c;
      if (c < mn[k]) mn[k] = c;
      if (c > mx[k]) mx[k] = c;
    }
  }
  if (!isFinite(mn[0] + mn[1] + mn[2] + mx[0] + mx[1] + mx[2])) {
    throw new Error('The model has unreadable coordinates. Try exporting it again.');
  }
  for (i = 0; i < n9; i += 3) { P[i] -= mn[0]; P[i + 1] -= mn[1]; P[i + 2] -= mn[2]; }
  var size = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
  var diag = Math.sqrt(size[0] * size[0] + size[1] * size[1] + size[2] * size[2]);
  return {
    P: P, nt: nt, size: size, eps: Math.max(1e-6, 1e-5 * diag),
    mirrored: s[0] * s[1] * s[2] < 0, prep: {}, fam: {}
  };
}

/* Placement of a piece whose thickness runs along `axis`.
 * pi[k] = plane index (0 = u, 1 = v) that carries model axis k, and
 * model_k = of[k] + sg[k] * plane[pi[k]]. */
function s2Frame(axis, size) {
  if (axis === 'z') return { u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1], o: [0, 0, 0], pi: [0, 1, -1], sg: [1, 1, 0], of: [0, 0, 0] };
  if (axis === 'x') return { u: [0, 1, 0], v: [0, 0, 1], n: [1, 0, 0], o: [0, 0, 0], pi: [-1, 0, 1], sg: [0, 1, 1], of: [0, 0, 0] };
  return { u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0], o: [0, 0, size[2]], pi: [0, -1, 1], sg: [1, 0, -1], of: [0, 0, size[2]] };
}

function s2Prep(ctx, axis) {
  if (ctx.prep[axis]) return ctx.prep[axis];
  var iu, iv, ih, flip = false;
  if (axis === 'z') { iu = 0; iv = 1; ih = 2; }
  else if (axis === 'x') { iu = 1; iv = 2; ih = 0; }
  else { iu = 0; iv = 2; ih = 1; flip = true; }
  var P = ctx.P, nt = ctx.nt, D = ctx.size[iv];
  var Q = new Float64Array(nt * 9), lo = new Float64Array(nt), hi = new Float64Array(nt), cnt = 0, t, i;
  for (i = 0; i < nt * 9; i += 3) {
    Q[i] = P[i + iu];
    Q[i + 1] = flip ? D - P[i + iv] : P[i + iv];
    Q[i + 2] = P[i + ih];
  }
  for (t = 0; t < nt; t++) {
    var q = t * 9, h0 = Q[q + 2], h1 = Q[q + 5], h2 = Q[q + 8];
    lo[t] = h0 < h1 ? (h0 < h2 ? h0 : h2) : (h1 < h2 ? h1 : h2);
    hi[t] = h0 > h1 ? (h0 > h2 ? h0 : h2) : (h1 > h2 ? h1 : h2);
    if (hi[t] > lo[t]) cnt++;
  }
  var order = new Int32Array(cnt), o = 0;
  for (t = 0; t < nt; t++) if (hi[t] > lo[t]) order[o++] = t;
  order.sort(function (a, b) { return lo[a] - lo[b]; });
  return (ctx.prep[axis] = { Q: Q, lo: lo, hi: hi, order: order });
}

/* Cross-sections at the given heights (ascending) along `axis`.
 * Returns one { loops, gap } per height; loops are raw even-odd outlines. */
function s2Sections(ctx, axis, heights, tol) {
  var pr = s2Prep(ctx, axis), Q = pr.Q, lo = pr.lo, hi = pr.hi, order = pr.order, no = order.length;
  var active = new Int32Array(no || 1), na = 0, ptr = 0;
  var S = new Float64Array(4096), out = [], eps = ctx.eps, openMin = Math.max(tol, 50 * eps);
  for (var hIdx = 0; hIdx < heights.length; hIdx++) {
    var plane = heights[hIdx], ns = 0, w = 0, i, k;
    while (ptr < no && lo[order[ptr]] < plane) active[na++] = order[ptr++];
    for (i = 0; i < na; i++) {
      var t = active[i];
      if (hi[t] < plane) continue;
      active[w++] = t;
      var b = t * 9;
      var d0 = Q[b + 2] - plane, d1 = Q[b + 5] - plane, d2 = Q[b + 8] - plane;
      var up = (d0 >= 0 ? 1 : 0) + (d1 >= 0 ? 1 : 0) + (d2 >= 0 ? 1 : 0);   // on the plane counts as above
      if (up === 0 || up === 3) continue;
      var L, A, B, dL, dA, dB;
      if ((d0 >= 0) !== (d1 >= 0) && (d0 >= 0) !== (d2 >= 0)) { L = b; A = b + 3; B = b + 6; dL = d0; dA = d1; dB = d2; }
      else if ((d1 >= 0) !== (d0 >= 0) && (d1 >= 0) !== (d2 >= 0)) { L = b + 3; A = b + 6; B = b; dL = d1; dA = d2; dB = d0; }
      else { L = b + 6; A = b; B = b + 3; dL = d2; dA = d0; dB = d1; }
      if (ns * 4 + 4 > S.length) { var S2 = new Float64Array(S.length * 2); S2.set(S); S = S2; }
      var o = ns * 4;
      // always interpolate from the lower vertex to the upper one, so the two
      // triangles sharing an edge produce bit-identical points
      for (k = 0; k < 2; k++) {
        var X = k ? B : A, dX = k ? dB : dA, lowI, highI, dLow, dHigh;
        if (dL < 0) { lowI = L; dLow = dL; highI = X; dHigh = dX; }
        else { lowI = X; dLow = dX; highI = L; dHigh = dL; }
        if (dHigh === 0) { S[o++] = Q[highI]; S[o++] = Q[highI + 1]; }
        else {
          var tt = dLow / (dLow - dHigh);
          S[o++] = Q[lowI] + tt * (Q[highI] - Q[lowI]);
          S[o++] = Q[lowI + 1] + tt * (Q[highI + 1] - Q[lowI + 1]);
        }
      }
      ns++;
    }
    na = w;
    var loops = [], gap = false;
    if (ns) {
      var ch = s2Chain(S, ns, eps);
      for (i = 0; i < ch.loops.length; i++) {
        var lp = s2Simplify(ch.loops[i], tol);
        if (lp.length < 3 || Math.abs(s2SignedArea(lp)) < 0.01) continue;
        loops.push(lp);
      }
      gap = ch.openLen > openMin;
    }
    out.push({ loops: loops, gap: gap });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Outward offset ("allowance")                                        */
/* ------------------------------------------------------------------ */

/* Positive-winding fill of directed loops: returns the boundary of the region
 * whose winding number is above zero (filled side on the left).  Same edge
 * splitting / merging scheme as polyBool, with signed edge counts. */
function s2PositiveFill(loops) {
  var EPS = 1e-6;
  var vx = [], vy = [], cells = new Map();
  function vid(x, y) {
    var ix = Math.floor(x / EPS), iy = Math.floor(y / EPS), i, j, k, list, id;
    for (i = -1; i <= 1; i++) {
      for (j = -1; j <= 1; j++) {
        list = cells.get((ix + i) + ',' + (iy + j));
        if (!list) continue;
        for (k = 0; k < list.length; k++) {
          id = list[k];
          if (Math.abs(vx[id] - x) <= EPS && Math.abs(vy[id] - y) <= EPS) return id;
        }
      }
    }
    id = vx.length;
    vx.push(x); vy.push(y);
    var key = ix + ',' + iy;
    list = cells.get(key);
    if (list) list.push(id); else cells.set(key, [id]);
    return id;
  }

  var eu = [], ev = [], i, j, k, e;
  for (var p = 0; p < loops.length; p++) {
    var poly = loops[p], ids = [];
    for (i = 0; i < poly.length; i++) {
      var id0 = vid(poly[i][0], poly[i][1]);
      if (ids.length === 0 || ids[ids.length - 1] !== id0) ids.push(id0);
    }
    while (ids.length > 1 && ids[ids.length - 1] === ids[0]) ids.pop();
    if (ids.length < 2) continue;
    for (i = 0; i < ids.length; i++) { eu.push(ids[i]); ev.push(ids[(i + 1) % ids.length]); }
  }
  var nE = eu.length;
  if (nE === 0) return [];

  var splits = new Array(nE);
  function addSplit(ed, v) { if (splits[ed]) splits[ed].push(v); else splits[ed] = [v]; }
  function onSeg(q, a, b) {
    var ax = vx[a], ay = vy[a], rx = vx[b] - ax, ry = vy[b] - ay;
    var px = vx[q] - ax, py = vy[q] - ay, len2 = rx * rx + ry * ry, d = px * rx + py * ry;
    if (d <= 0 || d >= len2) return false;
    var c = px * ry - py * rx;
    return c * c <= EPS * EPS * len2;
  }
  function crossPair(m, n) {
    var a = eu[m], b = ev[m], c = eu[n], d = ev[n];
    if ((a === c && b === d) || (a === d && b === c)) return;
    var touch = false;
    if (c !== a && c !== b && onSeg(c, a, b)) { addSplit(m, c); touch = true; }
    if (d !== a && d !== b && onSeg(d, a, b)) { addSplit(m, d); touch = true; }
    if (a !== c && a !== d && onSeg(a, c, d)) { addSplit(n, a); touch = true; }
    if (b !== c && b !== d && onSeg(b, c, d)) { addSplit(n, b); touch = true; }
    if (touch || a === c || a === d || b === c || b === d) return;
    var ax = vx[a], ay = vy[a], rx = vx[b] - ax, ry = vy[b] - ay;
    var cx = vx[c], cy = vy[c], sx = vx[d] - cx, sy = vy[d] - cy;
    var den = rx * sy - ry * sx;
    if (den === 0) return;
    var qx = cx - ax, qy = cy - ay;
    var t = (qx * sy - qy * sx) / den;
    if (t <= 0 || t >= 1) return;
    var u = (qx * ry - qy * rx) / den;
    if (u <= 0 || u >= 1) return;
    var pt = vid(ax + t * rx, ay + t * ry);
    if (pt !== a && pt !== b) addSplit(m, pt);
    if (pt !== c && pt !== d) addSplit(n, pt);
  }
  var loX = new Float64Array(nE), hiX = new Float64Array(nE), loY = new Float64Array(nE), hiY = new Float64Array(nE);
  var order = new Array(nE);
  for (e = 0; e < nE; e++) {
    var x1 = vx[eu[e]], x2 = vx[ev[e]], y1 = vy[eu[e]], y2 = vy[ev[e]];
    loX[e] = (x1 < x2 ? x1 : x2) - EPS; hiX[e] = (x1 < x2 ? x2 : x1) + EPS;
    loY[e] = (y1 < y2 ? y1 : y2) - EPS; hiY[e] = (y1 < y2 ? y2 : y1) + EPS;
    order[e] = e;
  }
  order.sort(function (a, b) { return loX[a] - loX[b]; });
  for (i = 0; i < nE; i++) {
    var ei = order[i], hx = hiX[ei], ly = loY[ei], hy = hiY[ei];
    for (j = i + 1; j < nE; j++) {
      var ej = order[j];
      if (loX[ej] > hx) break;
      if (loY[ej] > hy || hiY[ej] < ly) continue;
      crossPair(ei, ej);
    }
  }

  // unique undirected sub-edges with a signed count (+ = runs low id -> high id)
  var NV = vx.length, segMap = new Map(), su = [], sv = [], scn = [];
  function addSeg(a, b) {
    if (a === b) return;
    var l = a < b ? a : b, h = a < b ? b : a, key = l * NV + h, s = segMap.get(key);
    if (s === undefined) { s = su.length; segMap.set(key, s); su.push(l); sv.push(h); scn.push(0); }
    scn[s] += a < b ? 1 : -1;
  }
  for (e = 0; e < nE; e++) {
    var a0 = eu[e], b0 = ev[e], sp = splits[e];
    if (!sp) { addSeg(a0, b0); continue; }
    var ox = vx[a0], oy = vy[a0], dx0 = vx[b0] - ox, dy0 = vy[b0] - oy, items = [];
    for (k = 0; k < sp.length; k++) items.push({ v: sp[k], t: (vx[sp[k]] - ox) * dx0 + (vy[sp[k]] - oy) * dy0 });
    items.sort(function (a, b) { return a.t - b.t; });
    var prev = a0;
    for (k = 0; k < items.length; k++) {
      if (items[k].v === prev || items[k].v === b0) continue;
      addSeg(prev, items[k].v);
      prev = items[k].v;
    }
    addSeg(prev, b0);
  }
  var S = [];
  for (k = 0; k < su.length; k++) if (scn[k]) S.push(k);
  var nS = S.length;
  if (nS === 0) return [];

  var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (k = 0; k < nS; k++) {
    var s0 = S[k], xa = vx[su[s0]], xb = vx[sv[s0]], ya = vy[su[s0]], yb = vy[sv[s0]];
    if (xa < minX) minX = xa; if (xb < minX) minX = xb;
    if (xa > maxX) maxX = xa; if (xb > maxX) maxX = xb;
    if (ya < minY) minY = ya; if (yb < minY) minY = yb;
    if (ya > maxY) maxY = ya; if (yb > maxY) maxY = yb;
  }
  var nBands = Math.max(1, Math.min(4096, Math.ceil(nS / 4)));
  var bandH = (maxY - minY) / nBands || 1, bandW = (maxX - minX) / nBands || 1;
  function bandOf(val, lo, size) {
    var b = Math.floor((val - lo) / size);
    return b < 0 ? 0 : (b >= nBands ? nBands - 1 : b);
  }
  var yBands = new Array(nBands), xBands = new Array(nBands), b1, b2, bb;
  for (k = 0; k < nBands; k++) { yBands[k] = []; xBands[k] = []; }
  for (k = 0; k < nS; k++) {
    var s1 = S[k], px1 = vx[su[s1]], px2 = vx[sv[s1]], py1 = vy[su[s1]], py2 = vy[sv[s1]];
    if (py1 !== py2) {
      b1 = bandOf(Math.min(py1, py2), minY, bandH); b2 = bandOf(Math.max(py1, py2), minY, bandH);
      for (bb = b1; bb <= b2; bb++) yBands[bb].push(s1);
    }
    if (px1 !== px2) {
      b1 = bandOf(Math.min(px1, px2), minX, bandW); b2 = bandOf(Math.max(px1, px2), minX, bandW);
      for (bb = b1; bb <= b2; bb++) xBands[bb].push(s1);
    }
  }

  var kFrom = [], kTo = [];
  for (k = 0; k < nS; k++) {
    var s = S[k], u = su[s], v = sv[s];
    var ux = vx[u], uy = vy[u], dx = vx[v] - ux, dy = vy[v] - uy;
    var mx = ux + dx * 0.5, my = uy + dy * 0.5;
    var wn = 0, wf, list, n, o, p1x, p1y, p2x, p2y, rayIsLeft;
    if (Math.abs(dy) >= Math.abs(dx)) {
      list = yBands[bandOf(my, minY, bandH)];
      for (n = 0; n < list.length; n++) {
        o = list[n];
        if (o === s) continue;
        p1y = vy[su[o]]; p2y = vy[sv[o]];
        if ((p1y > my) === (p2y > my)) continue;
        p1x = vx[su[o]]; p2x = vx[sv[o]];
        if (p1x + (my - p1y) * (p2x - p1x) / (p2y - p1y) > mx) wn += p2y > p1y ? scn[o] : -scn[o];
      }
      wf = wn + (dy > 0 ? scn[s] : -scn[s]);
      rayIsLeft = dy < 0;
    } else {
      list = xBands[bandOf(mx, minX, bandW)];
      for (n = 0; n < list.length; n++) {
        o = list[n];
        if (o === s) continue;
        p1x = vx[su[o]]; p2x = vx[sv[o]];
        if ((p1x > mx) === (p2x > mx)) continue;
        p1y = vy[su[o]]; p2y = vy[sv[o]];
        if (p1y + (mx - p1x) * (p2y - p1y) / (p2x - p1x) > my) wn += p2x < p1x ? scn[o] : -scn[o];
      }
      wf = wn + (dx < 0 ? scn[s] : -scn[s]);
      rayIsLeft = dx > 0;
    }
    var near = wn > 0, far = wf > 0;
    if (near === far) continue;
    if (rayIsLeft ? near : far) { kFrom.push(u); kTo.push(v); } else { kFrom.push(v); kTo.push(u); }
  }
  var nK = kFrom.length;
  if (nK === 0) return [];

  var outs = new Map();
  for (k = 0; k < nK; k++) {
    var ol = outs.get(kFrom[k]);
    if (ol) ol.push(k); else outs.set(kFrom[k], [k]);
  }
  var used = new Uint8Array(nK);
  function nextEdge(cur, start) {
    var at = kTo[cur], cand = outs.get(at);
    if (!cand) return -1;
    if (cand.length === 1) return (cand[0] === start || !used[cand[0]]) ? cand[0] : -1;
    var ix = vx[at] - vx[kFrom[cur]], iy = vy[at] - vy[kFrom[cur]], best = -1, bestTurn = -Infinity;
    for (var c = 0; c < cand.length; c++) {
      var ce = cand[c];
      if (used[ce] && ce !== start) continue;
      var qx = vx[kTo[ce]] - vx[at], qy = vy[kTo[ce]] - vy[at];
      var turn = Math.atan2(ix * qy - iy * qx, ix * qx + iy * qy);
      if (turn > bestTurn) { bestTurn = turn; best = ce; }
    }
    return best;
  }
  var result = [];
  for (k = 0; k < nK; k++) {
    if (used[k]) continue;
    var loop = [], cur = k, closed = false, guard = 0;
    while (guard++ <= nK) {
      used[cur] = 1;
      loop.push([vx[kFrom[cur]], vy[kFrom[cur]]]);
      var nxE = nextEdge(cur, k);
      if (nxE === k) { closed = true; break; }
      if (nxE < 0) { closed = kTo[cur] === kFrom[k]; break; }
      cur = nxE;
    }
    if (closed && loop.length >= 3) result.push(loop);
  }
  return result;
}

/* Grow a clean polygon set (outer loops counter-clockwise, holes clockwise, as
 * polyBool returns them) outward by d: outers grow, holes shrink or vanish.
 * Corners are mitred; a corner sharper than 90 degrees is cut with one extra
 * facet that still stays at least d away, so the result always contains the
 * true round offset. */
function s2Offset(polys, d) {
  if (!(d > 0) || !polys.length) return polys;
  var raw = [], HALF = Math.PI / 2;
  for (var li = 0; li < polys.length; li++) {
    var src = polys[li], pts = [], i;
    for (i = 0; i < src.length; i++) {          // drop zero-length edges
      var q = pts.length ? pts[pts.length - 1] : null;
      if (q && Math.abs(q[0] - src[i][0]) < 1e-9 && Math.abs(q[1] - src[i][1]) < 1e-9) continue;
      pts.push(src[i]);
    }
    while (pts.length > 1 && Math.abs(pts[0][0] - pts[pts.length - 1][0]) < 1e-9 &&
           Math.abs(pts[0][1] - pts[pts.length - 1][1]) < 1e-9) pts.pop();
    var n = pts.length;
    if (n < 3) continue;
    var out = [];
    for (i = 0; i < n; i++) {
      var p = pts[i], a = pts[(i + n - 1) % n], b = pts[(i + 1) % n];
      var e1x = p[0] - a[0], e1y = p[1] - a[1], e2x = b[0] - p[0], e2y = b[1] - p[1];
      var l1 = Math.sqrt(e1x * e1x + e1y * e1y), l2 = Math.sqrt(e2x * e2x + e2y * e2y);
      e1x /= l1; e1y /= l1; e2x /= l2; e2y /= l2;
      var n1x = e1y, n1y = -e1x, n2x = e2y, n2y = -e2x;      // right-hand normals: away from the material
      var cr = e1x * e2y - e1y * e2x, dt = e1x * e2x + e1y * e2y;
      if (Math.abs(cr) < 1e-9 && dt > 0) {
        out.push([p[0] + d * n1x, p[1] + d * n1y]);          // straight on
      } else if (cr > 0 || (Math.abs(cr) < 1e-9 && dt < 0)) {
        var phi = Math.abs(cr) < 1e-9 ? Math.PI : Math.atan2(cr, dt);   // convex corner
        var kk = Math.max(1, Math.ceil(phi / HALF - 1e-9));
        var a1 = Math.atan2(n1y, n1x), r = d / Math.cos(phi / (2 * kk));
        for (var j = 0; j < kk; j++) {
          var ang = a1 + (j + 0.5) * phi / kk;
          out.push([p[0] + r * Math.cos(ang), p[1] + r * Math.sin(ang)]);
        }
      } else {
        // concave corner: pass through the corner itself; the little inverted
        // loop this makes has negative winding and is discarded by the fill
        out.push([p[0] + d * n1x, p[1] + d * n1y]);
        out.push([p[0], p[1]]);
        out.push([p[0] + d * n2x, p[1] + d * n2y]);
      }
    }
    raw.push(out);
  }
  var grown = s2PositiveFill(raw);
  // back through polyBool: cleans collinear points and guarantees the original is covered
  return polyBool(grown, polys, 'union');
}

/* ------------------------------------------------------------------ */
/* Slabs -> outlines -> pieces                                         */
/* ------------------------------------------------------------------ */

/* Outline of each slab [lo, hi] along `axis` (slabs ascending, not overlapping).
 * envelope: union of sections through the slab; otherwise the mid-plane only. */
function s2SlabOutlines(ctx, axis, slabs, o, notes) {
  var ts = [0.5], k, i;
  if (o.envelope) {
    var m = Math.max(2, o.samples | 0);
    ts = [];
    for (k = 0; k < m; k++) ts.push(k / (m - 1));
    if (ts.indexOf(0.5) < 0) { ts.push(0.5); ts.sort(function (a, b) { return a - b; }); }
  }
  var heights = [];
  for (i = 0; i < slabs.length; i++) {
    var lo = slabs[i].lo, hi = slabs[i].hi, e = Math.min((hi - lo) * 0.01, 0.002);
    for (k = 0; k < ts.length; k++) {
      var h = lo + ts[k] * (hi - lo);
      if (h < lo + e) h = lo + e;
      if (h > hi - e) h = hi - e;
      heights.push(h);
    }
  }
  var secs = s2Sections(ctx, axis, heights, o.tolerance), out = [], gaps = 0;
  for (i = 0; i < slabs.length; i++) {
    var acc = null, last = null, gap = false;
    for (k = 0; k < ts.length; k++) {
      var sec = secs[i * ts.length + k];
      if (sec.gap) gap = true;
      if (!sec.loops.length) continue;
      if (!acc) acc = polyBool(sec.loops, [], 'union');
      else if (!s2SameLoops(sec.loops, last)) acc = polyBool(acc, sec.loops, 'union');
      last = sec.loops;
    }
    if (gap) gaps++;
    acc = acc || [];
    if (o.allowance > 0 && acc.length) acc = s2Offset(acc, o.allowance);
    out.push(acc);
  }
  if (gaps) notes.gaps = (notes.gaps || 0) + gaps;
  return out;
}

/* Split a flat even-odd polygon set into islands: [outer, hole, hole, ...] each.
 * An island sitting inside a hole is its own island. */
function s2Islands(polys) {
  var n = polys.length, i, j, k;
  if (n === 0) return [];
  if (n === 1) return [[polys[0]]];
  var boxes = [], areas = [], depth = new Int32Array(n), parent = new Int32Array(n).fill(-1);
  for (i = 0; i < n; i++) { boxes.push(s2Box([polys[i]])); areas.push(Math.abs(s2SignedArea(polys[i]))); }
  for (i = 0; i < n; i++) {
    var L = polys[i], m = L.length, bi = boxes[i];
    for (j = 0; j < n; j++) {
      if (j === i || areas[j] <= areas[i]) continue;
      var bj = boxes[j];
      if (bi[0] < bj[0] - 1e-6 || bi[1] < bj[1] - 1e-6 || bi[2] > bj[2] + 1e-6 || bi[3] > bj[3] + 1e-6) continue;
      var votes = 0;
      for (k = 0; k < 3; k++) {                   // three edge midpoints, majority wins
        var a = L[Math.floor(k * m / 3) % m], b = L[(Math.floor(k * m / 3) + 1) % m];
        if (s2InLoop((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, polys[j])) votes++;
      }
      if (votes >= 2) {
        depth[i]++;
        if (parent[i] < 0 || areas[j] < areas[parent[i]]) parent[i] = j;
      }
    }
  }
  var groups = [], slot = new Int32Array(n).fill(-1);
  for (i = 0; i < n; i++) if (!(depth[i] & 1)) { slot[i] = groups.length; groups.push({ loops: [polys[i]], box: boxes[i] }); }
  for (i = 0; i < n; i++) if ((depth[i] & 1) && parent[i] >= 0 && slot[parent[i]] >= 0) groups[slot[parent[i]]].loops.push(polys[i]);
  groups.sort(function (p, q) {
    if (Math.abs(p.box[0] - q.box[0]) > 1e-6) return p.box[0] - q.box[0];
    if (Math.abs(p.box[1] - q.box[1]) > 1e-6) return p.box[1] - q.box[1];
    return 0;
  });
  var res = [];
  for (i = 0; i < groups.length; i++) res.push(groups[i].loops);
  return res;
}

function s2Letters(k) {
  var s = '';
  k = k + 1;
  while (k > 0) { k--; s = String.fromCharCode(97 + (k % 26)) + s; k = Math.floor(k / 26); }
  return s;
}

function s2MakePiece(loops, frame, low, name, axis, index) {
  var bx = s2Box(loops), out = [], area = 0, cut = 0, i, k;
  for (i = 0; i < loops.length; i++) {
    var src = loops[i], l = new Array(src.length);
    for (k = 0; k < src.length; k++) l[k] = [src[k][0] - bx[0], src[k][1] - bx[1]];
    out.push(l);
    area += (i === 0 ? 1 : -1) * Math.abs(s2SignedArea(l));
    cut += s2Perimeter(l);
  }
  var u = frame.u, v = frame.v, nn = frame.n, o = frame.o;
  return {
    id: 0, name: name, axis: axis, index: index, loops: out,
    w: bx[2] - bx[0], h: bx[3] - bx[1], area: area, cutLength: cut,
    origin: [o[0] + low * nn[0] + bx[0] * u[0] + bx[1] * v[0],
             o[1] + low * nn[1] + bx[0] * u[1] + bx[1] * v[1],
             o[2] + low * nn[2] + bx[0] * u[2] + bx[1] * v[2]],
    u: u.slice(), v: v.slice(), n: nn.slice()
  };
}

function s2Stats(pieces, T) {
  var st = { count: pieces.length, minSize: 0, minPiece: '', minArea: 0, cutLength: 0, pierces: 0, area: 0,
             maxW: 0, maxH: 0, maxLong: 0, maxShort: 0, pieceVolume: 0 };
  var minSize = Infinity, minArea = Infinity;
  for (var i = 0; i < pieces.length; i++) {
    var p = pieces[i], sh = p.w < p.h ? p.w : p.h, lg = p.w < p.h ? p.h : p.w;
    if (sh < minSize) { minSize = sh; st.minPiece = p.name; }
    if (p.area < minArea) minArea = p.area;
    st.cutLength += p.cutLength; st.pierces += p.loops.length; st.area += p.area;
    if (p.w > st.maxW) st.maxW = p.w;
    if (p.h > st.maxH) st.maxH = p.h;
    if (lg > st.maxLong) st.maxLong = lg;
    if (sh > st.maxShort) st.maxShort = sh;
  }
  if (pieces.length) { st.minSize = minSize; st.minArea = minArea; }
  st.pieceVolume = st.area * T;
  return st;
}

function s2Round(v) { return Math.round(v * 100) / 100; }

/* ------------------------------------------------------------------ */
/* Stack                                                               */
/* ------------------------------------------------------------------ */

function s2PlanStack(ctx, o, plan) {
  var axis = o.axes[0], ai = axis === 'x' ? 0 : (axis === 'y' ? 1 : 2), H = ctx.size[ai], T = o.thickness;
  var AX = axis.toUpperCase();
  if (!(H > 0)) throw new Error('The model is flat along the ' + AX + ' direction, so there is nothing to stack. Pick another stack direction.');
  var n = Math.max(1, Math.ceil(H / T - 1e-6));   // round up: a stack a little too tall can be ground down, one too short cannot
  if (n > o.maxPieces) {
    throw new Error('This would need ' + n + ' panels (the model is ' + s2Round(H) + ' mm along ' + AX + ' and the material is ' + T +
      ' mm thick). The limit is ' + o.maxPieces + ' pieces. Use thicker material or make the model smaller.');
  }
  var dh = H / n, slabs = [], i, k, notes = {};
  for (i = 0; i < n; i++) slabs.push({ lo: i * dh, hi: (i + 1) * dh });
  var outlines = s2SlabOutlines(ctx, axis, slabs, o, notes), frame = s2Frame(axis, ctx.size);
  for (i = 0; i < n; i++) {
    var isl = s2Islands(outlines[i]);
    for (k = 0; k < isl.length; k++) {
      plan.pieces.push(s2MakePiece(isl[k], frame, slabs[i].lo, 'Panel ' + (i + 1) + (isl.length > 1 ? s2Letters(k) : ''), axis, i));
    }
  }
  if (notes.gaps) {
    plan.warnings.push(notes.gaps + ' of ' + n + ' panel' + (n === 1 ? '' : 's') + ' had gaps in the outline. The model is not watertight ' +
      '(it has holes or missing faces), so those panels may be missing part of their shape. Repair the model for a clean cut.');
  }
  if (Math.abs(n * T - H) > Math.max(0.1, 0.01 * H)) {
    plan.warnings.push('The welded stack will be ' + s2Round(n * T) + ' mm tall (' + n + ' panel' + (n === 1 ? '' : 's') + ' of ' + T +
      ' mm); the model is ' + s2Round(H) + ' mm along ' + AX + '.');
  }
}

/* ------------------------------------------------------------------ */
/* Grid                                                                */
/* ------------------------------------------------------------------ */

/* Plate positions along an axis of extent E: symmetric about the centre and
 * at least half a thickness clear of the bounding box on both sides. */
function s2PlatePositions(E, T, spacing, clearance) {
  var usable = E - 2 * T, c = E / 2, pos = [], i;
  if (!(usable > 0)) return [c];
  var cnt = Math.floor(usable / spacing + 1e-9) + 1, step = spacing;
  if (cnt < 2 && usable >= 2 * T + clearance) { cnt = 2; step = usable; }
  for (i = 0; i < cnt; i++) pos.push(c + (i - (cnt - 1) / 2) * step);
  return pos;
}

/* One family of parallel plates: positions and outlines before slotting. */
function s2Family(ctx, axis, o, notes) {
  if (ctx.fam[axis]) { if (ctx.fam[axis].gaps) notes.gaps = (notes.gaps || 0) + ctx.fam[axis].gaps; return ctx.fam[axis]; }
  var ai = axis === 'x' ? 0 : (axis === 'y' ? 1 : 2), T = o.thickness;
  var pos = s2PlatePositions(ctx.size[ai], T, o.spacing, o.clearance), slabs = [];
  for (var i = 0; i < pos.length; i++) slabs.push({ lo: pos[i] - T / 2, hi: pos[i] + T / 2 });
  var own = {};
  var fam = { axis: axis, pos: pos, outlines: s2SlabOutlines(ctx, axis, slabs, o, own), frame: s2Frame(axis, ctx.size), gaps: own.gaps || 0 };
  if (fam.gaps) notes.gaps = (notes.gaps || 0) + fam.gaps;
  ctx.fam[axis] = fam;
  return fam;
}

/* Where an even-odd outline has material along the line (plane coordinate
 * `fi` fixed at f).  Returns sorted [lo, hi] pairs of the other coordinate. */
function s2LineIntervals(loops, fi, f) {
  var vi = 1 - fi, ts = [], i, k;
  for (i = 0; i < loops.length; i++) {
    var l = loops[i], n = l.length;
    for (k = 0; k < n; k++) {
      var p = l[k], q = l[(k + 1) % n];
      if ((p[fi] > f) !== (q[fi] > f)) ts.push(p[vi] + (f - p[fi]) * (q[vi] - p[vi]) / (q[fi] - p[fi]));
    }
  }
  ts.sort(function (a, b) { return a - b; });
  var out = [];
  for (i = 0; i + 1 < ts.length; i += 2) if (ts[i + 1] - ts[i] > 1e-6) out.push([ts[i], ts[i + 1]]);
  return out;
}

/* Material along the crossing line, as intervals of the model coordinate c. */
function s2CrossIntervals(fam, loops, bi, pb, ci) {
  var fr = fam.frame, raw = s2LineIntervals(loops, fr.pi[bi], fr.sg[bi] * (pb - fr.of[bi])), out = [];
  for (var i = 0; i < raw.length; i++) {
    var a = fr.of[ci] + fr.sg[ci] * raw[i][0], b = fr.of[ci] + fr.sg[ci] * raw[i][1];
    out.push(a < b ? [a, b] : [b, a]);
  }
  out.sort(function (p, q) { return p[0] - q[0]; });
  return out;
}

/* Slot rectangle in a plate's plane: model axis bi within pb +/- w/2, axis ci from c0 to c1. */
function s2SlotRect(fam, bi, pb, w, ci, c0, c1) {
  var fr = fam.frame, r = [[0, 0], [0, 0], [0, 0], [0, 0]];
  var fb = fr.sg[bi] * (pb - fr.of[bi]), ta = fr.sg[ci] * (c0 - fr.of[ci]), tb = fr.sg[ci] * (c1 - fr.of[ci]);
  var lo = Math.min(ta, tb), hi = Math.max(ta, tb), ib = fr.pi[bi], ic = fr.pi[ci];
  r[0][ib] = fb - w / 2; r[0][ic] = lo;
  r[1][ib] = fb + w / 2; r[1][ic] = lo;
  r[2][ib] = fb + w / 2; r[2][ic] = hi;
  r[3][ib] = fb - w / 2; r[3][ic] = hi;
  return r;
}

function s2PlanGrid(ctx, o, plan) {
  var names = ['x', 'y', 'z'], T = o.thickness, w = T + o.clearance;
  var ai = names.indexOf(o.axes[0]), bi = names.indexOf(o.axes[1]), ci = 3 - ai - bi, i, j, k;
  for (i = 0; i < 3; i++) {
    if (!(ctx.size[i] > 0)) throw new Error('The model is flat along the ' + names[i].toUpperCase() + ' direction, so interlocking plates cannot be made. Use stacked panels instead.');
  }
  if (o.spacing < 2 * T + o.clearance) {
    throw new Error('The plate spacing (' + s2Round(o.spacing) + ' mm) is too small for ' + T + ' mm material. Use at least ' +
      s2Round(2 * T + o.clearance) + ' mm between plates.');
  }
  var nA = s2PlatePositions(ctx.size[ai], T, o.spacing, o.clearance).length;
  var nB = s2PlatePositions(ctx.size[bi], T, o.spacing, o.clearance).length;
  if (nA + nB > o.maxPieces) {
    throw new Error('This would need ' + (nA + nB) + ' plates. The limit is ' + o.maxPieces + ' pieces. Use a wider spacing or make the model smaller.');
  }
  var notes = {};
  var A = s2Family(ctx, o.axes[0], o, notes), B = s2Family(ctx, o.axes[1], o, notes);
  var rectA = [], rectB = [], joints = [], skipped = 0, closed = 0;
  for (i = 0; i < A.pos.length; i++) rectA.push([]);
  for (j = 0; j < B.pos.length; j++) rectB.push([]);
  var far = ctx.size[ci] + 2 * o.allowance + 1;      // "well past the outline"

  for (i = 0; i < A.pos.length; i++) {
    if (!A.outlines[i].length) continue;
    for (j = 0; j < B.pos.length; j++) {
      if (!B.outlines[j].length) continue;
      var ia = s2CrossIntervals(A, A.outlines[i], bi, B.pos[j], ci);
      if (!ia.length) continue;
      var ib = s2CrossIntervals(B, B.outlines[j], ai, A.pos[i], ci);
      for (var p = 0; p < ia.length; p++) {
        for (var q = 0; q < ib.length; q++) {
          var c0 = Math.max(ia[p][0], ib[q][0]), c1 = Math.min(ia[p][1], ib[q][1]);
          if (!(c1 - c0 > 1e-6)) continue;
          if (c1 - c0 < 2 * T) { skipped++; continue; }
          var mid = (c0 + c1) / 2, top, bot, isClosed = false;
          // family A: slot open toward +c
          if (ia[p][1] > c1 + T) { top = c1 + o.clearance / 2; isClosed = true; }
          else top = p + 1 < ia.length ? Math.min(ia[p][1] + far, (ia[p][1] + ia[p + 1][0]) / 2) : ia[p][1] + far;
          // family B: slot open toward -c
          if (ib[q][0] < c0 - T) { bot = c0 - o.clearance / 2; isClosed = true; }
          else bot = q > 0 ? Math.max(ib[q][0] - far, (ib[q][0] + ib[q - 1][1]) / 2) : ib[q][0] - far;
          if (isClosed) closed++;
          rectA[i].push(s2SlotRect(A, bi, B.pos[j], w, ci, mid, top));
          rectB[j].push(s2SlotRect(B, ai, A.pos[i], w, ci, bot, mid));
          joints.push({ a: { axis: A.axis, index: i, pos: A.pos[i] }, b: { axis: B.axis, index: j, pos: B.pos[j] },
                        along: names[ci], c0: c0, c1: c1, mid: mid, width: w, aSlot: [mid, top], bSlot: [bot, mid], closed: isClosed });
        }
      }
    }
  }

  var split = 0, fams = [A, B], rects = [rectA, rectB];
  for (k = 0; k < 2; k++) {
    var F = fams[k], letter = F.axis.toUpperCase();
    for (i = 0; i < F.pos.length; i++) {
      var pre = F.outlines[i];
      if (!pre.length) continue;
      var before = s2Islands(pre).length;
      var cut = rects[k][i].length ? polyBool(pre, rects[k][i], 'subtract') : pre;
      var isl = s2Islands(cut);
      if (isl.length > before) split++;
      for (j = 0; j < isl.length; j++) {
        plan.pieces.push(s2MakePiece(isl[j], F.frame, F.pos[i] - T / 2, letter + (i + 1) + (isl.length > 1 ? s2Letters(j) : ''), F.axis, i));
      }
    }
  }
  plan.joints = joints;
  plan.jointStats = { made: joints.length, skipped: skipped, closed: closed, splitPlates: split };
  if (notes.gaps) {
    plan.warnings.push(notes.gaps + ' plate' + (notes.gaps === 1 ? '' : 's') + ' had gaps in the outline. The model is not watertight ' +
      '(it has holes or missing faces), so those plates may be missing part of their shape. Repair the model for a clean cut.');
  }
  if (skipped) {
    plan.warnings.push(skipped + ' crossing' + (skipped === 1 ? '' : 's') + ' had too little material for a slot (under ' + s2Round(2 * T) +
      ' mm) and ' + (skipped === 1 ? 'was' : 'were') + ' left without one. Trim those corners by hand, or change the spacing.');
  }
  if (closed) {
    plan.warnings.push(closed + ' slot' + (closed === 1 ? ' is' : 's are') + ' closed at the end because one plate has more material there than the other. ' +
      (closed === 1 ? 'That joint' : 'Those joints') + ' may not slide together; try the other pair of directions.');
  }
  if (split) {
    plan.warnings.push(split + ' plate' + (split === 1 ? ' was' : 's were') + ' cut into separate pieces by the slots. The spacing or thickness is too coarse for this model; ' +
      'try thinner material or a different spacing.');
  }
  if (!joints.length && plan.pieces.length) plan.warnings.push('No plates cross each other, so nothing interlocks. Try a smaller spacing.');
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

function s2Options(opts, ctx) {
  opts = opts || {};
  var mode = String(opts.mode == null ? 'stack' : opts.mode).toLowerCase();
  if (mode !== 'stack' && mode !== 'grid') throw new Error('The slicing style must be "stack" or "grid".');
  var axes = opts.axes == null ? (mode === 'stack' ? ['z'] : ['x', 'y']) : opts.axes;
  if (typeof axes === 'string') axes = axes.split('');
  axes = axes.map(function (a) { return String(a).toLowerCase(); });
  var ok = function (a) { return a === 'x' || a === 'y' || a === 'z'; };
  if (mode === 'stack') {
    if (axes.length !== 1 || !ok(axes[0])) throw new Error('The stack direction must be X, Y or Z.');
  } else if (axes.length !== 2 || !ok(axes[0]) || !ok(axes[1]) || axes[0] === axes[1]) {
    throw new Error('Interlocking plates need two different directions out of X, Y and Z.');
  }
  var T = Number(opts.thickness);
  if (!(T > 0) || !isFinite(T)) throw new Error('Enter the material thickness (a number above zero) before slicing.');
  var num = function (v, def, min) { v = v == null ? def : Number(v); return (isFinite(v) && v >= min) ? v : def; };
  var big = Math.max(ctx.size[0], ctx.size[1], ctx.size[2]);
  var o = {
    mode: mode, axes: axes, thickness: T,
    tolerance: num(opts.tolerance, 0.05, 0),
    envelope: opts.envelope == null ? true : !!opts.envelope,
    samples: Math.round(num(opts.samples, 5, 2)),
    allowance: num(opts.allowance, 0, 0),
    spacing: num(opts.spacing, 0, 0),
    clearance: num(opts.clearance, 0.3, 0),
    maxPieces: num(opts.maxPieces, 1500, 1)
  };
  if (!(o.spacing > 0)) o.spacing = Math.max(6 * T, big / 8);
  if (o.samples > 50) o.samples = 50;
  return o;
}

function s2Plan(ctx, opts) {
  var o = s2Options(opts, ctx);
  var plan = { mode: o.mode, axes: o.axes.slice(), thickness: o.thickness, size: ctx.size.slice(), pieces: [], stats: null, warnings: [] };
  if (ctx.mirrored) plan.warnings.push('The scale has a negative value, so the part will come out mirrored.');
  if (o.mode === 'stack') s2PlanStack(ctx, o, plan); else s2PlanGrid(ctx, o, plan);
  if (plan.pieces.length > o.maxPieces) {
    throw new Error('This would make ' + plan.pieces.length + ' pieces. The limit is ' + o.maxPieces +
      '. Use thicker material, a wider spacing or a smaller model.');
  }
  for (var i = 0; i < plan.pieces.length; i++) plan.pieces[i].id = i;
  if (!plan.pieces.length) plan.warnings.push('No outlines were found. The model may be an open surface with no solid volume.');
  plan.stats = s2Stats(plan.pieces, o.thickness);
  return plan;
}

function slicePlan(model, opts) {
  return s2Plan(s2Context(model, opts ? opts.scale : null), opts);
}

function s2Reason(st, sheets, oversize, small, smallLimit, js) {
  var cutM = st.cutLength / 1000;
  var s = st.count + ' piece' + (st.count === 1 ? '' : 's') + ', smallest ' + (st.minSize >= 10 ? Math.round(st.minSize) : Math.round(st.minSize * 10) / 10) +
    ' mm, about ' + (cutM >= 10 ? Math.round(cutM) : Math.round(cutM * 10) / 10) + ' m of cutting, ' +
    (sheets ? 'fits on ' + sheets + ' sheet' + (sheets === 1 ? '' : 's') : 'nothing fits on the bed');
  if (oversize) s += '; ' + oversize + ' piece' + (oversize === 1 ? ' is' : 's are') + ' too big for the bed';
  if (small) s += '; ' + small + ' piece' + (small === 1 ? ' is' : 's are') + ' under ' + Math.round(smallLimit) + ' mm and hard to handle';
  if (js && js.splitPlates) s += '; ' + js.splitPlates + ' plate' + (js.splitPlates === 1 ? ' falls' : 's fall') + ' apart at the slots';
  if (js && js.skipped) s += '; ' + js.skipped + ' crossing' + (js.skipped === 1 ? ' has' : 's have') + ' no room for a slot';
  if (js && js.closed) s += '; ' + js.closed + ' joint' + (js.closed === 1 ? '' : 's') + ' may not slide together';
  return s;
}

function bestPlans(model, opts) {
  opts = opts || {};
  var bedW = Number(opts.bedW), bedH = Number(opts.bedH);
  if (!(bedW > 0) || !(bedH > 0) || !isFinite(bedW) || !isFinite(bedH)) throw new Error('The bed size is not set. Enter the bed width and height.');
  var prefer = opts.prefer === 'solid' || opts.prefer === 'frame' ? opts.prefer : 'any';
  var ctx = s2Context(model, opts.scale);
  var list = [['stack', ['x']], ['stack', ['y']], ['stack', ['z']], ['grid', ['x', 'y']], ['grid', ['x', 'z']], ['grid', ['y', 'z']]];
  var out = [];
  for (var c = 0; c < list.length; c++) {
    var mode = list[c][0], axes = list[c][1], cand = { mode: mode, axes: axes };
    try {
      var o = {};
      for (var key in opts) if (Object.prototype.hasOwnProperty.call(opts, key)) o[key] = opts[key];
      o.mode = mode; o.axes = axes;
      var plan = s2Plan(ctx, o), st = plan.stats, T = plan.thickness;
      if (!st.count) throw new Error('No outlines were found this way.');
      var parts = [], small = 0, smallLimit = Math.max(10, 3 * T), i;
      for (i = 0; i < plan.pieces.length; i++) {
        var p = plan.pieces[i];
        parts.push({ id: p.id, w: p.w, h: p.h });
        if (Math.min(p.w, p.h) < smallLimit) small++;
      }
      var nest = nestParts(parts, { bedW: bedW, bedH: bedH, gap: 6, margin: 3 });
      var sheets = nest.pages.length, oversize = nest.oversize.length, js = plan.jointStats || null;
      var score = st.count + 2 * st.cutLength / 1000 + 4 * sheets;
      if (oversize) score += 1000 + 200 * oversize;
      if (small) score += 300 + 40 * small;
      if (js) score += 100 * js.splitPlates + 10 * Math.min(js.skipped, 20) + 50 * Math.min(js.closed, 10);
      if (mode === 'grid' && js && !js.made) score += 500;
      if ((prefer === 'solid' && mode === 'grid') || (prefer === 'frame' && mode === 'stack')) score += 500;
      cand.stats = st; cand.sheets = sheets; cand.oversize = oversize; cand.small = small; cand.score = score;
      if (js) cand.jointStats = js;
      cand.warnings = plan.warnings;
      cand.reason = s2Reason(st, sheets, oversize, small, smallLimit, js);
    } catch (err) {
      cand.error = String(err && err.message ? err.message : err);
      cand.score = 1e9; cand.sheets = 0; cand.oversize = 0;
      cand.reason = cand.error;
    }
    out.push(cand);
  }
  out.sort(function (a, b) { return a.score - b.score; });
  return out;
}

if (typeof module !== 'undefined') module.exports = { slicePlan, bestPlans };
