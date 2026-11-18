/* Finishing: what has to be removed from the welded pieces to reach the real model, side by side.
 *
 * Both shapes are turned into small cubes ("voxels"). Working from one side at a time, everything
 * that side can reach in a straight line, and that is not part of the model, is removed. The result
 * for each side is a depth map: how deep to go at every point.
 *
 *   fnVoxelize(asm, mesh, maxCells) -> grid
 *   fnCarve(grid, sides, limit)     -> { maps, excess, left, shortfall, cell }
 */
var FN_SIDES = {
  // ray: axis the tool travels along, dir +1 = from the low end; u/v: axes across and up the map as you look at that side
  top:    { ray: 2, dir: -1, u: 0, fu: false, v: 1, label: 'Top' },
  bottom: { ray: 2, dir: 1,  u: 0, fu: true,  v: 1, label: 'Bottom' },
  front:  { ray: 1, dir: 1,  u: 0, fu: false, v: 2, label: 'Front' },
  back:   { ray: 1, dir: -1, u: 0, fu: true,  v: 2, label: 'Back' },
  left:   { ray: 0, dir: 1,  u: 1, fu: true,  v: 2, label: 'Left' },
  right:  { ray: 0, dir: -1, u: 1, fu: false, v: 2, label: 'Right' }
};

function fnVoxelize(asm, mesh, maxCells) {
  maxCells = maxCells || 220;
  var T = asm.thickness, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], i, k, a;
  // bounds of the model and of every piece
  for (i = 0; i < mesh.length; i++) { k = i % 3; if (mesh[i] < lo[k]) lo[k] = mesh[i]; if (mesh[i] > hi[k]) hi[k] = mesh[i]; }
  asm.pieces.forEach(function (pc) {
    var corners = [[0, 0, 0], [pc.w, 0, 0], [0, pc.h, 0], [pc.w, pc.h, 0], [0, 0, T], [pc.w, 0, T], [0, pc.h, T], [pc.w, pc.h, T]];
    corners.forEach(function (c) {
      for (var j = 0; j < 3; j++) {
        var w = pc.origin[j] + pc.u[j] * c[0] + pc.v[j] * c[1] + pc.n[j] * c[2];
        if (w < lo[j]) lo[j] = w; if (w > hi[j]) hi[j] = w;
      }
    });
  });
  var span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1e-6), r = span / maxCells;
  lo = lo.map(function (v) { return v - r; });                       // one empty cell all round
  var n = [0, 1, 2].map(function (j) { return Math.max(1, Math.ceil((hi[j] - lo[j]) / r) + 1); });
  var nx = n[0], ny = n[1], nz = n[2], total = nx * ny * nz;
  var stack = new Uint8Array(total), model = new Uint8Array(total);

  // ---- the model: for each upright column, find where the surface is crossed and fill in between
  var cols = new Array(nx * ny), nt = Math.floor(mesh.length / 9), JIT = 1.37e-4 * r;
  for (i = 0; i < nt; i++) {
    var b = i * 9, x0 = mesh[b], y0 = mesh[b + 1], z0 = mesh[b + 2], x1 = mesh[b + 3], y1 = mesh[b + 4], z1 = mesh[b + 5], x2 = mesh[b + 6], y2 = mesh[b + 7], z2 = mesh[b + 8];
    var den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    if (Math.abs(den) < 1e-12) continue;                              // edge-on to this direction
    var ia = Math.max(0, Math.floor((Math.min(x0, x1, x2) - lo[0]) / r - .5)), ib = Math.min(nx - 1, Math.ceil((Math.max(x0, x1, x2) - lo[0]) / r));
    var ja = Math.max(0, Math.floor((Math.min(y0, y1, y2) - lo[1]) / r - .5)), jb = Math.min(ny - 1, Math.ceil((Math.max(y0, y1, y2) - lo[1]) / r));
    for (var jy = ja; jy <= jb; jy++) {
      var py = lo[1] + (jy + .5) * r + JIT * 1.7;
      for (var ix = ia; ix <= ib; ix++) {
        var px = lo[0] + (ix + .5) * r + JIT;
        var w0 = ((y1 - y2) * (px - x2) + (x2 - x1) * (py - y2)) / den, w1 = ((y2 - y0) * (px - x2) + (x0 - x2) * (py - y2)) / den, w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        var c = ix + nx * jy;
        (cols[c] || (cols[c] = [])).push(w0 * z0 + w1 * z1 + w2 * z2);
      }
    }
  }
  for (var c2 = 0; c2 < cols.length; c2++) {
    var zs = cols[c2];
    if (!zs || zs.length < 2) continue;
    zs.sort(function (p, q) { return p - q; });
    for (k = 0; k + 1 < zs.length; k += 2) {
      var ka = Math.max(0, Math.ceil((zs[k] - lo[2]) / r - .5)), kb = Math.min(nz - 1, Math.floor((zs[k + 1] - lo[2]) / r - .5));
      for (var kz = ka; kz <= kb; kz++) model[c2 + nx * ny * kz] = 1;
    }
  }

  // ---- the pieces: each is a flat outline with a thickness, lying along one of the three axes
  asm.pieces.forEach(function (pc) {
    var an = 0, au = 0, av = 0, j;
    for (j = 1; j < 3; j++) { if (Math.abs(pc.n[j]) > Math.abs(pc.n[an])) an = j; if (Math.abs(pc.u[j]) > Math.abs(pc.u[au])) au = j; if (Math.abs(pc.v[j]) > Math.abs(pc.v[av])) av = j; }
    var su = pc.u[au] < 0 ? -1 : 1, sv = pc.v[av] < 0 ? -1 : 1, sn = pc.n[an] < 0 ? -1 : 1;
    var s0 = pc.origin[an], s1 = s0 + sn * T, sl = Math.min(s0, s1), sh = Math.max(s0, s1);
    var la = Math.max(0, Math.ceil((sl - lo[an]) / r - .5)), lb = Math.min(n[an] - 1, Math.floor((sh - lo[an]) / r - .5 - 1e-9));
    if (lb < la) lb = la = Math.min(n[an] - 1, Math.max(0, Math.round(((sl + sh) / 2 - lo[an]) / r - .5)));   // thinner than a cell: still one layer
    var step = [1, nx, nx * ny];
    var v0 = pc.origin[av], v1 = v0 + sv * pc.h, ra = Math.max(0, Math.floor((Math.min(v0, v1) - lo[av]) / r)), rb = Math.min(n[av] - 1, Math.ceil((Math.max(v0, v1) - lo[av]) / r));
    for (var jv = ra; jv <= rb; jv++) {
      var q = ((lo[av] + (jv + .5) * r) - v0) * sv + 1.1e-5 * r, xs = [];
      pc.loops.forEach(function (lp) {
        for (var e = 0; e < lp.length; e++) {
          var p1 = lp[e], p2 = lp[(e + 1) % lp.length];
          if ((p1[1] > q) !== (p2[1] > q)) xs.push(p1[0] + (q - p1[1]) / (p2[1] - p1[1]) * (p2[0] - p1[0]));
        }
      });
      xs.sort(function (p, q2) { return p - q2; });
      for (var e2 = 0; e2 + 1 < xs.length; e2 += 2) {
        var wa = pc.origin[au] + su * xs[e2], wb = pc.origin[au] + su * xs[e2 + 1], wl = Math.min(wa, wb), wh = Math.max(wa, wb);
        var ca = Math.max(0, Math.ceil((wl - lo[au]) / r - .5)), cb = Math.min(n[au] - 1, Math.floor((wh - lo[au]) / r - .5));
        for (var cu = ca; cu <= cb; cu++) for (var ln = la; ln <= lb; ln++) stack[cu * step[au] + jv * step[av] + ln * step[an]] = 1;
      }
    }
  });
  return { n: n, r: r, lo: lo, stack: stack, model: model };
}

// limit (optional, mm): the deepest a side may go below the first metal it meets, for tools that cannot reach far
function fnCarve(grid, sides, limit) {
  var maxSteps = limit > 0 ? Math.max(1, Math.round(limit / grid.r)) : Infinity;
  var n = grid.n, r = grid.r, nx = n[0], ny = n[1], step = [1, nx, nx * ny], total = nx * ny * n[2];
  var cur = new Uint8Array(grid.stack), model = grid.model, i, excess = 0, shortfall = 0, stackCount = 0;
  for (i = 0; i < total; i++) { if (cur[i]) { stackCount++; if (!model[i]) excess++; } else if (model[i]) shortfall++; }
  var maps = sides.map(function (name) {
    var S = FN_SIDES[name], w = n[S.u], h = n[S.v], len = n[S.ray];
    var depth = new Float32Array(w * h), through = new Uint8Array(w * h), solid = new Uint8Array(w * h), removed = 0, maxDepth = 0;
    for (var j = 0; j < h; j++) {
      var iv = h - 1 - j;                                             // row 0 of the map is the top
      for (var x = 0; x < w; x++) {
        var iu = S.fu ? w - 1 - x : x, base = iu * step[S.u] + iv * step[S.v], first = -1, last = -1, hitModel = false;
        for (var t = 0; t < len; t++) {
          var k = S.dir > 0 ? t : len - 1 - t, idx = base + k * step[S.ray];
          if (model[idx]) { hitModel = true; if (first < 0 && cur[idx]) solid[x + w * j] = 1; break; }
          if (first >= 0 && t - first >= maxSteps) break;              // as deep as this side is allowed to go
          if (cur[idx]) { if (first < 0) first = t; last = t; cur[idx] = 0; removed++; }
        }
        if (first >= 0) {
          var d = (last - first + 1) * r;
          depth[x + w * j] = d; solid[x + w * j] = 1;
          if (!hitModel) through[x + w * j] = 1;
          if (d > maxDepth) maxDepth = d;
        }
      }
    }
    return { side: name, label: S.label, w: w, h: h, depth: depth, through: through, solid: solid, removed: removed, volume: removed * r * r * r, maxDepth: maxDepth };
  });
  var left = 0;
  for (i = 0; i < total; i++) if (cur[i] && !model[i]) left++;
  var v = r * r * r;
  return { maps: maps, cell: r, excess: excess * v, left: left * v, shortfall: shortfall * v, stackVolume: stackCount * v };
}

if (typeof module !== 'undefined') module.exports = { fnVoxelize, fnCarve, FN_SIDES };
