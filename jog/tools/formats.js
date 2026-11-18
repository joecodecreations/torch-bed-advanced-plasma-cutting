/* formats.js - extra 3D file formats for the "stacked slices" importer.
 *
 * Loads AFTER slicer.js (classic <script>, or require() in Node).  No DOM, no
 * dependencies, no network, plain ES2017.
 *
 *   MODEL_FORMATS                         -> [{ ext, name }, ...] everything parseModelAny reads
 *   parseModelAny(arrayBuffer, fileName)  -> Promise of { tris, count, min, max, format, warnings, units }
 *
 * The result has the same shape as parseModel() in slicer.js, plus `units`
 * ('mm' | 'cm' | 'm' | 'in' | 'ft' | null) when the file says what it was drawn in.
 * Coordinates stay in the file's own units (micron files are returned in mm).
 *
 * Reads: STL and OBJ (handed to parseModel), GLB / glTF, 3MF, PLY, OFF, AMF and
 * DXF files that hold 3D faces.
 *
 * Every helper is prefixed `fm` so it cannot clash with the page's globals.
 */

if (typeof module !== 'undefined' && typeof parseModel === 'undefined') { var { parseModel } = require('./slicer.js'); }

var MODEL_FORMATS = [
  { ext: 'stl', name: 'STL' },
  { ext: 'obj', name: 'Wavefront OBJ' },
  { ext: 'glb', name: 'glTF binary' },
  { ext: 'gltf', name: 'glTF' },
  { ext: '3mf', name: '3MF' },
  { ext: 'ply', name: 'PLY' },
  { ext: 'off', name: 'OFF' },
  { ext: 'amf', name: 'AMF' },
  { ext: 'dxf', name: 'DXF (3D faces)' }
];

/* Formats the app converts somewhere else: the error carries needsConvert = true. */
var fmConvertNames = {
  blend: 'Blender', fbx: 'FBX', dae: 'Collada (DAE)', step: 'STEP', stp: 'STEP', iges: 'IGES', igs: 'IGES',
  f3d: 'Fusion 360 (F3D)', sat: 'ACIS SAT', '3ds': '3D Studio (3DS)', usd: 'USD', usdz: 'USDZ', x3d: 'X3D'
};

var fmMaxTriangles = 30000000;

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

function fmBytes(src) {
  if (src == null) return null;
  if (src instanceof ArrayBuffer) return new Uint8Array(src);
  if (ArrayBuffer.isView(src)) return new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
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

function fmText(bytes, start, end) {
  start = start || 0;
  if (end == null || end > bytes.length) end = bytes.length;
  var view = (start === 0 && end === bytes.length) ? bytes : bytes.subarray(start, end);
  if (view.length > 500 * 1024 * 1024) {
    throw new Error('The text inside this file is too large to read in the browser. Export a simpler model, or use a binary format such as GLB or binary STL.');
  }
  if (typeof TextDecoder !== 'undefined') {
    try { return new TextDecoder('utf-8').decode(view); } catch (e) { /* fall through */ }
  }
  var parts = [], CH = 8192;
  for (var i = 0; i < view.length; i += CH) {
    parts.push(String.fromCharCode.apply(null, view.subarray(i, Math.min(view.length, i + CH))));
  }
  return parts.join('');
}

/* Growable typed buffers: no giant plain arrays, no spread. */
function fmGrow(Type, cap) {
  return { a: new Type(Math.max(16, cap | 0)), n: 0 };
}
function fmNeed(g, extra) {
  if (g.n + extra <= g.a.length) return;
  var cap = g.a.length * 2;
  while (cap < g.n + extra) cap *= 2;
  var na = new g.a.constructor(cap);
  na.set(g.a.subarray(0, g.n));
  g.a = na;
}

/* Triangle output: 9 floats per triangle.  `bad` counts faces that pointed at
 * a vertex that does not exist. */
function fmOut(capTris) {
  var cap = Math.min(Math.max(capTris | 0, 64), 4000000) * 9;
  return { a: new Float32Array(cap), n: 0, bad: 0 };
}
function fmOutRoom(out, floats) {
  if (out.n + floats > fmMaxTriangles * 9) {
    throw new Error('This model has more than ' + (fmMaxTriangles / 1000000) + ' million triangles, which is too detailed to open in the browser. Export a simpler model.');
  }
  fmNeed(out, floats);
}

/* Affine transforms: 12 numbers, x' = A0 x + A1 y + A2 z + A3, and so on. */
function fmAffIdent() { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]; }
function fmAffMul(P, C) {            // apply C first, then P
  var r = new Array(12);
  for (var i = 0; i < 3; i++) {
    var p0 = P[i * 4], p1 = P[i * 4 + 1], p2 = P[i * 4 + 2];
    r[i * 4] = p0 * C[0] + p1 * C[4] + p2 * C[8];
    r[i * 4 + 1] = p0 * C[1] + p1 * C[5] + p2 * C[9];
    r[i * 4 + 2] = p0 * C[2] + p1 * C[6] + p2 * C[10];
    r[i * 4 + 3] = p0 * C[3] + p1 * C[7] + p2 * C[11] + P[i * 4 + 3];
  }
  return r;
}
function fmAffDet(A) {
  return A[0] * (A[5] * A[10] - A[6] * A[9]) - A[1] * (A[4] * A[10] - A[6] * A[8]) + A[2] * (A[4] * A[9] - A[5] * A[8]);
}

/* Write indexed triangles (I holds 3 vertex numbers per triangle) through the
 * transform A.  A mirrored transform flips the winding so faces stay outward. */
function fmEmit(out, V, nv, I, ni, A) {
  var T = V, i;
  if (A) {
    T = new Float32Array(nv * 3);
    for (i = 0; i < nv * 3; i += 3) {
      var x = V[i], y = V[i + 1], z = V[i + 2];
      T[i] = A[0] * x + A[1] * y + A[2] * z + A[3];
      T[i + 1] = A[4] * x + A[5] * y + A[6] * z + A[7];
      T[i + 2] = A[8] * x + A[9] * y + A[10] * z + A[11];
    }
  }
  var flip = A ? fmAffDet(A) < 0 : false;
  ni -= ni % 3;
  fmOutRoom(out, ni * 3);
  var a = out.a, o = out.n;
  for (i = 0; i < ni; i += 3) {
    var i0 = I[i], i1 = I[i + 1], i2 = I[i + 2];
    if (!(i0 < nv && i1 < nv && i2 < nv) || i0 < 0 || i1 < 0 || i2 < 0) { out.bad++; continue; }
    if (flip) { var t = i1; i1 = i2; i2 = t; }
    i0 *= 3; i1 *= 3; i2 *= 3;
    a[o++] = T[i0]; a[o++] = T[i0 + 1]; a[o++] = T[i0 + 2];
    a[o++] = T[i1]; a[o++] = T[i1 + 1]; a[o++] = T[i1 + 2];
    a[o++] = T[i2]; a[o++] = T[i2 + 1]; a[o++] = T[i2 + 2];
  }
  out.n = o;
}

/* Bounding box; drop triangles that are flat or have unusable numbers
 * (compact in place); build the result object. */
function fmFinish(out, format, label, units, warnings) {
  var a = out.a, n = out.n, o = 0, dropped = 0, j;
  var minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (var p = 0; p < n; p += 9) {
    var x0 = a[p], y0 = a[p + 1], z0 = a[p + 2];
    var ux = a[p + 3] - x0, uy = a[p + 4] - y0, uz = a[p + 5] - z0;
    var vx = a[p + 6] - x0, vy = a[p + 7] - y0, vz = a[p + 8] - z0;
    var cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    var c2 = cx * cx + cy * cy + cz * cz;
    var lim = 1e-14 * (ux * ux + uy * uy + uz * uz) * (vx * vx + vy * vy + vz * vz);
    // NaN / Infinity anywhere makes c2 NaN, which fails this test too
    if (!(c2 > lim) || !(c2 - c2 === 0) || !(x0 + y0 + z0 - (x0 + y0 + z0) === 0)) { dropped++; continue; }
    if (o !== p) for (j = 0; j < 9; j++) a[o + j] = a[p + j];
    for (j = 0; j < 9; j += 3) {
      var x = a[o + j], y = a[o + j + 1], z = a[o + j + 2];
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (z < minz) minz = z; if (z > maxz) maxz = z;
    }
    o += 9;
  }
  if (out.bad) {
    warnings.push(out.bad + ' face' + (out.bad === 1 ? '' : 's') + ' in the ' + label + ' file pointed at missing points and ' +
      (out.bad === 1 ? 'was' : 'were') + ' skipped.');
  }
  if (dropped) {
    warnings.push(dropped + ' triangle' + (dropped === 1 ? '' : 's') + ' had no area or unreadable numbers and ' +
      (dropped === 1 ? 'was' : 'were') + ' skipped.');
  }
  var count = o / 9;
  if (count === 0) {
    throw new Error('No triangles were found in this ' + label + ' file. It may be empty, damaged, or hold only points and lines.');
  }
  return {
    tris: a.subarray(0, o),
    count: count,
    min: [minx, miny, minz],
    max: [maxx, maxy, maxz],
    format: format,
    warnings: warnings,
    units: units || null
  };
}

function fmUnitName(u) {
  u = String(u == null ? '' : u).trim().toLowerCase();
  if (u === 'millimeter' || u === 'millimetre' || u === 'mm') return 'mm';
  if (u === 'centimeter' || u === 'centimetre' || u === 'cm') return 'cm';
  if (u === 'meter' || u === 'metre' || u === 'm') return 'm';
  if (u === 'inch' || u === 'in') return 'in';
  if (u === 'foot' || u === 'feet' || u === 'ft') return 'ft';
  if (u === 'micron' || u === 'micrometer' || u === 'micrometre') return 'micron';
  return null;
}

/* ------------------------------------------------------------------ */
/* glTF / GLB                                                          */
/* ------------------------------------------------------------------ */

var fmB64Table = null;
function fmBase64(str, start) {
  var T = fmB64Table;
  if (!T) {
    T = fmB64Table = new Int16Array(128).fill(-1);
    var abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    for (var k = 0; k < 64; k++) T[abc.charCodeAt(k)] = k;
    T[45] = 62; T[95] = 63;               // url-safe variants
  }
  var L = str.length, out = new Uint8Array(Math.floor((L - start) * 3 / 4) + 3), o = 0, acc = 0, bits = 0;
  for (var i = start; i < L; i++) {
    var c = str.charCodeAt(i);
    var v = c < 128 ? T[c] : -1;
    if (v < 0) continue;                  // padding, line breaks
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; }
  }
  return out.subarray(0, o);
}

function fmGltfBuffer(ctx, bi) {
  if (ctx.buffers[bi]) return ctx.buffers[bi];
  var def = ctx.json.buffers && ctx.json.buffers[bi];
  if (!def) throw new Error('This glTF file is damaged: it points at data that is not in the file. Try exporting it again.');
  var bytes;
  if (def.uri == null) {
    if (!ctx.bin) throw new Error('This glTF file is missing its model data. Export it again as a single .glb file.');
    bytes = ctx.bin;
  } else {
    var uri = String(def.uri);
    if (!/^data:/i.test(uri)) {
      throw new Error('This glTF file keeps its model data in a separate file ("' + uri.substring(0, 60) +
        '"), which cannot be opened here. Export the model as a single .glb file instead.');
    }
    var comma = uri.indexOf(',');
    if (comma < 0) throw new Error('This glTF file is damaged: its embedded data could not be read. Try exporting it again as a .glb file.');
    if (/;base64$/i.test(uri.substring(0, comma))) bytes = fmBase64(uri, comma + 1);
    else {
      var raw;
      try { raw = decodeURIComponent(uri.substring(comma + 1)); } catch (e) { raw = uri.substring(comma + 1); }
      bytes = fmBytes(raw);
    }
  }
  ctx.buffers[bi] = bytes;
  return bytes;
}

/* Read an accessor.  kind 'pos' -> Float32Array of x,y,z; kind 'idx' -> Uint32Array. */
function fmGltfRead(ctx, ai, kind) {
  var key = kind + ai;
  if (ctx.accCache[key]) return ctx.accCache[key];
  var acc = ctx.json.accessors && ctx.json.accessors[ai];
  if (!acc || typeof acc !== 'object') throw new Error('This glTF file is damaged: part of the model data is missing. Try exporting it again.');
  if (acc.sparse) throw new Error('This glTF file uses "sparse" data, which cannot be read here. Export it again without sparse accessors, or as STL.');
  var comps = kind === 'pos' ? 3 : 1;
  if (acc.type !== (kind === 'pos' ? 'VEC3' : 'SCALAR')) throw new Error('This glTF file stores its ' + (kind === 'pos' ? 'points' : 'triangles') + ' in a way that cannot be read here. Try exporting it again.');
  var ct = acc.componentType;
  var size = ct === 5126 || ct === 5125 ? 4 : (ct === 5122 || ct === 5123 ? 2 : (ct === 5120 || ct === 5121 ? 1 : 0));
  if (!size || (kind === 'idx' && ct !== 5121 && ct !== 5123 && ct !== 5125) || (kind === 'pos' && ct === 5125)) {
    throw new Error('This glTF file stores its numbers in a type that cannot be read here. Try exporting it again.');
  }
  var bv = ctx.json.bufferViews && ctx.json.bufferViews[acc.bufferView];
  if (!bv || typeof bv !== 'object') throw new Error('This glTF file is damaged: part of the model data is missing. Try exporting it again.');
  if (bv.extensions && (bv.extensions.EXT_meshopt_compression || bv.extensions.KHR_meshopt_compression)) {
    throw new Error('This glTF file is compressed (meshopt), which cannot be read here. Re-export without compression.');
  }
  var bytes = fmGltfBuffer(ctx, bv.buffer | 0);
  var count = Number(acc.count);
  var vo = Number(bv.byteOffset) || 0;
  var base = vo + (Number(acc.byteOffset) || 0);
  var stride = Number(bv.byteStride) || comps * size;
  var limit = bytes.length;
  if (bv.byteLength != null && vo + Number(bv.byteLength) < limit) limit = vo + Number(bv.byteLength);
  if (!(count >= 0) || count !== Math.floor(count) || !(base >= 0) || !(stride >= 1) ||
      (count > 0 && base + (count - 1) * stride + comps * size > limit)) {
    throw new Error('This glTF file looks cut short or damaged: its model data runs past the end of the file. Try exporting it again.');
  }
  var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  var n = count * comps, arr, i, c, p, o = 0;
  if (kind === 'idx') {
    arr = new Uint32Array(n);
    if (ct === 5125) for (i = 0, p = base; i < count; i++, p += stride) arr[i] = dv.getUint32(p, true);
    else if (ct === 5123) for (i = 0, p = base; i < count; i++, p += stride) arr[i] = dv.getUint16(p, true);
    else for (i = 0, p = base; i < count; i++, p += stride) arr[i] = bytes[p];
  } else {
    arr = new Float32Array(n);
    var norm = !!acc.normalized;
    for (i = 0, p = base; i < count; i++, p += stride) {
      for (c = 0; c < 3; c++) {
        var q = p + c * size, v;
        if (ct === 5126) v = dv.getFloat32(q, true);
        else if (ct === 5122) { v = dv.getInt16(q, true); if (norm) v = Math.max(v / 32767, -1); }
        else if (ct === 5123) { v = dv.getUint16(q, true); if (norm) v /= 65535; }
        else if (ct === 5120) { v = dv.getInt8(q); if (norm) v = Math.max(v / 127, -1); }
        else { v = bytes[q]; if (norm) v /= 255; }
        arr[o++] = v;
      }
    }
  }
  var res = { arr: arr, count: count };
  ctx.accCache[key] = res;
  return res;
}

/* All triangle primitives of one mesh as [{ V, nv, I, ni }]. */
function fmGltfMesh(ctx, mi) {
  if (ctx.meshCache[mi]) return ctx.meshCache[mi];
  var mesh = ctx.json.meshes && ctx.json.meshes[mi];
  var list = [];
  var prims = mesh && Array.isArray(mesh.primitives) ? mesh.primitives : [];
  for (var pi = 0; pi < prims.length; pi++) {
    var pr = prims[pi];
    if (!pr || typeof pr !== 'object') continue;
    if (pr.extensions && pr.extensions.KHR_draco_mesh_compression) {
      throw new Error('This glTF file is compressed (Draco), which cannot be read here. Re-export without compression.');
    }
    var mode = pr.mode == null ? 4 : pr.mode;
    if (mode !== 4 && mode !== 5 && mode !== 6) { ctx.nonTri++; continue; }
    if (!pr.attributes || pr.attributes.POSITION == null) continue;
    var pos = fmGltfRead(ctx, pr.attributes.POSITION, 'pos');
    var idx = pr.indices != null ? fmGltfRead(ctx, pr.indices, 'idx').arr : null;
    var n = idx ? idx.length : pos.count, I, k, o = 0;
    if (mode === 4) {
      if (idx) I = idx;
      else { I = new Uint32Array(n); for (k = 0; k < n; k++) I[k] = k; }
    } else {
      var nt = n >= 3 ? n - 2 : 0;
      I = new Uint32Array(nt * 3);
      for (k = 0; k < nt; k++) {
        var a, b, c;
        if (mode === 5) { a = k; b = k + 1 + (k & 1); c = k + 2 - (k & 1); }
        else { a = k + 1; b = k + 2; c = 0; }
        I[o++] = idx ? idx[a] : a; I[o++] = idx ? idx[b] : b; I[o++] = idx ? idx[c] : c;
      }
    }
    list.push({ V: pos.arr, nv: pos.count, I: I, ni: I.length - (I.length % 3) });
  }
  ctx.meshCache[mi] = list;
  return list;
}

function fmGltfNodeMatrix(node) {
  var m = node.matrix, A = fmAffIdent(), r, c;
  if (Array.isArray(m) && m.length === 16) {
    for (r = 0; r < 3; r++) for (c = 0; c < 4; c++) A[r * 4 + c] = Number(m[c * 4 + r]);   // glTF is column-major
    return A;
  }
  var t = Array.isArray(node.translation) && node.translation.length === 3 ? node.translation : [0, 0, 0];
  var q = Array.isArray(node.rotation) && node.rotation.length === 4 ? node.rotation : [0, 0, 0, 1];
  var s = Array.isArray(node.scale) && node.scale.length === 3 ? node.scale : [1, 1, 1];
  var x = Number(q[0]), y = Number(q[1]), z = Number(q[2]), w = Number(q[3]);
  var len = Math.sqrt(x * x + y * y + z * z + w * w);
  if (len > 0) { x /= len; y /= len; z /= len; w /= len; } else { x = y = z = 0; w = 1; }
  var R = [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
           2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
           2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
  for (r = 0; r < 3; r++) {
    for (c = 0; c < 3; c++) A[r * 4 + c] = R[r * 3 + c] * Number(s[c]);
    A[r * 4 + 3] = Number(t[r]);
  }
  return A;
}

function fmParseGltf(bytes, warnings) {
  var json = null, bin = null, isGlb = false;
  if (bytes.length >= 4 && bytes[0] === 0x67 && bytes[1] === 0x6C && bytes[2] === 0x54 && bytes[3] === 0x46) {
    isGlb = true;
    if (bytes.length < 20) throw new Error('This GLB file is cut short: it is too small to hold a model. Try exporting it again.');
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var ver = dv.getUint32(4, true);
    if (ver !== 2) throw new Error('This GLB file is glTF version ' + ver + ', which cannot be read here. Export it again as glTF 2.0.');
    var total = dv.getUint32(8, true), p = 12, cut = total > bytes.length;
    while (p + 8 <= bytes.length) {
      var clen = dv.getUint32(p, true), ctype = dv.getUint32(p + 4, true);
      p += 8;
      if (p + clen > bytes.length) { cut = true; if (ctype === 0x4E4F534A) clen = bytes.length - p; else break; }
      if (ctype === 0x4E4F534A && json === null) {
        try { json = JSON.parse(fmText(bytes, p, p + clen)); } catch (e) { json = undefined; }
      } else if (ctype === 0x004E4942 && !bin) bin = bytes.subarray(p, p + clen);
      p += clen + ((4 - (clen & 3)) & 3);
    }
    if (!json || typeof json !== 'object') {
      throw new Error(cut ? 'This GLB file is cut short: part of it is missing. Try exporting or downloading it again.'
        : 'This GLB file is damaged and could not be read. Try exporting it again.');
    }
    if (cut && !bin) throw new Error('This GLB file is cut short: part of it is missing. Try exporting or downloading it again.');
  } else {
    var text = fmText(bytes);
    if (text.charCodeAt(0) === 0xFEFF) text = text.substring(1);
    try { json = JSON.parse(text); } catch (e) { json = null; }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw new Error('This glTF file could not be read: it is not valid glTF text. It may be damaged or cut short. Try exporting it again as a .glb file.');
    }
  }
  if (json.asset && json.asset.version && parseFloat(json.asset.version) < 2) {
    throw new Error('This file is glTF version ' + json.asset.version + ', which cannot be read here. Export it again as glTF 2.0.');
  }
  var req = Array.isArray(json.extensionsRequired) ? json.extensionsRequired : [];
  if (req.indexOf('KHR_draco_mesh_compression') >= 0) throw new Error('This glTF file is compressed (Draco), which cannot be read here. Re-export without compression.');
  if (req.indexOf('EXT_meshopt_compression') >= 0 || req.indexOf('KHR_meshopt_compression') >= 0) {
    throw new Error('This glTF file is compressed (meshopt), which cannot be read here. Re-export without compression.');
  }

  var ctx = { json: json, bin: bin, buffers: [], accCache: {}, meshCache: [], nonTri: 0 };
  var nodes = Array.isArray(json.nodes) ? json.nodes : [];
  var meshes = Array.isArray(json.meshes) ? json.meshes : [];
  var out = fmOut(1024);
  // glTF is Y-up: (x, y, z) -> (x, -z, y) stands the model upright on Z without mirroring it.
  var conv = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0];
  var i, k;

  function emitMesh(mi, A) {
    if (!(mi >= 0 && mi < meshes.length)) return;
    var list = fmGltfMesh(ctx, mi);
    for (var j = 0; j < list.length; j++) fmEmit(out, list[j].V, list[j].nv, list[j].I, list[j].ni, A);
  }

  var roots = null;
  if (Array.isArray(json.scenes) && json.scenes.length) {
    var sc = json.scenes[json.scene != null && json.scenes[json.scene] ? json.scene : 0];
    if (sc && Array.isArray(sc.nodes)) roots = sc.nodes;
  }
  if (!roots) {
    var isChild = new Uint8Array(nodes.length);
    for (i = 0; i < nodes.length; i++) {
      var ch = nodes[i] && nodes[i].children;
      if (Array.isArray(ch)) for (k = 0; k < ch.length; k++) if (ch[k] >= 0 && ch[k] < nodes.length) isChild[ch[k]] = 1;
    }
    roots = [];
    for (i = 0; i < nodes.length; i++) if (!isChild[i]) roots.push(i);
  }
  if (!nodes.length) {
    for (i = 0; i < meshes.length; i++) emitMesh(i, conv);
  } else {
    var stackN = [], stackA = [], visits = 0, maxVisits = nodes.length * 8 + 64;
    for (i = roots.length - 1; i >= 0; i--) { stackN.push(roots[i]); stackA.push(conv); }
    while (stackN.length) {
      var ni = stackN.pop(), PA = stackA.pop();
      var node = nodes[ni];
      if (!node || typeof node !== 'object') continue;
      if (++visits > maxVisits) throw new Error('This glTF file is damaged: its parts are linked in a loop. Try exporting it again.');
      var A = fmAffMul(PA, fmGltfNodeMatrix(node));
      if (node.mesh != null) emitMesh(node.mesh, A);
      if (Array.isArray(node.children)) {
        for (k = node.children.length - 1; k >= 0; k--) { stackN.push(node.children[k]); stackA.push(A); }
      }
    }
  }
  if (ctx.nonTri) warnings.push(ctx.nonTri + ' part' + (ctx.nonTri === 1 ? '' : 's') + ' of the glTF file held only points or lines and ' + (ctx.nonTri === 1 ? 'was' : 'were') + ' left out.');
  return fmFinish(out, isGlb ? 'glb' : 'gltf', isGlb ? 'GLB' : 'glTF', 'm', warnings);
}

/* ------------------------------------------------------------------ */
/* ZIP (for 3MF and zipped AMF)                                        */
/* ------------------------------------------------------------------ */

function fmZipOpen(bytes, label) {
  var len = bytes.length;
  var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  var cutMsg = 'This ' + label + ' file looks cut short or damaged: its file list is missing. Try exporting or downloading it again.';
  if (len < 22) throw new Error(cutMsg);
  var eocd = -1, stop = Math.max(0, len - 22 - 65535);
  for (var p = len - 22; p >= stop; p--) {
    if (bytes[p] === 0x50 && bytes[p + 1] === 0x4B && bytes[p + 2] === 0x05 && bytes[p + 3] === 0x06) { eocd = p; break; }
  }
  if (eocd < 0) throw new Error(cutMsg);
  var total = dv.getUint16(eocd + 10, true), cdSize = dv.getUint32(eocd + 12, true), cdOff = dv.getUint32(eocd + 16, true);
  if (total === 0xFFFF || cdOff === 0xFFFFFFFF || cdSize === 0xFFFFFFFF) {
    throw new Error('This ' + label + ' file uses the ZIP64 format (very large archives), which cannot be read here. Export a smaller model.');
  }
  if (cdOff + cdSize > len) throw new Error(cutMsg);
  var entries = [], q = cdOff;
  for (var i = 0; i < total; i++) {
    if (q + 46 > len || dv.getUint32(q, true) !== 0x02014B50) throw new Error(cutMsg);
    var nameLen = dv.getUint16(q + 28, true), extraLen = dv.getUint16(q + 30, true), commentLen = dv.getUint16(q + 32, true);
    if (q + 46 + nameLen > len) throw new Error(cutMsg);
    var name = fmText(bytes, q + 46, q + 46 + nameLen).replace(/\\/g, '/').replace(/^\/+/, '');
    entries.push({
      name: name, key: name.toLowerCase(), flags: dv.getUint16(q + 8, true), method: dv.getUint16(q + 10, true),
      csize: dv.getUint32(q + 20, true), usize: dv.getUint32(q + 24, true), offset: dv.getUint32(q + 42, true)
    });
    q += 46 + nameLen + extraLen + commentLen;
  }
  return { bytes: bytes, dv: dv, entries: entries, label: label };
}

function fmZipFind(zip, name) {
  var key = String(name).replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  for (var i = 0; i < zip.entries.length; i++) if (zip.entries[i].key === key) return zip.entries[i];
  return null;
}

async function fmInflate(data, sizeHint, label) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot unpack ' + label + ' files. Update the browser, or export the model as STL.');
  }
  var bad = 'This ' + label + ' file is damaged or cut short and could not be unpacked. Try exporting or downloading it again.';
  var LIMIT = 1024 * 1024 * 1024;
  var ds, writer, reader;
  try {
    ds = new DecompressionStream('deflate-raw');
    writer = ds.writable.getWriter();
    reader = ds.readable.getReader();
  } catch (e) {
    throw new Error('This browser cannot unpack ' + label + ' files. Update the browser, or export the model as STL.');
  }
  var fail = false, tooBig = false;
  var wrote = writer.write(data).then(function () { return writer.close(); }).catch(function () { fail = true; });
  var out = new Uint8Array(sizeHint > 0 && sizeHint <= LIMIT ? sizeHint : 65536), n = 0;
  try {
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      var chunk = r.value;
      if (n + chunk.length > LIMIT) { tooBig = true; break; }
      if (n + chunk.length > out.length) {
        var cap = out.length * 2;
        while (cap < n + chunk.length) cap *= 2;
        var bigger = new Uint8Array(cap);
        bigger.set(out.subarray(0, n));
        out = bigger;
      }
      out.set(chunk, n);
      n += chunk.length;
    }
  } catch (e) { fail = true; }
  if (tooBig) {
    try { reader.cancel().catch(function () {}); } catch (e) { /* ignore */ }
    try { writer.abort().catch(function () {}); } catch (e) { /* ignore */ }
    throw new Error('This ' + label + ' file unpacks to more than 1 GB, which is too large to open in the browser. Export a simpler model.');
  }
  await wrote;
  if (fail) throw new Error(bad);
  return out.subarray(0, n);
}

async function fmZipRead(zip, entry) {
  var bytes = zip.bytes, dv = zip.dv, label = zip.label;
  var bad = 'This ' + label + ' file is damaged or cut short and could not be unpacked. Try exporting or downloading it again.';
  if (entry.flags & 1) throw new Error('This ' + label + ' file is password-protected and cannot be opened here.');
  if (entry.csize === 0xFFFFFFFF || entry.usize === 0xFFFFFFFF || entry.offset === 0xFFFFFFFF) {
    throw new Error('This ' + label + ' file uses the ZIP64 format (very large archives), which cannot be read here. Export a smaller model.');
  }
  var o = entry.offset;
  if (o + 30 > bytes.length || dv.getUint32(o, true) !== 0x04034B50) throw new Error(bad);
  var start = o + 30 + dv.getUint16(o + 26, true) + dv.getUint16(o + 28, true);
  if (start + entry.csize > bytes.length) throw new Error(bad);
  var data = bytes.subarray(start, start + entry.csize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return fmInflate(data, entry.usize, label);
  throw new Error('This ' + label + ' file is packed with a compression method that cannot be read here. Export it again with normal settings.');
}

/* ------------------------------------------------------------------ */
/* Tiny tolerant XML tag scanner                                       */
/* ------------------------------------------------------------------ */

function fmXmlLocal(name) {
  var c = name.lastIndexOf(':');
  return (c >= 0 ? name.substring(c + 1) : name).toLowerCase();
}

function fmXmlValue(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, function (m, e) {
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'amp') return '&';
    if (e === 'quot') return '"';
    if (e === 'apos') return '\'';
    var code = e.charAt(1) === 'x' ? parseInt(e.substring(2), 16) : parseInt(e.substring(1), 10);
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
  });
}

/* Calls onOpen(name, attrs, selfClosing) and onClose(name, textStart, textEnd).
 * Names are lower-case with any namespace prefix removed.  textStart..textEnd
 * is the text since the previous tag (the content of a leaf element). */
function fmXmlWalk(text, onOpen, onClose) {
  var L = text.length, p = 0, textStart = 0, e, c;
  for (;;) {
    var lt = text.indexOf('<', p);
    if (lt < 0 || lt + 1 >= L) return;
    c = text.charCodeAt(lt + 1);
    if (c === 33) {                                   // <!-- -->, <![CDATA[ ]]>, <!DOCTYPE >
      if (text.startsWith('<!--', lt)) { e = text.indexOf('-->', lt + 4); if (e < 0) return; p = e + 3; }
      else if (text.startsWith('<![CDATA[', lt)) { e = text.indexOf(']]>', lt + 9); if (e < 0) return; p = e + 3; }
      else { e = text.indexOf('>', lt); if (e < 0) return; p = e + 1; }
      continue;
    }
    if (c === 63) { e = text.indexOf('?>', lt); if (e < 0) return; p = e + 2; textStart = p; continue; }
    if (c === 47) {
      e = text.indexOf('>', lt);
      if (e < 0) return;
      if (onClose) onClose(fmXmlLocal(text.substring(lt + 2, e).trim()), textStart, lt);
      p = e + 1; textStart = p;
      continue;
    }
    var i = lt + 1;
    while (i < L) { c = text.charCodeAt(i); if (c <= 32 || c === 47 || c === 62) break; i++; }
    var name = fmXmlLocal(text.substring(lt + 1, i));
    var attrs = {}, self = false, done = false;
    while (i < L) {
      c = text.charCodeAt(i);
      if (c <= 32) { i++; continue; }
      if (c === 62) { i++; done = true; break; }
      if (c === 47) { self = true; i++; continue; }
      var s = i;
      while (i < L) { c = text.charCodeAt(i); if (c === 61 || c <= 32 || c === 62 || c === 47) break; i++; }
      var an = text.substring(s, i), val = '';
      while (i < L && text.charCodeAt(i) <= 32) i++;
      if (i < L && text.charCodeAt(i) === 61) {
        i++;
        while (i < L && text.charCodeAt(i) <= 32) i++;
        c = text.charCodeAt(i);
        if (c === 34 || c === 39) {
          e = text.indexOf(c === 34 ? '"' : '\'', i + 1);
          if (e < 0) return;
          val = text.substring(i + 1, e);
          i = e + 1;
        } else {
          s = i;
          while (i < L) { c = text.charCodeAt(i); if (c <= 32 || c === 62) break; i++; }
          val = text.substring(s, i);
        }
      }
      if (an) attrs[fmXmlLocal(an)] = val;
    }
    if (!done) return;                                // file ends inside a tag
    if (onOpen) onOpen(name, attrs, self);
    if (self && onClose) onClose(name, i, i);
    p = i; textStart = i;
  }
}

/* ------------------------------------------------------------------ */
/* 3MF                                                                 */
/* ------------------------------------------------------------------ */

/* 3MF writes "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32" for row vectors. */
function fm3mfTransform(str, state) {
  if (str == null || String(str).trim() === '') return null;
  var t = String(str).trim().split(/\s+/);
  var m = new Array(12), ok = t.length === 12;
  for (var i = 0; i < 12 && ok; i++) { m[i] = parseFloat(t[i]); if (!(m[i] - m[i] === 0)) ok = false; }
  if (!ok) { state.badTransforms++; return null; }
  return [m[0], m[3], m[6], m[9], m[1], m[4], m[7], m[10], m[2], m[5], m[8], m[11]];
}

function fm3mfPath(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

/* Parse one .model part.  Objects go into state.objects under "path#id". */
function fm3mfModel(text, path, state, isRoot) {
  var cur = null;
  fmXmlWalk(text, function (name, at) {
    if (name === 'vertex') {
      if (!cur) return;
      fmNeed(cur.V, 3);
      cur.V.a[cur.V.n++] = parseFloat(at.x);
      cur.V.a[cur.V.n++] = parseFloat(at.y);
      cur.V.a[cur.V.n++] = parseFloat(at.z);
    } else if (name === 'triangle') {
      if (!cur) return;
      var v1 = parseInt(at.v1, 10), v2 = parseInt(at.v2, 10), v3 = parseInt(at.v3, 10);
      if (!(v1 >= 0 && v2 >= 0 && v3 >= 0)) { state.badFaces++; return; }
      fmNeed(cur.I, 3);
      cur.I.a[cur.I.n++] = v1; cur.I.a[cur.I.n++] = v2; cur.I.a[cur.I.n++] = v3;
    } else if (name === 'object') {
      cur = { V: fmGrow(Float64Array, 3000), I: fmGrow(Uint32Array, 3000), comps: [], used: false };
      state.objects[path + '#' + String(at.id).trim()] = cur;
      state.order.push(path + '#' + String(at.id).trim());
    } else if (name === 'component') {
      if (!cur) return;
      var cp = at.path != null ? fm3mfPath(at.path) : path;
      if (cp !== path && state.wanted.indexOf(cp) < 0) state.wanted.push(cp);
      cur.comps.push({ key: cp + '#' + String(at.objectid).trim(), A: fm3mfTransform(at.transform, state) });
    } else if (name === 'item') {
      if (!isRoot) return;
      var ip = at.path != null ? fm3mfPath(at.path) : path;
      if (ip !== path && state.wanted.indexOf(ip) < 0) state.wanted.push(ip);
      state.items.push({ key: ip + '#' + String(at.objectid).trim(), A: fm3mfTransform(at.transform, state) });
    } else if (name === 'model') {
      if (isRoot) { state.unit = at.unit; state.sawModel = true; }
    }
  }, function (name) {
    if (name === 'object') cur = null;
  });
}

async function fmParse3mf(bytes, warnings) {
  if (!(bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B)) {
    throw new Error('This does not look like a 3MF file. It may be damaged, or a different kind of file with the wrong name. Try exporting it again.');
  }
  var zip = fmZipOpen(bytes, '3MF');
  var rootPath = null, entry;
  var rels = fmZipFind(zip, '_rels/.rels');
  if (rels) {
    var relText = fmText(await fmZipRead(zip, rels));
    fmXmlWalk(relText, function (name, at) {
      if (name === 'relationship' && !rootPath && /3dmodel$/i.test(String(at.type || '')) && at.target) rootPath = fmXmlValue(at.target);
    }, null);
  }
  entry = rootPath ? fmZipFind(zip, rootPath) : null;
  if (!entry) entry = fmZipFind(zip, '3D/3dmodel.model');
  if (!entry) {
    for (var i = 0; i < zip.entries.length; i++) if (/\.model$/.test(zip.entries[i].key)) { entry = zip.entries[i]; break; }
  }
  if (!entry) throw new Error('This 3MF file has no 3D model inside it. Try exporting it again.');

  var state = { objects: {}, order: [], items: [], wanted: [], unit: null, sawModel: false, badFaces: 0, badTransforms: 0 };
  var rootKey = entry.key;
  fm3mfModel(fmText(await fmZipRead(zip, entry)), rootKey, state, true);
  if (!state.sawModel) throw new Error('This 3MF file is damaged: its model part could not be read. Try exporting it again.');
  // Parts kept in other files of the package (3MF "production" layout).
  var missingParts = 0;
  for (var w = 0; w < state.wanted.length && w < 2000; w++) {
    var sub = fmZipFind(zip, state.wanted[w]);
    if (!sub) { missingParts++; continue; }
    fm3mfModel(fmText(await fmZipRead(zip, sub)), state.wanted[w], state, false);
  }

  var unit = fmUnitName(state.unit == null ? 'millimeter' : state.unit);
  if (!unit) { warnings.push('The 3MF file names a unit ("' + String(state.unit).substring(0, 20) + '") that is not recognised; millimetres were assumed.'); unit = 'mm'; }
  var k = unit === 'micron' ? 0.001 : 1;
  if (unit === 'micron') unit = 'mm';
  var rootA = [k, 0, 0, 0, 0, k, 0, 0, 0, 0, k, 0];

  var out = fmOut(1024);
  var stackK = [], stackA = [], stackD = [], j, missing = 0, steps = 0;
  if (state.items.length) {
    for (j = state.items.length - 1; j >= 0; j--) {
      stackK.push(state.items[j].key); stackD.push(0);
      stackA.push(state.items[j].A ? fmAffMul(rootA, state.items[j].A) : rootA);
    }
  } else {
    // No build list: show every object that is not just a piece of another one.
    var isPart = {};
    for (j = 0; j < state.order.length; j++) {
      var cs = state.objects[state.order[j]].comps;
      for (var c = 0; c < cs.length; c++) isPart[cs[c].key] = true;
    }
    for (j = state.order.length - 1; j >= 0; j--) {
      if (!isPart[state.order[j]]) { stackK.push(state.order[j]); stackA.push(rootA); stackD.push(0); }
    }
    if (state.order.length) warnings.push('The 3MF file has no build list, so every object in it was loaded where it was drawn.');
  }
  while (stackK.length) {
    var key = stackK.pop(), A = stackA.pop(), depth = stackD.pop();
    var obj = state.objects[key];
    if (!obj) { missing++; continue; }
    if (depth > 64 || ++steps > 2000000) throw new Error('This 3MF file is damaged: its parts are linked in a loop. Try exporting it again.');
    if (obj.I.n) fmEmit(out, obj.V.a, obj.V.n / 3, obj.I.a, obj.I.n, A);
    for (j = obj.comps.length - 1; j >= 0; j--) {
      stackK.push(obj.comps[j].key); stackD.push(depth + 1);
      stackA.push(obj.comps[j].A ? fmAffMul(A, obj.comps[j].A) : A);
    }
  }
  out.bad += state.badFaces;
  if (missing || missingParts) warnings.push('Some parts listed in the 3MF file were not found inside it and were left out.');
  if (state.badTransforms) warnings.push(state.badTransforms + ' placement' + (state.badTransforms === 1 ? '' : 's') + ' in the 3MF file could not be read; ' + (state.badTransforms === 1 ? 'that part was' : 'those parts were') + ' left where drawn.');
  return fmFinish(out, '3mf', '3MF', unit, warnings);
}

/* ------------------------------------------------------------------ */
/* AMF                                                                 */
/* ------------------------------------------------------------------ */

async function fmParseAmf(bytes, warnings) {
  var zipped = false;
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B) {
    var zip = fmZipOpen(bytes, 'AMF'), entry = null, i;
    for (i = 0; i < zip.entries.length; i++) if (/\.amf$/.test(zip.entries[i].key)) { entry = zip.entries[i]; break; }
    if (!entry) for (i = 0; i < zip.entries.length; i++) if (!/\/$/.test(zip.entries[i].key)) { entry = zip.entries[i]; break; }
    if (!entry) throw new Error('This AMF file has no model inside it. Try exporting it again.');
    bytes = await fmZipRead(zip, entry);
    zipped = true;
  }
  var text = fmText(bytes);
  var out = fmOut(1024);
  var V = null, I = null, unitAttr = null, sawAmf = false, inTri = false, inVertex = false, constellations = 0, badFaces = 0;
  var cx = NaN, cy = NaN, cz = NaN, t1 = -1, t2 = -1, t3 = -1;
  function num(s, e) { return parseFloat(text.substring(s, e)); }
  function flush() {
    if (V && I && I.n) fmEmit(out, V.a, V.n / 3, I.a, I.n, null);
    V = null; I = null;
  }
  fmXmlWalk(text, function (name, at) {
    if (name === 'vertex') { inVertex = true; cx = cy = cz = NaN; }
    else if (name === 'triangle') { inTri = true; t1 = t2 = t3 = -1; }
    else if (name === 'object' || name === 'mesh') {
      if (name === 'object' || !V) { flush(); V = fmGrow(Float64Array, 3000); I = fmGrow(Uint32Array, 3000); }
    } else if (name === 'amf') { sawAmf = true; unitAttr = at.unit; }
    else if (name === 'constellation') constellations++;
  }, function (name, s, e) {
    if (inVertex) {
      if (name === 'x') cx = num(s, e);
      else if (name === 'y') cy = num(s, e);
      else if (name === 'z') cz = num(s, e);
      else if (name === 'vertex') {
        inVertex = false;
        if (V) { fmNeed(V, 3); V.a[V.n++] = cx; V.a[V.n++] = cy; V.a[V.n++] = cz; }
      }
    } else if (inTri) {
      if (name === 'v1') t1 = parseInt(text.substring(s, e), 10);
      else if (name === 'v2') t2 = parseInt(text.substring(s, e), 10);
      else if (name === 'v3') t3 = parseInt(text.substring(s, e), 10);
      else if (name === 'triangle') {
        inTri = false;
        if (!(t1 >= 0 && t2 >= 0 && t3 >= 0)) badFaces++;
        else if (I) { fmNeed(I, 3); I.a[I.n++] = t1; I.a[I.n++] = t2; I.a[I.n++] = t3; }
      }
    } else if (name === 'object') flush();
  });
  flush();
  if (!sawAmf) throw new Error('This does not look like an AMF file. It may be damaged, or a different kind of file with the wrong name. Try exporting it again.');
  out.bad += badFaces;
  var unit = unitAttr == null ? null : fmUnitName(unitAttr);
  if (unit === 'micron') {
    for (var k = 0; k < out.n; k++) out.a[k] *= 0.001;
    unit = 'mm';
  }
  if (constellations) warnings.push('The AMF file arranges copies of its objects (a "constellation"); that arrangement was ignored and each object was loaded once, where it was drawn.');
  return fmFinish(out, zipped ? 'amf-zip' : 'amf', 'AMF', unit, warnings);
}

/* ------------------------------------------------------------------ */
/* PLY                                                                 */
/* ------------------------------------------------------------------ */

var fmPlyTypes = {
  char: 0, int8: 0, uchar: 1, uint8: 1, short: 2, int16: 2, ushort: 3, uint16: 3,
  int: 4, int32: 4, uint: 5, uint32: 5, float: 6, float32: 6, double: 7, float64: 7
};
var fmPlySizes = [1, 1, 2, 2, 4, 4, 4, 8];

function fmPlyGet(dv, o, t, le) {
  switch (t) {
    case 0: return dv.getInt8(o);
    case 1: return dv.getUint8(o);
    case 2: return dv.getInt16(o, le);
    case 3: return dv.getUint16(o, le);
    case 4: return dv.getInt32(o, le);
    case 5: return dv.getUint32(o, le);
    case 6: return dv.getFloat32(o, le);
    default: return dv.getFloat64(o, le);
  }
}

function fmParsePly(bytes, warnings) {
  var len = bytes.length, cutMsg = 'This PLY file looks cut short: it ends before all of its data. Try exporting or downloading it again.';
  if (!(len >= 4 && bytes[0] === 0x70 && bytes[1] === 0x6C && bytes[2] === 0x79 && bytes[3] <= 32)) {
    throw new Error('This does not look like a PLY file. It may be damaged, or a different kind of file with the wrong name. Try exporting it again.');
  }
  // header: plain text up to the line "end_header"
  var headMax = Math.min(len, 1048576), hEnd = -1, i;
  var mark = [101, 110, 100, 95, 104, 101, 97, 100, 101, 114];   // end_header
  for (i = 3; i + 10 <= headMax; i++) {
    if (bytes[i] !== 101 || (bytes[i - 1] !== 10 && bytes[i - 1] !== 13)) continue;
    var hit = true;
    for (var m = 1; m < 10; m++) if (bytes[i + m] !== mark[m]) { hit = false; break; }
    if (hit) { hEnd = i; break; }
  }
  if (hEnd < 0) throw new Error('This PLY file is damaged or cut short: its header never ends. Try exporting it again.');
  var body = hEnd + 10;
  while (body < len && bytes[body] !== 10) body++;
  body++;
  var lines = fmText(bytes, 0, hEnd).split(/\r\n|\r|\n/);
  var format = null, elements = [], el = null;
  for (i = 0; i < lines.length; i++) {
    var tk = lines[i].trim().split(/\s+/);
    if (tk[0] === 'format') format = tk[1];
    else if (tk[0] === 'element') {
      el = { name: String(tk[1]).toLowerCase(), count: parseInt(tk[2], 10), props: [], fixed: true, stride: 0 };
      if (!(el.count >= 0)) throw new Error('This PLY file has a damaged header. Try exporting it again.');
      elements.push(el);
    } else if (tk[0] === 'property' && el) {
      var pr;
      if (tk[1] === 'list') pr = { list: true, ct: fmPlyTypes[tk[2]], t: fmPlyTypes[tk[3]], name: String(tk[4]).toLowerCase() };
      else pr = { list: false, t: fmPlyTypes[tk[1]], name: String(tk[2]).toLowerCase() };
      if (pr.t === undefined || (pr.list && pr.ct === undefined)) throw new Error('This PLY file uses a number type that cannot be read here ("' + String(tk[pr.list ? 3 : 1]).substring(0, 20) + '"). Try exporting it again.');
      pr.offset = el.stride;
      if (pr.list) el.fixed = false; else el.stride += fmPlySizes[pr.t];
      el.props.push(pr);
    }
  }
  var ascii = format === 'ascii', le = format === 'binary_little_endian';
  if (!ascii && !le && format !== 'binary_big_endian') throw new Error('This PLY file is in a layout that cannot be read here. Export it again as ASCII or binary PLY.');

  var V = null, nv = 0, I = fmGrow(Uint32Array, 3000), badFaces = 0, sawFace = false, sawVertex = false;
  var poly = [];
  function addFace(n) {
    if (n < 3) { if (n > 0) badFaces++; return; }
    fmNeed(I, (n - 2) * 3);
    var a = I.a, o = I.n, v0 = poly[0];
    for (var k = 1; k + 1 < n; k++) { a[o++] = v0; a[o++] = poly[k]; a[o++] = poly[k + 1]; }
    I.n = o;
  }
  function isIndexList(p) { return p.list && (p.name === 'vertex_indices' || p.name === 'vertex_index' || p.name === 'vertex_indexes'); }
  function xyzOf(e) {
    var r = [-1, -1, -1];
    for (var k = 0; k < e.props.length; k++) {
      if (e.props[k].list) continue;
      if (e.props[k].name === 'x') r[0] = k; else if (e.props[k].name === 'y') r[1] = k; else if (e.props[k].name === 'z') r[2] = k;
    }
    if (r[0] < 0 || r[1] < 0 || r[2] < 0) throw new Error('This PLY file has no x, y, z positions for its points, so there is no shape to read.');
    return r;
  }

  var e, r, pi, p, c, k, xyz;
  if (ascii) {
    var text = fmText(bytes, body), L = text.length, pos = 0;
    var next = function () {
      var ch;
      while (pos < L && text.charCodeAt(pos) <= 32) pos++;
      if (pos >= L) return NaN;
      var s = pos;
      while (pos < L && text.charCodeAt(pos) > 32) pos++;
      return parseFloat(text.substring(s, pos));
    };
    for (e = 0; e < elements.length; e++) {
      el = elements[e];
      if (el.count > L) throw new Error(cutMsg);
      var isV = el.name === 'vertex' && !sawVertex, isF = el.name === 'face';
      if (isV) { sawVertex = true; xyz = xyzOf(el); nv = el.count; V = new Float64Array(nv * 3); }
      if (isF) sawFace = true;
      for (r = 0; r < el.count; r++) {
        if (pos >= L) throw new Error(cutMsg);
        for (pi = 0; pi < el.props.length; pi++) {
          p = el.props[pi];
          if (!p.list) {
            var val = next();
            if (isV) { if (pi === xyz[0]) V[r * 3] = val; else if (pi === xyz[1]) V[r * 3 + 1] = val; else if (pi === xyz[2]) V[r * 3 + 2] = val; }
          } else {
            c = next();
            if (!(c >= 0) || c > L) throw new Error(cutMsg);
            if (isF && isIndexList(p)) {
              poly.length = 0;
              var okf = true;
              for (k = 0; k < c; k++) { var vi = next(); if (!(vi >= 0)) okf = false; poly.push(vi); }
              if (okf) addFace(c); else badFaces++;
            } else for (k = 0; k < c; k++) next();
          }
        }
      }
    }
  } else {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), o = body;
    for (e = 0; e < elements.length; e++) {
      el = elements[e];
      var isVb = el.name === 'vertex' && !sawVertex, isFb = el.name === 'face';
      if (isFb) sawFace = true;
      if (isVb) {
        sawVertex = true; xyz = xyzOf(el); nv = el.count;
        if (nv > len) throw new Error(cutMsg);
        V = new Float64Array(nv * 3);
      }
      if (el.fixed) {
        if (o + el.count * el.stride > len) throw new Error(cutMsg);
        if (isVb) {
          var px = el.props[xyz[0]], py = el.props[xyz[1]], pz = el.props[xyz[2]];
          for (r = 0; r < nv; r++, o += el.stride) {
            V[r * 3] = fmPlyGet(dv, o + px.offset, px.t, le);
            V[r * 3 + 1] = fmPlyGet(dv, o + py.offset, py.t, le);
            V[r * 3 + 2] = fmPlyGet(dv, o + pz.offset, pz.t, le);
          }
        } else o += el.count * el.stride;
        continue;
      }
      if (el.count > len) throw new Error(cutMsg);
      for (r = 0; r < el.count; r++) {
        for (pi = 0; pi < el.props.length; pi++) {
          p = el.props[pi];
          var sz = fmPlySizes[p.t];
          if (!p.list) {
            if (o + sz > len) throw new Error(cutMsg);
            if (isVb) { if (pi === xyz[0]) V[r * 3] = fmPlyGet(dv, o, p.t, le); else if (pi === xyz[1]) V[r * 3 + 1] = fmPlyGet(dv, o, p.t, le); else if (pi === xyz[2]) V[r * 3 + 2] = fmPlyGet(dv, o, p.t, le); }
            o += sz;
          } else {
            var csz = fmPlySizes[p.ct];
            if (o + csz > len) throw new Error(cutMsg);
            c = fmPlyGet(dv, o, p.ct, le);
            o += csz;
            if (!(c >= 0) || o + c * sz > len) throw new Error(cutMsg);
            if (isFb && isIndexList(p)) {
              poly.length = 0;
              var okb = true;
              for (k = 0; k < c; k++, o += sz) { var vb = fmPlyGet(dv, o, p.t, le); if (!(vb >= 0)) okb = false; poly.push(vb); }
              if (okb) addFace(c); else badFaces++;
            } else o += c * sz;
          }
        }
      }
    }
  }
  if (!V || nv === 0) throw new Error('This PLY file has no points in it, so there is no shape to read.');
  if (I.n === 0 && !badFaces) {
    throw new Error('This PLY file is a point cloud: it has ' + nv + ' points but no faces joining them, so there is no solid shape to slice. ' +
      'Turn it into a mesh first (for example with MeshLab or CloudCompare), then export it as STL.');
  }
  var out = fmOut(I.n / 3);
  fmEmit(out, V, nv, I.a, I.n, null);
  out.bad += badFaces;
  return fmFinish(out, ascii ? 'ply-ascii' : 'ply-binary', 'PLY', null, warnings);
}

/* ------------------------------------------------------------------ */
/* OFF                                                                 */
/* ------------------------------------------------------------------ */

function fmParseOff(bytes, warnings) {
  var text = fmText(bytes), L = text.length, pos = 0;
  var notOff = 'This does not look like an OFF file. It may be damaged, or a different kind of file with the wrong name. Try exporting it again.';
  var cutMsg = 'This OFF file looks cut short: it ends before all of its points and faces. Try exporting it again.';
  function line() {                     // next non-empty line as tokens, comments removed; null at the end
    while (pos < L) {
      var nl = text.indexOf('\n', pos);
      if (nl < 0) nl = L;
      var s = text.substring(pos, nl);
      pos = nl + 1;
      var h = s.indexOf('#');
      if (h >= 0) s = s.substring(0, h);
      s = s.trim();
      if (s) return s.split(/\s+/);
    }
    return null;
  }
  var tok = line();
  if (!tok) throw new Error(notOff);
  var hm = /^(ST)?(C)?(N)?(4)?(n)?OFF$/.exec(tok[0]);
  if (hm) {
    if (hm[4] || hm[5]) throw new Error('This OFF file holds 4D or higher-dimension data, which cannot be read here. Export it as a normal 3D OFF or STL file.');
    tok = tok.slice(1);
    if (tok[0] && /^binary$/i.test(tok[0])) throw new Error('This is a binary OFF file, which cannot be read here. Export it as a text OFF or STL file.');
    if (tok.length < 3) {
      var more = line();
      if (!more) throw new Error(cutMsg);
      if (/^binary$/i.test(more[0])) throw new Error('This is a binary OFF file, which cannot be read here. Export it as a text OFF or STL file.');
      tok = tok.concat(more);
    }
  }
  var nv = parseInt(tok[0], 10), nf = parseInt(tok[1], 10);
  if (!(nv >= 0) || !(nf >= 0) || !/^\d+$/.test(tok[0]) || !/^\d+$/.test(String(tok[1]))) throw new Error(notOff);
  if (nv > L || nf > L) throw new Error(cutMsg);
  if (nv === 0) throw new Error('This OFF file has no points in it, so there is no shape to read.');
  var V = new Float64Array(nv * 3), i;
  for (i = 0; i < nv; i++) {
    tok = line();
    if (!tok) throw new Error(cutMsg);
    V[i * 3] = parseFloat(tok[0]); V[i * 3 + 1] = parseFloat(tok[1]); V[i * 3 + 2] = parseFloat(tok[2]);
  }
  if (nf === 0) throw new Error('This OFF file has ' + nv + ' points but no faces joining them, so there is no solid shape to slice.');
  var I = fmGrow(Uint32Array, Math.min(nf * 3, 3000000)), bad = 0, cut = false;
  for (i = 0; i < nf; i++) {
    tok = line();
    if (!tok) { cut = true; break; }
    var n = parseInt(tok[0], 10);
    if (!(n >= 0) || n > 100000) { bad++; continue; }
    while (tok.length < n + 1) {         // a long face may wrap onto more lines
      var extra = line();
      if (!extra) break;
      tok = tok.concat(extra);
    }
    if (n < 3 || tok.length < n + 1) { bad++; continue; }
    var v0 = parseInt(tok[1], 10), ok = v0 >= 0, k;
    for (k = 2; k <= n && ok; k++) if (!(parseInt(tok[k], 10) >= 0)) ok = false;
    if (!ok) { bad++; continue; }
    fmNeed(I, (n - 2) * 3);
    for (k = 2; k < n; k++) { I.a[I.n++] = v0; I.a[I.n++] = parseInt(tok[k], 10); I.a[I.n++] = parseInt(tok[k + 1], 10); }
  }
  if (cut) warnings.push('The OFF file looks cut short: it says ' + nf + ' faces but holds fewer. Read what was there.');
  var out = fmOut(I.n / 3);
  fmEmit(out, V, nv, I.a, I.n, null);
  out.bad += bad;
  return fmFinish(out, 'off', 'OFF', null, warnings);
}

/* ------------------------------------------------------------------ */
/* DXF (3DFACE, polyface / polygon-mesh POLYLINE, MESH)                */
/* ------------------------------------------------------------------ */

function fmDxfTri(out, P, a, b, c) {
  fmOutRoom(out, 9);
  var o = out.a, n = out.n;
  o[n] = P[a]; o[n + 1] = P[a + 1]; o[n + 2] = P[a + 2];
  o[n + 3] = P[b]; o[n + 4] = P[b + 1]; o[n + 5] = P[b + 2];
  o[n + 6] = P[c]; o[n + 7] = P[c + 1]; o[n + 8] = P[c + 2];
  out.n = n + 9;
}

function fmDxfPolyline(pl, out, state) {
  var flags = pl.flags, V = pl.V.a, nv = pl.V.n / 3, i, k;
  if (flags & 64) {                                   // polyface mesh: 1-based indices, negative = hidden edge
    var F = pl.F.a, nf = pl.F.n / 4;
    for (i = 0; i < nf; i++) {
      var idx = [];
      for (k = 0; k < 4; k++) {
        var v = Math.abs(F[i * 4 + k]);
        if (v === 0) break;
        idx.push(v - 1);
      }
      if (idx.length < 3) continue;
      var ok = true;
      for (k = 0; k < idx.length; k++) if (idx[k] >= nv) ok = false;
      if (!ok) { out.bad++; continue; }
      fmDxfTri(out, V, idx[0] * 3, idx[1] * 3, idx[2] * 3);
      if (idx.length === 4 && idx[3] !== idx[2] && idx[3] !== idx[0]) fmDxfTri(out, V, idx[0] * 3, idx[2] * 3, idx[3] * 3);
    }
  } else if (flags & 16) {                            // polygon mesh: M x N grid
    var M = pl.m, N = pl.n;
    if ((pl.surf || (flags & 4)) && pl.sm > 0 && pl.sn > 0 && nv === pl.sm * pl.sn) { M = pl.sm; N = pl.sn; }
    if (!(M >= 2 && N >= 2) || M * N !== nv) { state.badMeshes++; return; }
    var mEnd = (flags & 1) ? M : M - 1, nEnd = (flags & 32) ? N : N - 1;
    for (i = 0; i < mEnd; i++) {
      var i2 = (i + 1) % M;
      for (k = 0; k < nEnd; k++) {
        var k2 = (k + 1) % N;
        var a = (i * N + k) * 3, b = (i2 * N + k) * 3, c = (i2 * N + k2) * 3, d = (i * N + k2) * 3;
        fmDxfTri(out, V, a, b, c);
        fmDxfTri(out, V, a, c, d);
      }
    }
  } else state.flat++;                                // an ordinary 2D / 3D line polyline
}

function fmDxfMesh(ms, out) {
  var V = ms.V.a, nv = ms.V.n / 3, F = ms.F.a, nf = ms.F.n, p = 0;
  while (p < nf) {
    var n = F[p++];
    if (!(n >= 0) || p + n > nf) { out.bad++; break; }
    if (n >= 3) {
      var ok = true, k;
      for (k = 0; k < n; k++) if (!(F[p + k] >= 0 && F[p + k] < nv)) ok = false;
      if (!ok) out.bad++;
      else for (k = 1; k + 1 < n; k++) fmDxfTri(out, V, F[p] * 3, F[p + k] * 3, F[p + k + 1] * 3);
    }
    p += n;
  }
}

function fmParseDxf(bytes, warnings) {
  if (bytes.length >= 18 && fmText(bytes, 0, 18) === 'AutoCAD Binary DXF') {
    throw new Error('This is a binary DXF file, which cannot be read here. Save it again as a normal (ASCII / text) DXF.');
  }
  var text = fmText(bytes), L = text.length, pos = 0;
  var main = fmOut(1024), blocks = fmOut(64);
  var state = { flat: 0, badMeshes: 0 };
  var section = '', units = null, headerVar = '', sawDxf = false, pairs = 0, solids = 0;
  var type = '', inBlocks = false;
  var face = new Float64Array(12), faceHas4 = false;
  var poly = null, vert = null, mesh = null;

  function target() { return inBlocks ? blocks : main; }
  function closePoly() { if (poly) { fmDxfPolyline(poly, poly.out, state); poly = null; } }
  function finishEntity() {
    if (type === '3DFACE') {
      var out = target();
      var same34 = !faceHas4 || (face[9] === face[6] && face[10] === face[7] && face[11] === face[8]);
      fmDxfTri(out, face, 0, 3, 6);
      if (!same34) fmDxfTri(out, face, 0, 6, 9);
    } else if (type === 'VERTEX' && poly && vert) {
      if ((poly.flags & 64) && (vert.flags & 128) && !(vert.flags & 64)) {
        fmNeed(poly.F, 4);
        poly.F.a[poly.F.n++] = vert.i1; poly.F.a[poly.F.n++] = vert.i2; poly.F.a[poly.F.n++] = vert.i3; poly.F.a[poly.F.n++] = vert.i4;
      } else if (!((poly.surf || (poly.flags & 4)) && (vert.flags & 16))) {      // skip spline control points
        fmNeed(poly.V, 3);
        poly.V.a[poly.V.n++] = vert.x; poly.V.a[poly.V.n++] = vert.y; poly.V.a[poly.V.n++] = vert.z;
      }
      vert = null;
    } else if (type === 'MESH' && mesh) {
      fmDxfMesh(mesh, target());
      mesh = null;
    }
  }

  while (pos < L) {
    var nl = text.indexOf('\n', pos);
    if (nl < 0) break;                                // a code with no value line
    var codeStr = text.substring(pos, nl).trim();
    var code = /^-?\d+$/.test(codeStr) ? parseInt(codeStr, 10) : NaN;
    if (!(code === code)) {                           // not a group code: step one line and try to get back in step
      pos = nl + 1;
      if (++pairs > 200 && !sawDxf) break;
      continue;
    }
    var nl2 = text.indexOf('\n', nl + 1);
    if (nl2 < 0) nl2 = L;
    var val = text.substring(nl + 1, nl2).trim();
    pos = nl2 + 1;
    pairs++;

    if (code === 0) {
      finishEntity();
      type = val.toUpperCase();
      if (type === 'SECTION' || type === 'EOF' || type === 'ENDSEC') sawDxf = true;
      if (type === 'ENDSEC') { closePoly(); section = ''; inBlocks = false; }
      else if (type === 'SEQEND') closePoly();
      else if (type === 'VERTEX') { if (poly) vert = { flags: 0, x: 0, y: 0, z: 0, i1: 0, i2: 0, i3: 0, i4: 0 }; }
      else {
        closePoly();
        if (type === 'POLYLINE') poly = { flags: 0, m: 0, n: 0, sm: 0, sn: 0, surf: 0, V: fmGrow(Float64Array, 256), F: fmGrow(Int32Array, 256), out: target() };
        else if (type === '3DFACE') { face.fill(0); faceHas4 = false; }
        else if (type === 'MESH') mesh = { on: false, nv: -1, nfl: -1, V: fmGrow(Float64Array, 256), F: fmGrow(Int32Array, 256), mode: 0 };
        else if (type === '3DSOLID' || type === 'BODY' || type === 'SURFACE' || type === 'REGION') solids++;
        else if ((section === 'ENTITIES' || section === '') && type !== 'SECTION' && type !== 'EOF' && type !== 'ENDBLK' && type !== 'BLOCK') state.flat++;
      }
      continue;
    }
    if (type === 'SECTION') {
      if (code === 2) { section = val.toUpperCase(); inBlocks = section === 'BLOCKS'; }
      else if (section === 'HEADER') {                // header variables follow the section name directly
        if (code === 9) headerVar = val.toUpperCase();
        else if (code === 70 && headerVar === '$INSUNITS') {
          var u = parseInt(val, 10);
          units = u === 1 ? 'in' : (u === 2 ? 'ft' : (u === 4 ? 'mm' : (u === 5 ? 'cm' : (u === 6 ? 'm' : null))));
        }
      }
      continue;
    }
    if (type === '3DFACE') {
      if (code >= 10 && code <= 33) {
        var corner = code % 10, axis = Math.floor(code / 10) - 1;
        if (corner <= 3 && axis >= 0 && axis <= 2) { face[corner * 3 + axis] = parseFloat(val); if (corner === 3) faceHas4 = true; }
      }
    } else if (type === 'POLYLINE' && poly) {
      if (code === 70) poly.flags = parseInt(val, 10) || 0;
      else if (code === 71) poly.m = parseInt(val, 10) || 0;
      else if (code === 72) poly.n = parseInt(val, 10) || 0;
      else if (code === 73) poly.sm = parseInt(val, 10) || 0;
      else if (code === 74) poly.sn = parseInt(val, 10) || 0;
      else if (code === 75) poly.surf = parseInt(val, 10) || 0;
    } else if (type === 'VERTEX' && vert) {
      if (code === 10) vert.x = parseFloat(val);
      else if (code === 20) vert.y = parseFloat(val);
      else if (code === 30) vert.z = parseFloat(val);
      else if (code === 70) vert.flags = parseInt(val, 10) || 0;
      else if (code === 71) vert.i1 = parseInt(val, 10) || 0;
      else if (code === 72) vert.i2 = parseInt(val, 10) || 0;
      else if (code === 73) vert.i3 = parseInt(val, 10) || 0;
      else if (code === 74) vert.i4 = parseInt(val, 10) || 0;
    } else if (type === 'MESH' && mesh) {
      if (code === 100) { if (/AcDbSubDMesh/i.test(val)) mesh.on = true; }
      else if (!mesh.on) { /* common entity data comes first */ }
      else if (code === 92 && mesh.nv < 0) { mesh.nv = parseInt(val, 10) || 0; mesh.mode = 1; }
      else if (code === 93 && mesh.nfl < 0) { mesh.nfl = parseInt(val, 10) || 0; mesh.mode = 2; }
      else if (code === 94 || code === 95) mesh.mode = 0;
      else if (mesh.mode === 1 && (code === 10 || code === 20 || code === 30)) {
        if (mesh.V.n < mesh.nv * 3) { fmNeed(mesh.V, 1); mesh.V.a[mesh.V.n++] = parseFloat(val); }
      } else if (mesh.mode === 2 && code === 90) {
        if (mesh.F.n < mesh.nfl) { fmNeed(mesh.F, 1); mesh.F.a[mesh.F.n++] = parseInt(val, 10); }
        if (mesh.F.n >= mesh.nfl) mesh.mode = 0;
      }
    }
  }
  finishEntity();
  closePoly();

  if (!sawDxf && main.n === 0 && blocks.n === 0) {
    throw new Error('This does not look like a DXF file. It may be damaged, or a different kind of file with the wrong name. Try exporting it again.');
  }
  var out = main;
  if (main.n === 0 && blocks.n > 0) {
    out = blocks;
    warnings.push('The 3D faces in this DXF sit inside blocks. They were loaded where the blocks were drawn, not where copies of them were placed.');
  }
  if (out.n === 0) {
    if (solids) {
      throw new Error('This DXF file holds 3D solids or surfaces (' + solids + ') stored in a form that cannot be read here. ' +
        'Export the model as STL, or as a DXF made of 3D faces (a mesh), and try again.');
    }
    throw new Error('2D drawing: this DXF file has no 3D faces in it, only flat lines and curves. Open it with the 2D drawing import instead.');
  }
  if (state.badMeshes) warnings.push(state.badMeshes + ' surface mesh' + (state.badMeshes === 1 ? '' : 'es') + ' in the DXF file could not be read and ' + (state.badMeshes === 1 ? 'was' : 'were') + ' skipped.');
  if (solids) warnings.push('The DXF file also holds ' + solids + ' 3D solid' + (solids === 1 ? '' : 's') + ' or surface' + (solids === 1 ? '' : 's') + ' stored in a form that cannot be read here; ' + (solids === 1 ? 'it was' : 'they were') + ' left out.');
  return fmFinish(out, 'dxf', 'DXF', units, warnings);
}

/* ------------------------------------------------------------------ */
/* parseModelAny                                                       */
/* ------------------------------------------------------------------ */

function fmSupportedList() {
  var s = [];
  for (var i = 0; i < MODEL_FORMATS.length; i++) s.push(MODEL_FORMATS[i].ext.toUpperCase());
  return s.slice(0, s.length - 1).join(', ') + ' or ' + s[s.length - 1];
}

/* Guess the format from the content when the name does not say. */
function fmSniff(bytes) {
  var len = bytes.length;
  if (len >= 4 && bytes[0] === 0x67 && bytes[1] === 0x6C && bytes[2] === 0x54 && bytes[3] === 0x46) return 'glb';
  if (len >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B && (bytes[2] === 3 || bytes[2] === 5) && (bytes[3] === 4 || bytes[3] === 6)) return 'zip';
  if (len >= 4 && bytes[0] === 0x70 && bytes[1] === 0x6C && bytes[2] === 0x79 && bytes[3] <= 32) return 'ply';
  var headLen = Math.min(len, 65536);
  for (var i = 0; i < headLen; i++) {
    var c = bytes[i];
    if (c < 9 || (c > 13 && c < 32 && c !== 27)) return null;
  }
  var head = fmText(bytes, 0, headLen);
  if (head.charCodeAt(0) === 0xFEFF) head = head.substring(1);
  if (/^\s*\{/.test(head) && /"(asset|meshes|buffers|accessors|scenes)"\s*:/.test(head)) return 'gltf';
  if (/^\s*(ST)?C?N?4?n?OFF(\s|$)/.test(head)) return 'off';
  if (/<amf[\s>]/i.test(head)) return 'amf';
  if (/^\s*0\s*\r?\n\s*SECTION\s*\r?\n/i.test(head) || /^\s*999\s*\r?\n/.test(head)) return 'dxf';
  return null;
}

async function parseModelAny(arrayBuffer, fileName) {
  var name = String(fileName || '');
  var dot = name.lastIndexOf('.');
  var ext = dot >= 0 ? name.substring(dot + 1).toLowerCase().trim() : '';

  if (Object.prototype.hasOwnProperty.call(fmConvertNames, ext)) {
    var ce = new Error(fmConvertNames[ext] + ' files (.' + ext + ') cannot be opened directly: they need converting to a mesh first.');
    ce.needsConvert = true;
    ce.format = ext;
    throw ce;
  }

  var res;
  if (ext === 'stl' || ext === 'obj') {
    res = parseModel(arrayBuffer, fileName);
    if (res.units === undefined) res.units = null;
    return res;
  }

  var bytes = fmBytes(arrayBuffer);
  if (!bytes) throw new Error('Could not read the file. Try exporting the model again.');
  if (bytes.length === 0) throw new Error('The file is empty.');
  if (bytes.length > 1024 * 1024 * 1024) throw new Error('The file is too large to open in the browser (over 1 GB). Export a simpler model.');

  var warnings = [], kind = ext, known = false;
  for (var i = 0; i < MODEL_FORMATS.length; i++) if (MODEL_FORMATS[i].ext === ext) known = true;
  if (!known) {
    kind = fmSniff(bytes);
    if (kind === 'zip') {
      // a ZIP with no helpful name: 3MF if it holds a .model part, AMF if it holds an .amf
      var zip = fmZipOpen(bytes, 'ZIP'), has3mf = false, hasAmf = false;
      for (var z = 0; z < zip.entries.length; z++) {
        if (/\.model$/.test(zip.entries[z].key)) has3mf = true;
        if (/\.amf$/.test(zip.entries[z].key)) hasAmf = true;
      }
      kind = has3mf ? '3mf' : (hasAmf ? 'amf' : null);
    }
    if (!kind) {
      try {
        res = parseModel(arrayBuffer, fileName);       // sniffs STL / OBJ content
      } catch (err) {
        if (!/not supported|not recognised/.test(String(err && err.message))) throw err;
        throw new Error((ext ? 'Files of type ".' + ext + '" are not a supported 3D file. ' : 'This is not a supported 3D file. ') +
          'Supported types are ' + fmSupportedList() + '. Export the model as one of those and try again.');
      }
      if (res.units === undefined) res.units = null;
      return res;
    }
  }

  if (kind === 'glb' || kind === 'gltf') return fmParseGltf(bytes, warnings);
  if (kind === '3mf') return fmParse3mf(bytes, warnings);
  if (kind === 'amf') return fmParseAmf(bytes, warnings);
  if (kind === 'ply') return fmParsePly(bytes, warnings);
  if (kind === 'off') return fmParseOff(bytes, warnings);
  return fmParseDxf(bytes, warnings);
}

if (typeof module !== 'undefined') module.exports = { parseModelAny, MODEL_FORMATS };
