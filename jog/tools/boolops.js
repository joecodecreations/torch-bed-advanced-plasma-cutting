/*
 * boolops.js - dependency-free 2D polygon boolean operations (plain ES2017).
 *
 *   polyBool(A, B, op) -> Array of polygons
 *
 * A, B : arrays of closed polygons; a polygon is an array of [x, y] points
 *        (first point not repeated, either winding). Each operand is filled
 *        with the EVEN-ODD rule, so nested polygons are holes / islands.
 * op   : 'union' | 'subtract' (A minus B) | 'intersect' | 'xor'
 * Returns a flat array of closed polygons whose even-odd fill is the result.
 * Outer boundaries come out counter-clockwise (positive shoelace area in a
 * y-up frame) and holes clockwise. Inputs are not mutated.
 *
 * Method: all edges of both operands are split where they cross, touch or
 * overlap; identical sub-edges are merged (so shared / coincident edges are
 * handled exactly, with no perturbation); each unique sub-edge gets the
 * even-odd fill of A and of B on its left and right side from one ray cast;
 * sub-edges whose two sides differ in the result are kept, directed with the
 * result on their left, and stitched into loops.
 */
function polyBool(A, B, op) {
  var EPS = 1e-6;          // points closer than this are the same point
  var COLLINEAR = 1.5e-6;  // midpoints this close to the chord are dropped
  var MIN_AREA = 1e-6;     // polygons smaller than this (mm^2) are dropped

  var inResult;
  if (op === 'union') inResult = function (a, b) { return a || b; };
  else if (op === 'intersect') inResult = function (a, b) { return a && b; };
  else if (op === 'subtract') inResult = function (a, b) { return a && !b; };
  else if (op === 'xor') inResult = function (a, b) { return a !== b; };
  else throw new Error('polyBool: unknown op "' + op + '"');

  // ---- vertices, snapped so that points within EPS share one id ----
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

  // ---- input edges ----
  var eu = [], ev = [], eo = [];
  function addOperand(polys, which) {
    if (!polys) return;
    for (var p = 0; p < polys.length; p++) {
      var poly = polys[p], ids = [], i, id;
      if (!poly || poly.length < 3) continue;
      for (i = 0; i < poly.length; i++) {
        var x = +poly[i][0], y = +poly[i][1];
        if (!isFinite(x) || !isFinite(y)) continue;
        id = vid(x, y);
        if (ids.length === 0 || ids[ids.length - 1] !== id) ids.push(id);
      }
      while (ids.length > 1 && ids[ids.length - 1] === ids[0]) ids.pop();
      if (ids.length < 3) continue;
      for (i = 0; i < ids.length; i++) {
        eu.push(ids[i]); ev.push(ids[(i + 1) % ids.length]); eo.push(which);
      }
    }
  }
  addOperand(A, 0);
  addOperand(B, 1);
  var nE = eu.length;
  if (nE === 0) return [];

  // ---- split every edge against every other edge ----
  var splits = new Array(nE);
  function addSplit(e, v) { if (splits[e]) splits[e].push(v); else splits[e] = [v]; }

  // is vertex p on the open segment a-b (within EPS)?
  function onSeg(p, a, b) {
    var ax = vx[a], ay = vy[a], rx = vx[b] - ax, ry = vy[b] - ay;
    var px = vx[p] - ax, py = vy[p] - ay;
    var len2 = rx * rx + ry * ry;
    var d = px * rx + py * ry;
    if (d <= 0 || d >= len2) return false;
    var c = px * ry - py * rx;
    return c * c <= EPS * EPS * len2;
  }

  function crossPair(i, j) {
    var a = eu[i], b = ev[i], c = eu[j], d = ev[j];
    if ((a === c && b === d) || (a === d && b === c)) return;
    var touch = false;
    if (c !== a && c !== b && onSeg(c, a, b)) { addSplit(i, c); touch = true; }
    if (d !== a && d !== b && onSeg(d, a, b)) { addSplit(i, d); touch = true; }
    if (a !== c && a !== d && onSeg(a, c, d)) { addSplit(j, a); touch = true; }
    if (b !== c && b !== d && onSeg(b, c, d)) { addSplit(j, b); touch = true; }
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
    var p = vid(ax + t * rx, ay + t * ry);
    if (p !== a && p !== b) addSplit(i, p);
    if (p !== c && p !== d) addSplit(j, p);
  }

  var i, j, k, e;
  var loX = new Float64Array(nE), hiX = new Float64Array(nE);
  var loY = new Float64Array(nE), hiY = new Float64Array(nE);
  var order = new Array(nE);
  for (e = 0; e < nE; e++) {
    var x1 = vx[eu[e]], x2 = vx[ev[e]], y1 = vy[eu[e]], y2 = vy[ev[e]];
    loX[e] = (x1 < x2 ? x1 : x2) - EPS; hiX[e] = (x1 < x2 ? x2 : x1) + EPS;
    loY[e] = (y1 < y2 ? y1 : y2) - EPS; hiY[e] = (y1 < y2 ? y2 : y1) + EPS;
    order[e] = e;
  }
  order.sort(function (p, q) { return loX[p] - loX[q]; });
  for (i = 0; i < nE; i++) {
    var ei = order[i], hx = hiX[ei], ly = loY[ei], hy = hiY[ei];
    for (j = i + 1; j < nE; j++) {
      var ej = order[j];
      if (loX[ej] > hx) break;
      if (loY[ej] > hy || hiY[ej] < ly) continue;
      crossPair(ei, ej);
    }
  }

  // ---- unique undirected sub-edges with per-operand parity ----
  var NV = vx.length;
  var segMap = new Map(), su = [], sv = [], sa = [], sb = [];
  function addSeg(p, q, which) {
    if (p === q) return;
    var lo = p < q ? p : q, hi = p < q ? q : p, key = lo * NV + hi;
    var s = segMap.get(key);
    if (s === undefined) {
      s = su.length; segMap.set(key, s);
      su.push(lo); sv.push(hi); sa.push(0); sb.push(0);
    }
    if (which === 0) sa[s] ^= 1; else sb[s] ^= 1;
  }
  for (e = 0; e < nE; e++) {
    var a0 = eu[e], b0 = ev[e], sp = splits[e];
    if (!sp) { addSeg(a0, b0, eo[e]); continue; }
    var ox = vx[a0], oy = vy[a0], dx0 = vx[b0] - ox, dy0 = vy[b0] - oy;
    var items = [];
    for (k = 0; k < sp.length; k++) {
      items.push({ v: sp[k], t: (vx[sp[k]] - ox) * dx0 + (vy[sp[k]] - oy) * dy0 });
    }
    items.sort(function (p, q) { return p.t - q.t; });
    var prev = a0;
    for (k = 0; k < items.length; k++) {
      if (items[k].v === prev || items[k].v === b0) continue;
      addSeg(prev, items[k].v, eo[e]);
      prev = items[k].v;
    }
    addSeg(prev, b0, eo[e]);
  }

  // drop sub-edges that cancelled out in both operands
  var S = [];
  for (k = 0; k < su.length; k++) if (sa[k] || sb[k]) S.push(k);
  var nS = S.length;
  if (nS === 0) return [];

  // ---- band index for axis-aligned ray casts ----
  var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (k = 0; k < nS; k++) {
    var s0 = S[k];
    var xa = vx[su[s0]], xb = vx[sv[s0]], ya = vy[su[s0]], yb = vy[sv[s0]];
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
  var yBands = new Array(nBands), xBands = new Array(nBands);
  for (k = 0; k < nBands; k++) { yBands[k] = []; xBands[k] = []; }
  for (k = 0; k < nS; k++) {
    var s1 = S[k];
    var px1 = vx[su[s1]], px2 = vx[sv[s1]], py1 = vy[su[s1]], py2 = vy[sv[s1]];
    var b1, b2, bb;
    if (py1 !== py2) {
      b1 = bandOf(Math.min(py1, py2), minY, bandH); b2 = bandOf(Math.max(py1, py2), minY, bandH);
      for (bb = b1; bb <= b2; bb++) yBands[bb].push(s1);
    }
    if (px1 !== px2) {
      b1 = bandOf(Math.min(px1, px2), minX, bandW); b2 = bandOf(Math.max(px1, px2), minX, bandW);
      for (bb = b1; bb <= b2; bb++) xBands[bb].push(s1);
    }
  }

  // ---- classify each sub-edge, keep the result boundary (result on the left) ----
  var kFrom = [], kTo = [];
  for (k = 0; k < nS; k++) {
    var s = S[k], u = su[s], v = sv[s];
    var ux = vx[u], uy = vy[u], dx = vx[v] - ux, dy = vy[v] - uy;
    var mx = ux + dx * 0.5, my = uy + dy * 0.5;
    var fa = 0, fb = 0, list, n, o, p1x, p1y, p2x, p2y, rayIsLeft;
    if (Math.abs(dy) >= Math.abs(dx)) {
      // ray towards +x: fill just right of the midpoint in x
      list = yBands[bandOf(my, minY, bandH)];
      for (n = 0; n < list.length; n++) {
        o = list[n];
        if (o === s) continue;
        p1y = vy[su[o]]; p2y = vy[sv[o]];
        if ((p1y > my) === (p2y > my)) continue;
        p1x = vx[su[o]]; p2x = vx[sv[o]];
        if (p1x + (my - p1y) * (p2x - p1x) / (p2y - p1y) > mx) { fa ^= sa[o]; fb ^= sb[o]; }
      }
      rayIsLeft = dy < 0;
    } else {
      // ray towards +y
      list = xBands[bandOf(mx, minX, bandW)];
      for (n = 0; n < list.length; n++) {
        o = list[n];
        if (o === s) continue;
        p1x = vx[su[o]]; p2x = vx[sv[o]];
        if ((p1x > mx) === (p2x > mx)) continue;
        p1y = vy[su[o]]; p2y = vy[sv[o]];
        if (p1y + (mx - p1x) * (p2y - p1y) / (p2x - p1x) > my) { fa ^= sa[o]; fb ^= sb[o]; }
      }
      rayIsLeft = dx > 0;
    }
    var ga = fa ^ sa[s], gb = fb ^ sb[s]; // fills on the other side
    var near = !!inResult(fa === 1, fb === 1), far = !!inResult(ga === 1, gb === 1);
    if (near === far) continue;
    var leftIn = rayIsLeft ? near : far;
    if (leftIn) { kFrom.push(u); kTo.push(v); } else { kFrom.push(v); kTo.push(u); }
  }
  var nK = kFrom.length;
  if (nK === 0) return [];

  // ---- stitch directed edges into loops ----
  var outs = new Map();
  for (k = 0; k < nK; k++) {
    var ol = outs.get(kFrom[k]);
    if (ol) ol.push(k); else outs.set(kFrom[k], [k]);
  }
  var used = new Uint8Array(nK);
  // next edge after `cur`: the sharpest left turn, which keeps loops from
  // crossing themselves where several loops meet at one vertex.
  function nextEdge(cur, start) {
    var at = kTo[cur], cand = outs.get(at);
    if (!cand) return -1;
    if (cand.length === 1) return (cand[0] === start || !used[cand[0]]) ? cand[0] : -1;
    var ix = vx[at] - vx[kFrom[cur]], iy = vy[at] - vy[kFrom[cur]];
    var best = -1, bestTurn = -Infinity, c;
    for (c = 0; c < cand.length; c++) {
      var ce = cand[c];
      if (used[ce] && ce !== start) continue;
      var qx = vx[kTo[ce]] - vx[at], qy = vy[kTo[ce]] - vy[at];
      var turn = Math.atan2(ix * qy - iy * qx, ix * qx + iy * qy);
      if (turn > bestTurn) { bestTurn = turn; best = ce; }
    }
    return best;
  }

  function removable(a, b, c) {
    var abx = b[0] - a[0], aby = b[1] - a[1];
    if (abx * abx + aby * aby <= EPS * EPS) return true;
    var acx = c[0] - a[0], acy = c[1] - a[1];
    var len2 = acx * acx + acy * acy;
    if (len2 <= EPS * EPS) return true; // spike out and back
    var cr = acx * aby - acy * abx;
    return cr * cr <= COLLINEAR * COLLINEAR * len2;
  }

  function cleanLoop(pts) {
    var changed = true, n, out, q;
    while (changed && pts.length >= 3) {
      changed = false; out = []; n = pts.length;
      for (q = 0; q < n; q++) {
        var a = out.length ? out[out.length - 1] : pts[n - 1];
        if (removable(a, pts[q], pts[(q + 1) % n])) { changed = true; continue; }
        out.push(pts[q]);
      }
      pts = out;
    }
    if (pts.length < 3) return null;
    var area2 = 0, per = 0;
    for (q = 0, n = pts.length; q < n; q++) {
      var p = pts[q], r = pts[(q + 1) % n];
      area2 += p[0] * r[1] - r[0] * p[1];
      per += Math.sqrt((r[0] - p[0]) * (r[0] - p[0]) + (r[1] - p[1]) * (r[1] - p[1]));
    }
    var area = Math.abs(area2) * 0.5;
    if (area < MIN_AREA) return null;
    if (2 * area < EPS * per) return null; // sliver: mean width below EPS
    return pts;
  }

  var result = [];
  for (k = 0; k < nK; k++) {
    if (used[k]) continue;
    var loop = [], cur = k, closed = false, guard = 0;
    while (guard++ <= nK) {
      used[cur] = 1;
      loop.push([vx[kFrom[cur]], vy[kFrom[cur]]]);
      var nx = nextEdge(cur, k);
      if (nx === k) { closed = true; break; }
      if (nx < 0) { closed = kTo[cur] === kFrom[k]; break; }
      cur = nx;
    }
    if (!closed) continue;
    var cleaned = cleanLoop(loop);
    if (cleaned) result.push(cleaned);
  }
  return result;
}

if (typeof module !== 'undefined') module.exports = { polyBool };
