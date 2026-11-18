/* slicer.js - "stacked slices" geometry engine.
 *
 * Turns a 3D mesh into a stack of flat outlines, one per sheet of metal, and
 * packs the resulting parts onto the cutting bed.  No DOM, no dependencies,
 * plain ES2017.  Loads as a classic <script> or with require() in Node.
 *
 *   parseModel(arrayBuffer, fileName) -> { tris, count, min, max, format, warnings }
 *   sliceModel(model, opts)           -> { layers, size, count, thickness, stackHeight, modelHeight, warnings }
 *   nestParts(parts, opts)            -> { pages, oversize, leftover, warnings }
 *
 * Every helper is prefixed `sl` so it cannot clash with the page's globals.
 */

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

function slToBytes(src) {
  if (src == null) return null;
  if (typeof ArrayBuffer !== 'undefined') {
    if (src instanceof ArrayBuffer) return new Uint8Array(src);
    if (ArrayBuffer.isView(src)) return new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
  }
  if (typeof src === 'string') {
    var out = new Uint8Array(src.length);
    for (var i = 0; i < src.length; i++) out[i] = src.charCodeAt(i) & 255;
    return out;
  }
  if (typeof src === 'object' && typeof src.byteLength === 'number' && typeof src.slice === 'function') {
    try { return new Uint8Array(src); } catch (e) { return null; }
  }
  return null;
}

function slDecodeText(bytes, start, end) {
  start = start || 0;
  if (end == null || end > bytes.length) end = bytes.length;
  var view = (start === 0 && end === bytes.length) ? bytes : bytes.subarray(start, end);
  if (typeof TextDecoder !== 'undefined') {
    try { return new TextDecoder('utf-8').decode(view); } catch (e) { /* fall through */ }
  }
  var parts = [], CH = 8192;
  for (var i = 0; i < view.length; i += CH) {
    parts.push(String.fromCharCode.apply(null, view.subarray(i, Math.min(view.length, i + CH))));
  }
  return parts.join('');
}

/* Growable Float32 buffer: no giant plain arrays, no spread. */
function slBuf(cap) {
  return { a: new Float32Array(Math.max(9, cap | 0)), n: 0 };
}
function slBufRoom(b, extra) {
  if (b.n + extra <= b.a.length) return;
  var cap = b.a.length * 2;
  while (cap < b.n + extra) cap *= 2;
  var na = new Float32Array(cap);
  na.set(b.a.subarray(0, b.n));
  b.a = na;
}

/* ------------------------------------------------------------------ */
/* 1. parseModel                                                       */
/* ------------------------------------------------------------------ */

function slStlKind(bytes) {
  var len = bytes.length;
  if (len >= 84) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var count = dv.getUint32(80, true);
    if (84 + 50 * count === len) return 'binary';
  }
  // Text sniff: an ASCII STL has no control bytes and mentions "facet".
  var headLen = Math.min(len, 65536), ctrl = false;
  for (var i = 0; i < headLen; i++) {
    var c = bytes[i];
    if (c < 9 || (c > 13 && c < 32 && c !== 27)) { ctrl = true; break; }
  }
  if (!ctrl) {
    var head = slDecodeText(bytes, 0, headLen).toLowerCase();
    if (head.indexOf('facet') >= 0 || /^\s*solid\b/.test(head)) return 'ascii';
  }
  if (len >= 84) return 'binary';     // size does not match the header: damaged, but try
  return null;
}

function slParseStlBinary(bytes, warnings) {
  var len = bytes.length;
  var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  var count = dv.getUint32(80, true);
  var avail = Math.floor((len - 84) / 50);
  if (count > avail) {
    warnings.push('The STL file looks cut short: it says ' + count + ' triangles but only holds ' + avail + '. Read what was there.');
    count = avail;
  } else if (count < avail) {
    if (count === 0) {
      count = avail;
      warnings.push('The STL header gave a triangle count of zero; read ' + avail + ' triangles from the file size instead.');
    } else {
      warnings.push('The STL file has extra data after its ' + count + ' triangles; it was ignored.');
    }
  }
  var b = slBuf(count * 9);
  var a = b.a, o = 0, p = 84;
  for (var t = 0; t < count; t++, p += 50) {
    var q = p + 12;                       // skip the normal
    for (var k = 0; k < 9; k++, q += 4) a[o++] = dv.getFloat32(q, true);
  }
  b.n = o;
  return b;
}

function slParseStlAscii(bytes, warnings) {
  var text = slDecodeText(bytes);
  var b = slBuf(Math.min(4500000, Math.max(900, Math.floor(text.length / 25))));
  var re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi, m;
  while ((m = re.exec(text)) !== null) {
    slBufRoom(b, 3);
    b.a[b.n++] = parseFloat(m[1]);
    b.a[b.n++] = parseFloat(m[2]);
    b.a[b.n++] = parseFloat(m[3]);
  }
  var rem = b.n % 9;
  if (rem) {
    b.n -= rem;
    warnings.push('The STL file ends part-way through a triangle; the incomplete one was dropped.');
  }
  return b;
}

function slParseObj(bytes, warnings) {
  var text = slDecodeText(bytes);
  var verts = slBuf(3000), b = slBuf(9000);
  var nv = 0, badFaces = 0;
  var pos = 0, L = text.length;
  var idx = [];
  while (pos < L) {
    var nl = text.indexOf('\n', pos);
    if (nl < 0) nl = L;
    var c0 = text.charCodeAt(pos), c1 = pos + 1 < nl ? text.charCodeAt(pos + 1) : 32;
    // fast reject: only lines starting (after optional blanks) with "v " or "f " matter
    var s = pos;
    while (s < nl && (c0 === 32 || c0 === 9)) { s++; c0 = text.charCodeAt(s); c1 = s + 1 < nl ? text.charCodeAt(s + 1) : 32; }
    if ((c0 === 118 || c0 === 102) && (c1 === 32 || c1 === 9)) {
      var line = text.substring(s + 2, nl);
      // a trailing backslash continues the line
      while (/\\\s*$/.test(line) && nl < L) {
        var nl2 = text.indexOf('\n', nl + 1);
        if (nl2 < 0) nl2 = L;
        line = line.replace(/\\\s*$/, ' ') + text.substring(nl + 1, nl2);
        nl = nl2;
      }
      var tok = line.trim().split(/\s+/);
      if (c0 === 118) {
        slBufRoom(verts, 3);
        verts.a[verts.n++] = parseFloat(tok[0]);
        verts.a[verts.n++] = parseFloat(tok[1]);
        verts.a[verts.n++] = parseFloat(tok[2]);
        nv++;
      } else {
        idx.length = 0;
        var ok = true;
        for (var i = 0; i < tok.length; i++) {
          if (tok[i] === '' || tok[i].charCodeAt(0) === 35) break;   // '#': rest is a comment
          var vi = parseInt(tok[i], 10);                              // stops at the first '/'
          if (!(vi === vi) || vi === 0) { ok = false; break; }
          vi = vi < 0 ? nv + vi : vi - 1;
          if (vi < 0 || vi >= nv) { ok = false; break; }
          idx.push(vi);
        }
        if (!ok || idx.length < 3) badFaces++;
        else {
          var va = verts.a, i0 = idx[0] * 3;
          slBufRoom(b, (idx.length - 2) * 9);
          var a = b.a, o = b.n;
          for (var k = 1; k + 1 < idx.length; k++) {
            var i1 = idx[k] * 3, i2 = idx[k + 1] * 3;
            a[o++] = va[i0]; a[o++] = va[i0 + 1]; a[o++] = va[i0 + 2];
            a[o++] = va[i1]; a[o++] = va[i1 + 1]; a[o++] = va[i1 + 2];
            a[o++] = va[i2]; a[o++] = va[i2 + 1]; a[o++] = va[i2 + 2];
          }
          b.n = o;
        }
      }
    }
    pos = nl + 1;
  }
  if (badFaces) warnings.push(badFaces + ' face' + (badFaces === 1 ? '' : 's') + ' in the OBJ file could not be read and ' + (badFaces === 1 ? 'was' : 'were') + ' skipped.');
  return b;
}

function parseModel(arrayBuffer, fileName) {
  var bytes = slToBytes(arrayBuffer);
  if (!bytes) throw new Error('Could not read the file. Try exporting the model again as STL or OBJ.');
  if (bytes.length === 0) throw new Error('The file is empty.');
  if (bytes.length > 1024 * 1024 * 1024) throw new Error('The file is too large to open in the browser (over 1 GB). Export a simpler model.');

  var name = String(fileName || '');
  var dot = name.lastIndexOf('.');
  var ext = dot >= 0 ? name.substring(dot + 1).toLowerCase() : '';
  var warnings = [];
  var format = null;

  if (ext === 'stl') {
    var k = slStlKind(bytes);
    if (!k) throw new Error('This STL file is too short to hold a model. Try exporting it again.');
    format = 'stl-' + k;
  } else if (ext === 'obj') {
    format = 'obj';
  } else {
    // unknown or missing extension: look at the content
    var head = '', headLen = Math.min(bytes.length, 65536), ctrl = false;
    for (var i = 0; i < headLen; i++) {
      var c = bytes[i];
      if (c < 9 || (c > 13 && c < 32 && c !== 27)) { ctrl = true; break; }
    }
    if (!ctrl) head = slDecodeText(bytes, 0, headLen);
    var exactBinary = false;
    if (bytes.length >= 84) {
      var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      var cnt = dv.getUint32(80, true);
      exactBinary = cnt > 0 && 84 + 50 * cnt === bytes.length;
    }
    if (exactBinary) format = 'stl-binary';
    else if (head && /(^|\n)\s*facet\s+normal/i.test(head)) format = 'stl-ascii';
    else if (head && /(^|\n)[ \t]*v[ \t]+[-+.\d]/.test(head)) format = 'obj';
    else if (head && /^\s*solid\b/i.test(head)) format = 'stl-ascii';
    else {
      throw new Error((ext ? 'Files of type ".' + ext + '" are not supported. ' : 'This file type is not recognised. ') +
        'Export the model as STL or OBJ and try again.');
    }
  }

  var buf;
  if (format === 'stl-binary') buf = slParseStlBinary(bytes, warnings);
  else if (format === 'stl-ascii') buf = slParseStlAscii(bytes, warnings);
  else buf = slParseObj(bytes, warnings);

  // Bounding box; drop triangles with unusable numbers (compact in place).
  var a = buf.a, n = buf.n, o = 0, dropped = 0;
  var minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (var p = 0; p < n; p += 9) {
    var good = true;
    for (var j = 0; j < 9; j++) { var val = a[p + j]; if (!(val - val === 0)) { good = false; break; } }
    if (!good) { dropped++; continue; }
    if (o !== p) for (j = 0; j < 9; j++) a[o + j] = a[p + j];
    for (j = 0; j < 9; j += 3) {
      var x = a[o + j], y = a[o + j + 1], z = a[o + j + 2];
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (z < minz) minz = z; if (z > maxz) maxz = z;
    }
    o += 9;
  }
  if (dropped) warnings.push(dropped + ' triangle' + (dropped === 1 ? '' : 's') + ' had unreadable numbers and ' + (dropped === 1 ? 'was' : 'were') + ' skipped.');
  var count = o / 9;
  if (count === 0) {
    throw new Error('No triangles were found in this ' + (format === 'obj' ? 'OBJ' : 'STL') +
      ' file. It may be empty, damaged, or hold only points and lines.');
  }
  return {
    tris: a.subarray(0, o),
    count: count,
    min: [minx, miny, minz],
    max: [maxx, maxy, maxz],
    format: format,
    warnings: warnings
  };
}

/* ------------------------------------------------------------------ */
/* 2. sliceModel                                                       */
/* ------------------------------------------------------------------ */

function slSignedArea(pts) {
  var s = 0, n = pts.length;
  for (var i = 0, j = n - 1; i < n; j = i++) s += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return s / 2;
}

function slPointInLoop(x, y, pts) {
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

/* Iterative Ramer-Douglas-Peucker over pts[i0..i1]; marks kept points in keep[]. */
function slRdpMark(pts, i0, i1, tol, keep) {
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
    if (worst > t2) {
      keep[wi] = 1;
      stack.push(a, wi, wi, b);
    }
  }
}

function slDedupe(pts, closed) {
  var out = [], E = 1e-9;
  for (var i = 0; i < pts.length; i++) {
    var p = pts[i];
    if (out.length) {
      var q = out[out.length - 1];
      if (Math.abs(p[0] - q[0]) <= E && Math.abs(p[1] - q[1]) <= E) continue;
    }
    out.push(p);
  }
  if (closed) {
    while (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) <= E &&
           Math.abs(out[0][1] - out[out.length - 1][1]) <= E) out.pop();
  }
  return out;
}

/* Closed simplify.  Anchors are two true extreme points of the loop, so a
 * point that happens to sit mid-edge never survives as a spurious corner. */
function slSimplifyClosed(pts, tol) {
  pts = slDedupe(pts, true);
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
  var keep = new Uint8Array(n + 1);
  var eps = tol > 1e-9 ? tol : 1e-9;
  slRdpMark(ring, 0, b, eps, keep);
  slRdpMark(ring, b, n, eps, keep);
  var out = [];
  for (i = 0; i < n; i++) if (keep[i]) out.push(ring[i]);
  return slDedupe(out, true);
}

function slSimplifyOpen(pts, tol) {
  pts = slDedupe(pts, false);
  var n = pts.length;
  if (n < 3) return pts;
  var keep = new Uint8Array(n);
  slRdpMark(pts, 0, n - 1, tol > 1e-9 ? tol : 1e-9, keep);
  var out = [];
  for (var i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/* Chain loose segments (S holds x0,y0,x1,y1 per segment) into closed loops and
 * open polylines.  Endpoints are merged with a spatial hash at distance eps. */
function slChain(S, ns, eps) {
  var inv = 1 / eps, K = 67108864, e2 = eps * eps;
  var cell = new Map();
  var nx = [], ny = [], ncell = [];        // node coords, next node in the same cell
  var ea = new Int32Array(ns), eb = new Int32Array(ns), ne = 0;

  function node(x, y) {
    var ix = Math.floor(x * inv), iy = Math.floor(y * inv);
    var best = -1, bd = e2;
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
    var key = (ix + 8) * K + (iy + 8), prev = cell.get(key);
    var nid = nx.length;
    nx.push(x); ny.push(y); ncell.push(prev === undefined ? -1 : prev);
    cell.set(key, nid);
    return nid;
  }

  for (var s = 0, p = 0; s < ns; s++, p += 4) {
    var a = node(S[p], S[p + 1]), b = node(S[p + 2], S[p + 3]);
    if (a === b) continue;                 // zero-length
    ea[ne] = a; eb[ne] = b; ne++;
  }

  var nn = nx.length;
  var head = new Int32Array(nn).fill(-1), nxt = new Int32Array(2 * ne), deg = new Int32Array(nn);
  for (var e = 0; e < ne; e++) {
    // half-edge 2e leaves ea[e]; half-edge 2e+1 leaves eb[e]
    nxt[2 * e] = head[ea[e]]; head[ea[e]] = 2 * e;
    nxt[2 * e + 1] = head[eb[e]]; head[eb[e]] = 2 * e + 1;
    deg[ea[e]]++; deg[eb[e]]++;
  }
  var used = new Uint8Array(ne);
  var where = new Int32Array(nn).fill(-1);  // position of a node in the path being walked
  var loops = [], open = [];

  function emit(ids, from, to, list) {
    var pts = new Array(to - from);
    for (var i = from; i < to; i++) pts[i - from] = [nx[ids[i]], ny[ids[i]]];
    list.push(pts);
  }

  function walk(start) {
    var path = [start], cur = start;
    where[start] = 0;
    for (;;) {
      var h = head[cur];
      while (h >= 0 && used[h >> 1]) h = nxt[h];
      head[cur] = h;
      if (h < 0) break;
      used[h >> 1] = 1;
      var other = (h & 1) ? ea[h >> 1] : eb[h >> 1];
      var at = where[other];
      if (at >= 0) {
        // came back onto the path: split off that closed loop and carry on
        if (path.length - at >= 3) emit(path, at, path.length, loops);
        for (var i = at + 1; i < path.length; i++) where[path[i]] = -1;
        path.length = at + 1;
      } else {
        where[other] = path.length;
        path.push(other);
      }
      cur = other;
    }
    if (path.length > 1) emit(path, 0, path.length, open);
    for (var j = 0; j < path.length; j++) where[path[j]] = -1;
  }

  var i;
  for (i = 0; i < nn; i++) if (deg[i] & 1) walk(i);   // loose ends first, so open chains come out whole
  for (i = 0; i < nn; i++) {
    for (;;) {
      var hh = head[i];
      while (hh >= 0 && used[hh >> 1]) hh = nxt[hh];
      head[i] = hh;
      if (hh < 0) break;
      walk(i);
    }
  }
  return { loops: loops, open: open };
}

function sliceModel(model, opts) {
  opts = opts || {};
  if (!model || !model.tris || !(model.tris.length >= 9)) {
    throw new Error('There is no 3D model to slice. Import a model first.');
  }
  var axis = String(opts.axis == null ? 'z' : opts.axis).toLowerCase();
  if (axis !== 'x' && axis !== 'y' && axis !== 'z') throw new Error('The stack direction must be X, Y or Z.');
  var T = Number(opts.thickness);
  if (!(T > 0) || !isFinite(T)) throw new Error('Enter the material thickness (a number above zero) before slicing.');
  var sc = opts.scale == null ? 1 : opts.scale, sx, sy, sz;
  if (Array.isArray(sc)) { sx = Number(sc[0]); sy = Number(sc[1]); sz = Number(sc[2]); }
  else sx = sy = sz = Number(sc);
  if (!isFinite(sx) || !isFinite(sy) || !isFinite(sz) || sx === 0 || sy === 0 || sz === 0) {
    throw new Error('The model scale must be a number other than zero.');
  }
  var simp = opts.tolerance == null ? 0.05 : Number(opts.tolerance);
  if (!(simp >= 0) || !isFinite(simp)) simp = 0.05;
  var maxLayers = opts.maxLayers == null ? 2000 : Number(opts.maxLayers);
  if (!(maxLayers >= 1)) maxLayers = 2000;

  var src = model.tris, nt = Math.floor(src.length / 9);
  var warnings = [];
  var scl = [sx, sy, sz];
  if (sx * sy * sz < 0) warnings.push('The scale has a negative value, so the part will come out mirrored.');

  // Scaled bounding box.
  var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  var i, k, t, c;
  for (i = 0; i < nt * 9; i += 3) {
    for (k = 0; k < 3; k++) {
      c = src[i + k] * scl[k];
      if (c < mn[k]) mn[k] = c;
      if (c > mx[k]) mx[k] = c;
    }
  }
  if (!isFinite(mn[0] + mn[1] + mn[2] + mx[0] + mx[1] + mx[2])) {
    throw new Error('The model has unreadable coordinates. Try exporting it again.');
  }
  var ext = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];

  // Stack axis -> h; in-plane (u, v).  x: (y, z).  z: (x, y).  y: (x, -z):
  // (x, z) alone is a left-handed view from +y and would mirror the part, so v runs
  // down the model's z (v = depth - z).  All three are proper rotations.
  var iu, iv, ih, flipV = false;
  if (axis === 'z') { iu = 0; iv = 1; ih = 2; }
  else if (axis === 'x') { iu = 1; iv = 2; ih = 0; }
  else { iu = 0; iv = 2; ih = 1; flipV = true; }
  var W = ext[iu], D = ext[iv], H = ext[ih];
  var axisName = axis.toUpperCase();
  if (!(H > 0)) throw new Error('The model is flat along the ' + axisName + ' direction, so there is nothing to stack. Pick another stack direction.');

  var n = Math.max(1, Math.round(H / T));
  if (n > maxLayers) {
    throw new Error('This would need ' + n + ' layers (the model is ' + (Math.round(H * 100) / 100) + ' mm tall along ' + axisName +
      ' and the material is ' + T + ' mm thick). The limit is ' + maxLayers + ' layers. Use thicker material or make the model smaller.');
  }
  var dh = H / n;

  // Transformed vertices: (u, v, h) per vertex, mm, bounding-box minimum at the origin.
  var P = new Float64Array(nt * 9);
  var su = scl[iu], sv = scl[iv], sh = scl[ih], ou = mn[iu], ov = mn[iv], oh = mn[ih];
  for (i = 0; i < nt * 9; i += 3) {
    P[i] = src[i + iu] * su - ou;
    var vv = src[i + iv] * sv - ov;
    P[i + 1] = flipV ? D - vv : vv;
    P[i + 2] = src[i + ih] * sh - oh;
  }

  // Bucket triangles by the first layer whose plane could reach them (counting sort),
  // remember the last, then sweep upward keeping an active list.
  var first = new Int32Array(nt), last = new Int32Array(nt), cnt = new Int32Array(n + 1);
  for (t = 0; t < nt; t++) {
    var q = t * 9, h0 = P[q + 2], h1 = P[q + 5], h2 = P[q + 8];
    var lo = h0 < h1 ? (h0 < h2 ? h0 : h2) : (h1 < h2 ? h1 : h2);
    var hi = h0 > h1 ? (h0 > h2 ? h0 : h2) : (h1 > h2 ? h1 : h2);
    var f = Math.floor(lo / dh - 0.5), l = Math.ceil(hi / dh - 0.5);   // one layer generous each way
    if (f < 0) f = 0;
    if (l > n - 1) l = n - 1;
    if (!(hi > lo) || f > l) { first[t] = -1; continue; }             // lies flat, or between planes
    first[t] = f; last[t] = l; cnt[f + 1]++;
  }
  for (i = 0; i < n; i++) cnt[i + 1] += cnt[i];
  var order = new Int32Array(cnt[n]), fill = cnt.slice(0, n);
  for (t = 0; t < nt; t++) if (first[t] >= 0) order[fill[first[t]]++] = t;

  var diag = Math.sqrt(W * W + D * D + H * H);
  var eps = Math.max(1e-6, 1e-5 * diag);
  var openMin = Math.max(simp, 50 * eps);
  var active = new Int32Array(Math.max(1, cnt[n])), na = 0;
  var S = new Float64Array(1024), ns;
  var layers = [], gapLayers = 0;

  for (var li = 0; li < n; li++) {
    var plane = (li + 0.5) * dh;
    for (i = cnt[li]; i < cnt[li + 1]; i++) active[na++] = order[i];
    ns = 0;
    var w = 0;
    for (i = 0; i < na; i++) {
      t = active[i];
      if (last[t] < li) continue;          // finished: drop from the active list
      active[w++] = t;
      var b = t * 9;
      var d0 = P[b + 2] - plane, d1 = P[b + 5] - plane, d2 = P[b + 8] - plane;
      // a vertex exactly on the plane counts as above
      var up = (d0 >= 0 ? 1 : 0) + (d1 >= 0 ? 1 : 0) + (d2 >= 0 ? 1 : 0);
      if (up === 0 || up === 3) continue;
      // the lone vertex is the one on its own side
      var L, A, B, dL, dA, dB;
      if ((d0 >= 0) !== (d1 >= 0) && (d0 >= 0) !== (d2 >= 0)) { L = b; A = b + 3; B = b + 6; dL = d0; dA = d1; dB = d2; }
      else if ((d1 >= 0) !== (d0 >= 0) && (d1 >= 0) !== (d2 >= 0)) { L = b + 3; A = b + 6; B = b; dL = d1; dA = d2; dB = d0; }
      else { L = b + 6; A = b; B = b + 3; dL = d2; dA = d0; dB = d1; }
      if (ns * 4 + 4 > S.length) { var S2 = new Float64Array(S.length * 2); S2.set(S); S = S2; }
      var o = ns * 4;
      // Each crossing is always interpolated from the below vertex to the above one, so
      // the two triangles sharing an edge get bit-identical points.
      for (k = 0; k < 2; k++) {
        var X = k ? B : A, dX = k ? dB : dA;
        var lowI, highI, dLow, dHigh;
        if (dL < 0) { lowI = L; dLow = dL; highI = X; dHigh = dX; }
        else { lowI = X; dLow = dX; highI = L; dHigh = dL; }
        if (dHigh === 0) { S[o++] = P[highI]; S[o++] = P[highI + 1]; }
        else {
          var tt = dLow / (dLow - dHigh);
          S[o++] = P[lowI] + tt * (P[highI] - P[lowI]);
          S[o++] = P[lowI + 1] + tt * (P[highI + 1] - P[lowI + 1]);
        }
      }
      ns++;
    }
    na = w;
    if (ns === 0) continue;

    var ch = slChain(S, ns, eps);
    var loops = [], opens = [], j;
    for (j = 0; j < ch.loops.length; j++) {
      var lp = slSimplifyClosed(ch.loops[j], simp);
      if (lp.length < 3) continue;
      if (Math.abs(slSignedArea(lp)) < 0.01) continue;
      loops.push(lp);
    }
    for (j = 0; j < ch.open.length; j++) {
      var raw = ch.open[j], len = 0;
      for (k = 1; k < raw.length; k++) len += Math.sqrt((raw[k][0] - raw[k - 1][0]) * (raw[k][0] - raw[k - 1][0]) + (raw[k][1] - raw[k - 1][1]) * (raw[k][1] - raw[k - 1][1]));
      if (len <= openMin) continue;
      var op = slSimplifyOpen(raw, simp);
      if (op.length >= 2) opens.push(op);
    }
    if (opens.length) gapLayers++;
    if (!loops.length && !opens.length) continue;

    // bounding boxes and even-odd area
    var lmin = [Infinity, Infinity], lmax = [-Infinity, -Infinity];
    var boxes = [];
    for (j = 0; j < loops.length + opens.length; j++) {
      var pl = j < loops.length ? loops[j] : opens[j - loops.length];
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (k = 0; k < pl.length; k++) {
        var px = pl[k][0], py = pl[k][1];
        if (px < x0) x0 = px; if (px > x1) x1 = px;
        if (py < y0) y0 = py; if (py > y1) y1 = py;
      }
      if (j < loops.length) boxes.push([x0, y0, x1, y1]);
      if (x0 < lmin[0]) lmin[0] = x0; if (y0 < lmin[1]) lmin[1] = y0;
      if (x1 > lmax[0]) lmax[0] = x1; if (y1 > lmax[1]) lmax[1] = y1;
    }
    var area = 0;
    for (j = 0; j < loops.length; j++) {
      var depth = 0, tx = loops[j][0][0], ty = loops[j][0][1];
      for (k = 0; k < loops.length; k++) {
        if (k === j) continue;
        var bx = boxes[k];
        if (tx < bx[0] || tx > bx[2] || ty < bx[1] || ty > bx[3]) continue;
        if (slPointInLoop(tx, ty, loops[k])) depth++;
      }
      var ar = Math.abs(slSignedArea(loops[j]));
      area += (depth & 1) ? -ar : ar;
    }
    layers.push({ index: li, height: plane, loops: loops, open: opens, area: area, min: lmin, max: lmax });
  }

  if (gapLayers) {
    warnings.push(gapLayers + ' of ' + n + ' layer' + (n === 1 ? '' : 's') + ' had gaps in the outline. The model is not watertight ' +
      '(it has holes or missing faces), so those layers may be missing part of their shape. Repair the model for a clean cut.');
  }
  var stackHeight = n * T;
  if (Math.abs(stackHeight - H) > Math.max(0.1, 0.01 * H)) {
    warnings.push('The welded stack will be ' + (Math.round(stackHeight * 100) / 100) + ' mm tall (' + n + ' layer' + (n === 1 ? '' : 's') +
      ' of ' + T + ' mm); the model is ' + (Math.round(H * 100) / 100) + ' mm tall.');
  }
  if (!layers.length) warnings.push('No outlines were found. The model may be an open surface with no solid volume.');

  return {
    layers: layers,
    size: [W, D, H],
    count: n,
    thickness: T,
    stackHeight: stackHeight,
    modelHeight: H,
    axis: axis,
    warnings: warnings
  };
}

/* ------------------------------------------------------------------ */
/* 3. nestParts  (MaxRects, best-short-side-fit)                       */
/* ------------------------------------------------------------------ */

/* Best free rectangle for a w x h part.  mode 0: best short side fit,
 * 1: bottom-left, 2: best area fit.  Lower (s, l) is better. */
function slNestFind(free, w, h, mode) {
  var E = 1e-9, best = null, bs = Infinity, bl = Infinity;
  for (var i = 0; i < free.length; i++) {
    var f = free[i];
    if (w <= f.w + E && h <= f.h + E) {
      var rw = f.w - w, rh = f.h - h, s, l;
      if (mode === 1) { s = f.y + h; l = f.x; }
      else if (mode === 2) { s = f.w * f.h - w * h; l = rw < rh ? rw : rh; }
      else { s = rw < rh ? rw : rh; l = rw < rh ? rh : rw; }
      if (s < bs - E || (s <= bs + E && (l < bl - E ||
          (l <= bl + E && best && (f.y < best.y - E || (f.y <= best.y + E && f.x < best.x - E)))))) {
        best = f; bs = s; bl = l;
      }
    }
  }
  return best ? { x: best.x, y: best.y, s: bs, l: bl } : null;
}

function slNestPlace(free, x, y, w, h) {
  var E = 1e-9, out = [], i, j;
  for (i = 0; i < free.length; i++) {
    var f = free[i];
    if (x >= f.x + f.w - E || x + w <= f.x + E || y >= f.y + f.h - E || y + h <= f.y + E) { out.push(f); continue; }
    if (x > f.x + E) out.push({ x: f.x, y: f.y, w: x - f.x, h: f.h });
    if (x + w < f.x + f.w - E) out.push({ x: x + w, y: f.y, w: f.x + f.w - (x + w), h: f.h });
    if (y > f.y + E) out.push({ x: f.x, y: f.y, w: f.w, h: y - f.y });
    if (y + h < f.y + f.h - E) out.push({ x: f.x, y: y + h, w: f.w, h: f.y + f.h - (y + h) });
  }
  // prune rectangles contained in another
  var dead = new Uint8Array(out.length);
  for (i = 0; i < out.length; i++) {
    if (dead[i]) continue;
    var a = out[i];
    for (j = 0; j < out.length; j++) {
      if (i === j || dead[j]) continue;
      var b = out[j];
      if (b.x >= a.x - E && b.y >= a.y - E && b.x + b.w <= a.x + a.w + E && b.y + b.h <= a.y + a.h + E) dead[j] = 1;
    }
  }
  var res = [];
  for (i = 0; i < out.length; i++) if (!dead[i]) res.push(out[i]);
  return res;
}

function nestParts(parts, opts) {
  opts = opts || {};
  var bedW = Number(opts.bedW), bedH = Number(opts.bedH);
  if (!(bedW > 0) || !(bedH > 0) || !isFinite(bedW) || !isFinite(bedH)) throw new Error('The bed size is not set. Enter the bed width and height.');
  var gap = opts.gap == null ? 5 : Number(opts.gap);
  var margin = opts.margin == null ? 5 : Number(opts.margin);
  if (!(gap >= 0) || !isFinite(gap)) gap = 5;
  if (!(margin >= 0) || !isFinite(margin)) margin = 5;
  var rotate = opts.rotate == null ? true : !!opts.rotate;
  var onePage = !!opts.onePage;
  var W = bedW - 2 * margin, H = bedH - 2 * margin;
  if (!(W > 0) || !(H > 0)) throw new Error('The edge margin is too big for this bed: no room is left to place parts.');

  var E = 1e-9, warnings = [], oversize = [], leftover = [], pages = [], work = [];
  var list = [], skipped = 0, i;
  parts = parts || [];
  for (i = 0; i < parts.length; i++) {
    var p = parts[i];
    var w = p ? Number(p.w) : NaN, h = p ? Number(p.h) : NaN;
    if (!(w > 0) || !(h > 0) || !isFinite(w) || !isFinite(h)) { skipped++; continue; }
    var fits0 = w <= W + E && h <= H + E, fits90 = rotate && h <= W + E && w <= H + E;
    if (!fits0 && !fits90) { oversize.push(p.id); continue; }
    list.push({ id: p.id, w: w, h: h, i: i, fits0: fits0, fits90: fits90 });
  }
  if (skipped) warnings.push(skipped + ' part' + (skipped === 1 ? '' : 's') + ' had no size and ' + (skipped === 1 ? 'was' : 'were') + ' left out.');
  if (oversize.length) {
    warnings.push(oversize.length + ' part' + (oversize.length === 1 ? ' is' : 's are') + ' too big for the bed (' +
      bedW + ' x ' + bedH + ' mm with a ' + margin + ' mm margin) and ' + (oversize.length === 1 ? 'was' : 'were') + ' not placed.');
  }

  // large first: longest side, then area, then input order (stable and deterministic)
  list.sort(function (a, b) {
    var la = a.w > a.h ? a.w : a.h, lb = b.w > b.h ? b.w : b.h;
    if (la !== lb) return lb - la;
    var aa = a.w * a.h, ab = b.w * b.h;
    if (aa !== ab) return ab - aa;
    return a.i - b.i;
  });

  // Each part is grown by the gap and so is the sheet, which keeps parts a full
  // gap apart while still letting them sit right on the margin line.
  var BW = W + gap, BH = H + gap;
  function run(mode) {
    var work = [], left = [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i], placed = false;
      for (var pg = 0; pg <= work.length && !placed; pg++) {
        if (pg === work.length) {
          if (onePage && work.length >= 1) break;
          work.push({ free: [{ x: 0, y: 0, w: BW, h: BH }], items: [] });
        }
        var page = work[pg];
        var c0 = it.fits0 ? slNestFind(page.free, it.w + gap, it.h + gap, mode) : null;
        var c9 = it.fits90 && it.w !== it.h ? slNestFind(page.free, it.h + gap, it.w + gap, mode) : null;
        var use = null, rot = 0;
        if (c0 && c9) {
          if (c9.s < c0.s - E || (c9.s <= c0.s + E && c9.l < c0.l - E)) { use = c9; rot = 90; } else use = c0;
        } else if (c0) use = c0;
        else if (c9) { use = c9; rot = 90; }
        if (!use) continue;
        var pw = rot ? it.h : it.w, ph = rot ? it.w : it.h;
        page.free = slNestPlace(page.free, use.x, use.y, pw + gap, ph + gap);
        page.items.push({ id: it.id, x: margin + use.x, y: margin + use.y, w: pw, h: ph, rot: rot });
        placed = true;
      }
      if (!placed) left.push(it.id);
    }
    return { work: work, left: left };
  }
  // Try three placement rules and keep the tightest result: fewest parts left
  // over, then fewest sheets, then the emptiest last sheet.
  var bestRun = null, bestKey = null;
  for (var mode = 0; mode < 3; mode++) {
    var r = run(mode), lastArea = 0;
    if (r.work.length) {
      var li = r.work[r.work.length - 1].items;
      for (i = 0; i < li.length; i++) lastArea += li[i].w * li[i].h;
    }
    var key = [r.left.length, r.work.length, lastArea];
    if (!bestRun || key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] ||
        (key[1] === bestKey[1] && key[2] < bestKey[2] - 1e-6)))) { bestRun = r; bestKey = key; }
  }
  work = bestRun.work; leftover = bestRun.left;
  for (i = 0; i < work.length; i++) pages.push({ items: work[i].items });
  if (leftover.length) {
    warnings.push(leftover.length + ' part' + (leftover.length === 1 ? ' does' : 's do') + ' not fit on one sheet and ' +
      (leftover.length === 1 ? 'was' : 'were') + ' left off.');
  }
  return { pages: pages, oversize: oversize, leftover: leftover, warnings: warnings };
}

if (typeof module !== 'undefined') module.exports = { parseModel, sliceModel, nestParts };
