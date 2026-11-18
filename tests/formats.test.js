'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib'), vm = require('vm');
const TOOLS = path.join(__dirname, '..', 'jog', 'tools');
const { parseModel, sliceModel } = require(path.join(TOOLS, 'slicer.js'));
const { parseModelAny, MODEL_FORMATS } = require(path.join(TOOLS, 'formats.js'));
const FIX = path.join(__dirname, 'fixtures');
fs.mkdirSync(FIX, { recursive: true });

let pass = 0, fail = 0; const results = [];
async function test(name, fn) {
  const t0 = process.hrtime.bigint();
  try { const note = await fn(); const ms = Number(process.hrtime.bigint() - t0) / 1e6; pass++; results.push(`PASS  ${name}  (${ms.toFixed(1)} ms)${note ? '  ' + note : ''}`); }
  catch (e) { fail++; results.push(`FAIL  ${name}: ${e && e.stack || e}`); }
}
function ok(c, msg) { if (!c) throw new Error('assert: ' + msg); }
function near(a, b, tol, msg) { if (!(Math.abs(a - b) <= tol)) throw new Error(`assert: ${msg}: got ${a}, want ${b}`); }
function save(name, data) { const p = path.join(FIX, name); fs.writeFileSync(p, data); return p; }
function load(name) { const b = fs.readFileSync(path.join(FIX, name)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
async function rt(name, data) { save(name, data); return parseModelAny(load(name), name); }
async function throwsMsg(fn) { try { await fn(); } catch (e) { return e; } throw new Error('assert: expected an error'); }
function plain(e) {   // plain-English: not a JS engine error
  ok(e && typeof e.message === 'string' && e.message.length > 15, 'has message');
  ok(e.constructor && e.constructor.name === 'Error', 'plain Error, got ' + (e.constructor && e.constructor.name) + ': ' + e.message);
  ok(!/undefined|null|NaN|is not a function|Cannot read|RangeError|Invalid typed array|offset is out/i.test(e.message), 'plain message: ' + e.message);
}

/* ---------- reference meshes ---------- */
const LP = [[0, 0], [40, 0], [40, 10], [15, 10], [15, 30], [0, 30]];
const OFFS = [5, -7, 3];                       // asymmetric placement
function lVerts() { const v = []; for (const z of [0, 20]) for (const p of LP) v.push([p[0] + OFFS[0], p[1] + OFFS[1], z + OFFS[2]]); return v; }
function lPolys() {                            // 2 hexagons + 6 quads, outward
  const f = [[6, 7, 8, 9, 10, 11], [0, 5, 4, 3, 2, 1]];
  for (let i = 0; i < 6; i++) { const j = (i + 1) % 6; f.push([i, j, j + 6, i + 6]); }
  return f;
}
function lQuadTri() {                          // caps as triangles, sides as quads (for <=4-corner formats)
  const f = [[6, 7, 8], [6, 8, 9], [6, 9, 11], [9, 10, 11], [0, 2, 1], [0, 3, 2], [0, 5, 3], [3, 5, 4]];
  for (let i = 0; i < 6; i++) { const j = (i + 1) % 6; f.push([i, j, j + 6, i + 6]); }
  return f;
}
function fan(polys) { const t = []; for (const f of polys) for (let k = 1; k + 1 < f.length; k++) t.push([f[0], f[k], f[k + 1]]); return t; }
const L = { v: lVerts(), polys: lPolys(), qt: lQuadTri() }; L.tris = fan(L.polys);
const LREF = { count: 20, min: [5, -7, 3], max: [45, 23, 23], area: 4200, vol: 14000 };
function cubeMesh(s) {
  const v = []; for (let i = 0; i < 8; i++) v.push([(i & 1) * s, ((i >> 1) & 1) * s, ((i >> 2) & 1) * s]);
  const polys = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  return { v, polys, tris: fan(polys) };
}
const CUBE = cubeMesh(10);
const CREF = { count: 12, min: [0, 0, 0], max: [10, 10, 10], area: 600, vol: 1000 };

function measure(m) {
  let area = 0, vol = 0; const t = m.tris;
  for (let p = 0; p < t.length; p += 9) {
    const ax = t[p], ay = t[p + 1], az = t[p + 2], bx = t[p + 3], by = t[p + 4], bz = t[p + 5], cx = t[p + 6], cy = t[p + 7], cz = t[p + 8];
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    area += Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return { area, vol };
}
function check(m, ref, fmt, units, tol) {
  tol = tol || 1e-3;
  ok(m.tris instanceof Float32Array && m.tris.length === m.count * 9, 'tris shape');
  ok(Array.isArray(m.warnings), 'warnings array');
  ok(m.count === ref.count, `count ${m.count} != ${ref.count}`);
  for (let k = 0; k < 3; k++) { near(m.min[k], ref.min[k], tol, 'min' + k); near(m.max[k], ref.max[k], tol, 'max' + k); }
  const q = measure(m);
  near(q.area, ref.area, ref.area * 1e-4, 'area'); near(q.vol, ref.vol, Math.abs(ref.vol) * 1e-4, 'signed volume');
  if (fmt) ok(m.format === fmt, `format ${m.format} != ${fmt}`);
  if (units !== undefined) ok(m.units === units, `units ${m.units} != ${units}`);
}
function hasCorner(m, c, tol) {
  const t = m.tris; for (let p = 0; p < t.length; p += 3) if (Math.abs(t[p] - c[0]) < tol && Math.abs(t[p + 1] - c[1]) < tol && Math.abs(t[p + 2] - c[2]) < tol) return true; return false;
}
function sameTris(m, exp, tol) {
  ok(m.count === exp.length / 9, `count ${m.count} != ${exp.length / 9}`);
  for (let i = 0; i < exp.length; i++) if (!(Math.abs(m.tris[i] - exp[i]) <= tol)) throw new Error(`assert: tri float ${i}: got ${m.tris[i]}, want ${exp[i]}`);
}

/* ---------- writers ---------- */
const toGltf = p => [p[0], p[2], -p[1]];      // inverse of the importer's (x,y,z)->(x,-z,y)
function glb(json, bin) {
  let js = Buffer.from(JSON.stringify(json)); while (js.length % 4) js = Buffer.concat([js, Buffer.from(' ')]);
  const parts = [Buffer.alloc(12), Buffer.alloc(8), js];
  parts[1].writeUInt32LE(js.length, 0); parts[1].writeUInt32LE(0x4E4F534A, 4);
  if (bin) { let b = Buffer.from(bin); while (b.length % 4) b = Buffer.concat([b, Buffer.alloc(1)]); const h = Buffer.alloc(8); h.writeUInt32LE(b.length, 0); h.writeUInt32LE(0x004E4942, 4); parts.push(h, b); }
  const out = Buffer.concat(parts); out.writeUInt32LE(0x46546C67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8); return out;
}
function f32(verts) { const b = Buffer.alloc(verts.length * 12); verts.forEach((v, i) => { b.writeFloatLE(v[0], i * 12); b.writeFloatLE(v[1], i * 12 + 4); b.writeFloatLE(v[2], i * 12 + 8); }); return b; }
function simpleGltf(mesh, idxType, extraNode) {      // one mesh, positions + optional indices
  const gv = mesh.v.map(toGltf); let pos, idx = null, json;
  if (idxType === 'none') { const flat = []; mesh.tris.forEach(t => t.forEach(i => flat.push(gv[i]))); pos = f32(flat); }
  else {
    pos = f32(gv); const flat = [].concat(...mesh.tris);
    if (idxType === 'u16') { idx = Buffer.alloc(flat.length * 2); flat.forEach((v, i) => idx.writeUInt16LE(v, i * 2)); }
    else if (idxType === 'u8') { idx = Buffer.from(flat); }
    else { idx = Buffer.alloc(flat.length * 4); flat.forEach((v, i) => idx.writeUInt32LE(v, i * 4)); }
  }
  let padIdx = idx ? Buffer.concat([idx, Buffer.alloc((4 - idx.length % 4) % 4)]) : Buffer.alloc(0);
  const bin = Buffer.concat([padIdx, pos]);
  json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [Object.assign({ mesh: 0 }, extraNode || {})],
    meshes: [{ primitives: [{ attributes: { POSITION: idx ? 1 : 0 }, mode: 4 }] }],
    buffers: [{ byteLength: bin.length }], bufferViews: [], accessors: [] };
  if (idx) {
    json.bufferViews.push({ buffer: 0, byteOffset: 0, byteLength: idx.length }, { buffer: 0, byteOffset: padIdx.length, byteLength: pos.length });
    json.accessors.push({ bufferView: 0, componentType: idxType === 'u16' ? 5123 : idxType === 'u8' ? 5121 : 5125, count: idx.length / (idxType === 'u16' ? 2 : idxType === 'u8' ? 1 : 4), type: 'SCALAR' },
      { bufferView: 1, componentType: 5126, count: pos.length / 12, type: 'VEC3' });
    json.meshes[0].primitives[0].indices = 0;
  } else {
    json.bufferViews.push({ buffer: 0, byteOffset: 0, byteLength: pos.length });
    json.accessors.push({ bufferView: 0, componentType: 5126, count: pos.length / 12, type: 'VEC3' });
  }
  return { json, bin };
}
function crc32(buf) { return zlib.crc32 ? zlib.crc32(buf) : 0; }
function zipWrite(files) {                             // files: [{name, data, deflate}]
  const locals = [], central = []; let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name), raw = Buffer.from(f.data), body = f.deflate ? zlib.deflateRawSync(raw) : raw;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(f.deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(f.deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, name, body); central.push(ch, name); off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}
const RELS = `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
const CT = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
function meshXml(mesh, scale) {
  scale = scale || 1; const s = ['<mesh><vertices>'];
  for (const v of mesh.v) s.push(`<vertex x="${v[0] * scale}" y="${v[1] * scale}" z="${v[2] * scale}"/>`);
  s.push('</vertices><triangles>');
  for (const t of mesh.tris) s.push(`<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>`);
  s.push('</triangles></mesh>'); return s.join('');
}
function dxfFace(c) { const s = ['0', '3DFACE', '8', '0']; c.forEach((p, i) => s.push('1' + i, p[0], '2' + i, p[1], '3' + i, p[2])); return s; }
function dxfWrap(ent, header) { return [].concat(header || [], ['0', 'SECTION', '2', 'ENTITIES'], ent, ['0', 'ENDSEC', '0', 'EOF']).join('\r\n') + '\r\n'; }

/* ---------- row-vector 3MF math for expectations ---------- */
function apply3mf(m, p) { return [p[0] * m[0] + p[1] * m[3] + p[2] * m[6] + m[9], p[0] * m[1] + p[1] * m[4] + p[2] * m[7] + m[10], p[0] * m[2] + p[1] * m[5] + p[2] * m[8] + m[11]]; }
function trisOf(mesh, f) { const out = []; for (const t of mesh.tris) for (const i of t) out.push(...f(mesh.v[i])); return out; }

(async () => {
  /* ===== STL / OBJ through parseModelAny ===== */
  await test('STL binary via parseModelAny', async () => {
    const b = Buffer.alloc(84 + 50 * L.tris.length); b.writeUInt32LE(L.tris.length, 80);
    L.tris.forEach((t, i) => t.forEach((vi, k) => L.v[vi].forEach((c, a) => b.writeFloatLE(c, 84 + i * 50 + 12 + k * 12 + a * 4))));
    const m = await rt('l.stl', b); check(m, LREF, 'stl-binary', null);
  });
  await test('STL ascii via parseModelAny (content sniff, no extension)', async () => {
    let s = 'solid l\n'; L.tris.forEach(t => { s += 'facet normal 0 0 0\nouter loop\n'; t.forEach(i => s += `vertex ${L.v[i].join(' ')}\n`); s += 'endloop\nendfacet\n'; }); s += 'endsolid\n';
    save('l_ascii', s); check(await parseModelAny(load('l_ascii'), 'l_ascii'), LREF, 'stl-ascii', null);
  });
  await test('OBJ via parseModelAny', async () => {
    let s = ''; L.v.forEach(v => s += `v ${v.join(' ')}\n`); L.polys.forEach(f => s += 'f ' + f.map(i => i + 1).join(' ') + '\n');
    check(await rt('l.obj', s), LREF, 'obj', null);
    const direct = parseModel(load('l.obj'), 'l.obj'); ok(direct.count === 20, 'parseModel same');
  });

  /* ===== glTF ===== */
  for (const it of ['u16', 'u32', 'u8', 'none']) {
    await test('GLB ' + (it === 'none' ? 'non-indexed' : 'indexed ' + it) + ' (upright, not mirrored)', async () => {
      const g = simpleGltf(L, it); const m = await rt(`l_${it}.glb`, glb(g.json, g.bin));
      check(m, LREF, 'glb', 'm');
      // glTF +Y (up) must become +Z; specific corners land where the Z-up reference has them
      ok(hasCorner(m, [45, -7, 3], 1e-4) && hasCorner(m, [20, 23, 23], 1e-4) && hasCorner(m, [5, 23, 3], 1e-4), 'corner positions');
      sameTris(m, trisOf(L, p => p), 1e-4);
    });
  }
  await test('GLB byteStride + accessor byteOffset (interleaved)', async () => {
    const gv = L.v.map(toGltf), stride = 24, pre = 8; const bin = Buffer.alloc(pre + 4 + gv.length * stride);
    gv.forEach((v, i) => { for (let k = 0; k < 3; k++) { bin.writeFloatLE(v[k], pre + 4 + i * stride + k * 4); bin.writeFloatLE(99, pre + 4 + i * stride + 12 + k * 4); } });
    const idx = Buffer.alloc(L.tris.length * 6); [].concat(...L.tris).forEach((v, i) => idx.writeUInt16LE(v, i * 2));
    const all = Buffer.concat([bin, idx]);
    const json = { asset: { version: '2.0' }, nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }], buffers: [{ byteLength: all.length }],
      bufferViews: [{ buffer: 0, byteOffset: pre, byteLength: bin.length - pre, byteStride: stride }, { buffer: 0, byteOffset: bin.length, byteLength: idx.length }],
      accessors: [{ bufferView: 0, byteOffset: 4, componentType: 5126, count: 12, type: 'VEC3' }, { bufferView: 0, byteOffset: 16, componentType: 5126, count: 12, type: 'VEC3' }, { bufferView: 1, componentType: 5123, count: 60, type: 'SCALAR' }] };
    check(await rt('l_stride.glb', glb(json, all)), LREF, 'glb', 'm');     // no scene: root nodes
  });
  await test('GLB quantized positions (int16 normalized + node scale)', async () => {
    const gv = CUBE.v.map(toGltf); const pos = Buffer.alloc(8 * 8);   // stride 8 (aligned)
    gv.forEach((v, i) => v.forEach((c, k) => pos.writeInt16LE(Math.round(c / 10 * 32767), i * 8 + k * 2)));
    const idx = Buffer.from([].concat(...CUBE.tris)); const all = Buffer.concat([pos, idx]);
    const json = { asset: { version: '2.0' }, extensionsUsed: ['KHR_mesh_quantization'], extensionsRequired: ['KHR_mesh_quantization'], scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, scale: [10, 10, 10] }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }], buffers: [{ byteLength: all.length }],
      bufferViews: [{ buffer: 0, byteLength: 64, byteStride: 8 }, { buffer: 0, byteOffset: 64, byteLength: 36 }],
      accessors: [{ bufferView: 0, componentType: 5122, normalized: true, count: 8, type: 'VEC3' }, { bufferView: 1, componentType: 5121, count: 36, type: 'SCALAR' }] };
    const m = await rt('cube_quant.glb', glb(json, all));
    check(m, CREF, 'glb', 'm', 2e-3);
  });
  await test('GLB node hierarchy: TRS parent, matrix child, two instances of one mesh', async () => {
    const g = simpleGltf(L, 'u16');
    // rotation: 90 deg about glTF Y; quaternion (0, sin45, 0, cos45)
    const s = Math.SQRT1_2, T = [100, 20, -30], S = [2, 3, 0.5];
    const M = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, -8, 9, 1];       // column-major translation (7,-8,9)
    const M2 = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, -50, 0, 0, 1];      // rot 90 about Z then translate
    g.json.nodes = [{ translation: T, rotation: [0, s, 0, s], scale: S, children: [1] }, { matrix: M, mesh: 0 }, { matrix: M2, mesh: 0 }, { name: 'empty', children: [] }];
    g.json.scenes = [{ nodes: [0, 2, 3] }]; g.json.scene = 0;
    const m = await rt('l_nodes.glb', glb(g.json, g.bin));
    const rotY = p => [p[2], p[1], -p[0]];                                // 90 deg about Y: x->-z, z->x
    const inst1 = p => { let q = toGltf(p); q = [q[0] + 7, q[1] - 8, q[2] + 9]; q = [q[0] * S[0], q[1] * S[1], q[2] * S[2]]; q = rotY(q); q = [q[0] + T[0], q[1] + T[1], q[2] + T[2]]; return [q[0], -q[2], q[1]]; };
    const inst2 = p => { let q = toGltf(p); q = [-q[1] - 50, q[0], q[2]]; return [q[0], -q[2], q[1]]; };
    sameTris(m, trisOf(L, inst1).concat(trisOf(L, inst2)), 2e-3);
    const q = measure(m); near(q.vol, 14000 * 3 + 14000, 2, 'volume (scale det 3 + plain copy)');
    ok(m.count === 40 && m.units === 'm', 'two instances');
  });
  await test('GLB mirrored node (negative scale) keeps faces outward', async () => {
    const g = simpleGltf(L, 'u16', { scale: [-1, 1, 1] }); const m = await rt('l_mirror.glb', glb(g.json, g.bin));
    const q = measure(m); near(q.vol, 14000, 1, 'volume stays positive'); near(m.min[0], -45, 1e-3, 'mirrored x');
  });
  await test('GLB triangle strip + triangle fan (winding)', async () => {
    const pts = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 2, 0], [1, 2, 0]];           // strip in glTF XY, normal +Z
    const fanp = [[5, 0, 0], [6, 0, 0], [6, 1, 0], [5.5, 2, 0], [5, 1, 0]];                     // ccw fan, normal +Z
    const bin = Buffer.concat([f32(pts), f32(fanp), Buffer.from([0, 1, 2, 3, 4, 0, 0, 0])]);
    const json = { asset: { version: '2.0' }, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], buffers: [{ byteLength: bin.length }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 5 }, { attributes: { POSITION: 1 }, indices: 2, mode: 6 }, { attributes: { POSITION: 0 }, mode: 1 }] }],
      bufferViews: [{ buffer: 0, byteLength: 72 }, { buffer: 0, byteOffset: 72, byteLength: 60 }, { buffer: 0, byteOffset: 132, byteLength: 5 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 6, type: 'VEC3' }, { bufferView: 1, componentType: 5126, count: 5, type: 'VEC3' }, { bufferView: 2, componentType: 5121, count: 5, type: 'SCALAR' }] };
    const m = await rt('strip.glb', glb(json, bin)); ok(m.count === 4 + 3, 'count ' + m.count);
    const t = m.tris; let area = 0;
    for (let p = 0; p < t.length; p += 9) {   // glTF +Z normal -> app -Y normal for every triangle
      const ny = (t[p + 5] - t[p + 2]) * (t[p + 6] - t[p]) - (t[p + 3] - t[p]) * (t[p + 8] - t[p + 2]); ok(ny < 0, 'normal y ' + ny + ' at tri ' + p / 9); area += -ny / 2;
    }
    near(area, 2 + 1.5, 1e-5, 'area'); ok(m.warnings.some(w => /points or lines/.test(w)), 'line primitive warning');
  });
  await test('glTF JSON with base64 buffer', async () => {
    const g = simpleGltf(L, 'u16'); g.json.buffers[0].uri = 'data:application/octet-stream;base64,' + g.bin.toString('base64');
    check(await rt('l.gltf', JSON.stringify(g.json, null, 1)), LREF, 'gltf', 'm');
    save('l_gltf_noext', JSON.stringify(g.json)); check(await parseModelAny(load('l_gltf_noext'), 'model'), LREF, 'gltf', 'm');
  });
  await test('glTF external .bin -> plain error naming .glb', async () => {
    const g = simpleGltf(L, 'u16'); g.json.buffers[0].uri = 'model.bin';
    const e = await throwsMsg(() => rt('l_ext.gltf', JSON.stringify(g.json))); plain(e); ok(/single \.glb/.test(e.message), e.message);
  });
  await test('glTF Draco / meshopt / sparse -> clear errors', async () => {
    let g = simpleGltf(L, 'u16'); g.json.meshes[0].primitives[0].extensions = { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0 } } };
    let e = await throwsMsg(() => rt('l_draco.glb', glb(g.json, g.bin))); plain(e); ok(/Draco/.test(e.message) && /Re-export without compression/i.test(e.message), e.message);
    g = simpleGltf(L, 'u16'); g.json.bufferViews[1].extensions = { EXT_meshopt_compression: {} };
    e = await throwsMsg(() => rt('l_meshopt.glb', glb(g.json, g.bin))); plain(e); ok(/meshopt/.test(e.message) && /Re-export without compression/i.test(e.message), e.message);
    g = simpleGltf(L, 'u16'); g.json.accessors[1].sparse = { count: 1 };
    e = await throwsMsg(() => rt('l_sparse.glb', glb(g.json, g.bin))); plain(e); ok(/sparse/.test(e.message), e.message);
  });
  await test('GLB truncated at many lengths -> plain errors, no crash', async () => {
    const g = simpleGltf(L, 'u16'); const full = glb(g.json, g.bin); let n = 0;
    for (let len = 1; len < full.length; len += 7) {
      const part = full.subarray(0, len); const e = await throwsMsg(() => parseModelAny(part.buffer.slice(part.byteOffset, part.byteOffset + len), 'cut.glb')); plain(e); n++;
    }
    return n + ' cut points';
  });

  /* ===== 3MF ===== */
  const T1 = [0, 1, 0, -1, 0, 0, 0, 0, 1, 10, 20, 30];        // rot +90 about Z (row vectors) + translate
  const T2 = [2, 0, 0, 0, 2, 0, 0, 0, 2, -5, 0, 4];           // scale 2 + translate
  const model3mf = (unit, body, build) => `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="${unit}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">\n <metadata name="Title">a &lt;b&gt; "c"</metadata>\n <resources>${body}</resources>\n <build>${build}</build>\n</model>`;
  const exp3mf = trisOf(L, p => apply3mf(T2, apply3mf(T1, p)));
  for (const variant of ['deflated model', 'stored model']) {
    await test('3MF ' + variant + ', component + build transforms, unit inch', async () => {
      const xml = model3mf('inch', `<object id="1" type="model">${meshXml(L)}</object><!-- wrapper --><object type='model' id='2'><components><component transform="${T1.join(' ')}" objectid="1" /></components></object>`,
        `<item transform = '${T2.join(' ')}' objectid="2"/>`);
      const z = zipWrite([{ name: '[Content_Types].xml', data: CT, deflate: variant !== 'deflated model' }, { name: '_rels/.rels', data: RELS, deflate: variant !== 'deflated model' }, { name: '3D/3dmodel.model', data: xml, deflate: variant === 'deflated model' }]);
      const m = await rt(variant === 'deflated model' ? 'l_defl.3mf' : 'l_stored.3mf', z);
      sameTris(m, exp3mf, 1e-3); ok(m.units === 'in' && m.format === '3mf', 'units/format'); near(measure(m).vol, 14000 * 8, 5, 'volume'); near(measure(m).area, 4200 * 4, 1, 'area');
      // corner check by hand: (45,-7,3) -> T1: (-y+10, x+20, z+30) = (17, 65, 33) -> T2: (29, 130, 70)
      ok(hasCorner(m, [29, 130, 70], 1e-3), 'hand-computed corner');
    });
  }
  await test('3MF micron unit -> mm, prefixed tags, no rels (fallback path), no transforms', async () => {
    let xml = model3mf('micron', `<object id="7">${meshXml(L, 1000)}</object>`, `<item objectid="7"/>`);
    xml = xml.replace(/<(\/?)(model|resources|object|mesh|vertices|vertex|triangles|triangle|build|item|metadata)/g, '<$1m:$2').replace('xmlns=', 'xmlns:m=');
    const m = await rt('l_micron.3mf', zipWrite([{ name: '3D/3dmodel.model', data: xml, deflate: true }])); check(m, LREF, '3mf', 'mm');
  });
  await test('3MF production layout (object in another part via p:path), unknown-name ZIP sniff', async () => {
    const sub = model3mf('millimeter', `<object id="4">${meshXml(L)}</object>`, '');
    const root = model3mf('millimeter', `<object id="1"><components><component p:path="/3D/Objects/part_1.model" objectid="4"/></components></object>`, `<item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`);
    const z = zipWrite([{ name: '_rels/.rels', data: RELS, deflate: true }, { name: '3D/Objects/part_1.model', data: sub, deflate: true }, { name: '3D/3dmodel.model', data: root, deflate: true }]);
    check(await rt('l_prod.3mf', z), LREF, '3mf', 'mm'); save('l_prod_noext', z); check(await parseModelAny(load('l_prod_noext'), 'download'), LREF, '3mf', 'mm');
  });
  await test('ZIP/3MF truncated at many lengths + corrupt deflate + ZIP64 marker -> plain errors, no hang', async () => {
    const xml = model3mf('millimeter', `<object id="1">${meshXml(L)}</object>`, `<item objectid="1"/>`);
    const full = zipWrite([{ name: '_rels/.rels', data: RELS, deflate: false }, { name: '3D/3dmodel.model', data: xml, deflate: true }]); let n = 0;
    for (let len = 1; len < full.length; len += 13) { const part = Buffer.from(full.subarray(0, len)); const e = await throwsMsg(() => parseModelAny(part.buffer.slice(part.byteOffset, part.byteOffset + len), 'cut.3mf')); plain(e); n++; }
    // central directory intact but compressed bytes scrambled / shortened
    const bad = Buffer.from(full); const at = bad.indexOf('3D/3dmodel.model', bad.indexOf('3D/3dmodel.model') + 1) + 16; ok(bad.readUInt32LE(at - 46) === 0x04034b50, 'found local header'); for (let i = 0; i < 40; i++) bad[at + 5 + i] ^= 0xA5;
    let e = await throwsMsg(() => rt('bad_deflate.3mf', bad)); plain(e); ok(/damaged|cut short/.test(e.message), e.message);
    const z64 = Buffer.from(full); z64.writeUInt32LE(0xFFFFFFFF, z64.length - 6); e = await throwsMsg(() => rt('z64.3mf', z64)); plain(e); ok(/ZIP64/.test(e.message), e.message);
    return n + ' cut points';
  });

  /* ===== PLY ===== */
  function plyHeader(fmt, withExtras) {
    return ['ply', `format ${fmt} 1.0`, 'comment made by test', 'obj_info x',
      ...(withExtras ? ['element camera 1', 'property float view_px', 'property double view_py', 'element material 2', 'property uchar id', 'property list uchar float coeffs', 'property short tail'] : []),
      `element vertex ${L.v.length}`, 'property float nx', 'property double x', 'property uchar red', 'property float y', 'property short z', 'property float quality',
      `element face ${L.polys.length}`, 'property uchar flag', 'property list uchar int vertex_indices', 'property list ushort float texcoord', 'property float fq',
      ...(withExtras ? ['element edge 2', 'property int vertex1', 'property int vertex2'] : []), 'end_header'].join('\n') + '\n';
  }
  await test('PLY ascii (extra properties, extra elements before/after, polygon faces)', async () => {
    let s = plyHeader('ascii', true) + '0.5 1.5\n1 3 0.1 0.2 0.3 -4\n2 0 9\n';
    L.v.forEach(v => s += `0.1 ${v[0]} 255 ${v[1]} ${v[2]} 0.25\n`);
    L.polys.forEach(f => s += `1 ${f.length} ${f.join(' ')} 2 0.5 0.5 1.25\n`); s += '0 1\n1 2\n';
    check(await rt('l_ascii.ply', s.replace(/\n/g, '\r\n')), LREF, 'ply-ascii', null);
  });
  for (const le of [true, false]) {
    await test('PLY binary ' + (le ? 'little' : 'big') + ' endian (mixed types, list skipping, quads+hexagons)', async () => {
      const parts = [Buffer.from(plyHeader(le ? 'binary_little_endian' : 'binary_big_endian', true))];
      const W = (n, fn) => { const b = Buffer.alloc(n); fn(b); parts.push(b); };
      const f32w = (b, v, o) => le ? b.writeFloatLE(v, o) : b.writeFloatBE(v, o), f64w = (b, v, o) => le ? b.writeDoubleLE(v, o) : b.writeDoubleBE(v, o);
      const i16w = (b, v, o) => le ? b.writeInt16LE(v, o) : b.writeInt16BE(v, o), i32w = (b, v, o) => le ? b.writeInt32LE(v, o) : b.writeInt32BE(v, o), u16w = (b, v, o) => le ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o);
      W(12, b => { f32w(b, 0.5, 0); f64w(b, 1.5, 4); });
      W(1 + 1 + 12 + 2, b => { b[0] = 1; b[1] = 3; f32w(b, 1, 2); f32w(b, 2, 6); f32w(b, 3, 10); i16w(b, -4, 14); });
      W(1 + 1 + 2, b => { b[0] = 2; b[1] = 0; i16w(b, 9, 2); });
      L.v.forEach(v => W(4 + 8 + 1 + 4 + 2 + 4, b => { f32w(b, 0.1, 0); f64w(b, v[0], 4); b[12] = 255; f32w(b, v[1], 13); i16w(b, v[2], 17); f32w(b, 0.25, 19); }));
      L.polys.forEach(f => W(1 + 1 + 4 * f.length + 2 + 8 + 4, b => { b[0] = 1; b[1] = f.length; f.forEach((v, k) => i32w(b, v, 2 + k * 4)); let o = 2 + 4 * f.length; u16w(b, 2, o); f32w(b, 0.5, o + 2); f32w(b, 0.5, o + 6); f32w(b, 1.25, o + 10); }));
      W(16, b => { i32w(b, 0, 0); i32w(b, 1, 4); i32w(b, 1, 8); i32w(b, 2, 12); });
      const full = Buffer.concat(parts); check(await rt(le ? 'l_le.ply' : 'l_be.ply', full), LREF, 'ply-binary', null);
      if (le) { save('l_ply_noext', full); check(await parseModelAny(load('l_ply_noext'), 'scan.bin'), LREF, 'ply-binary', null); }
      let n = 0; for (let len = 4; len < full.length; len += 11) { const part = Buffer.from(full.subarray(0, len)); const e = await throwsMsg(() => parseModelAny(part.buffer.slice(part.byteOffset, part.byteOffset + len), 'cut.ply')); plain(e); n++; }
      return n + ' cut points also checked';
    });
  }
  await test('PLY quad faces (cube, vertex_index name, faces listed before vertices)', async () => {
    let s = 'ply\nformat ascii 1.0\nelement face 6\nproperty list uint8 uint32 vertex_index\nelement vertex 8\nproperty float32 x\nproperty float32 y\nproperty float32 z\nend_header\n';
    CUBE.polys.forEach(f => s += `4 ${f.join(' ')}\n`); CUBE.v.forEach(v => s += v.join(' ') + '\n');
    check(await rt('cube.ply', s), CREF, 'ply-ascii', null);
  });
  await test('PLY point cloud -> plain error', async () => {
    let s = 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n1 0 0\n0 1 0\n';
    let e = await throwsMsg(() => rt('cloud.ply', s)); plain(e); ok(/point cloud/.test(e.message), e.message);
    s = s.replace('end_header', 'element face 0\nproperty list uchar int vertex_indices\nend_header');
    e = await throwsMsg(() => rt('cloud2.ply', s)); plain(e); ok(/point cloud/.test(e.message), e.message);
  });

  /* ===== OFF ===== */
  await test('OFF (comments, header counts on one line or next, polygons)', async () => {
    let s = '# made by test\nOFF\n# counts\n12 8 0\n'; L.v.forEach(v => s += v.join(' ') + '  # pt\n'); s += '\n'; L.polys.forEach(f => s += `${f.length}  ${f.join(' ')}\n`);
    check(await rt('l.off', s), LREF, 'off', null);
    let s2 = 'OFF 12 8 18\r\n'; L.v.forEach(v => s2 += v.join('\t') + '\r\n'); L.polys.forEach(f => s2 += `${f.length} ${f.join(' ')}\r\n`);
    check(await rt('l2.off', s2), LREF, 'off', null); save('l_off_noext', s2); check(await parseModelAny(load('l_off_noext'), 'thing'), LREF, 'off', null);
  });
  await test('COFF / NOFF / STCNOFF (extra per-vertex data, face colours)', async () => {
    let s = 'COFF\n12 8 0\n'; L.v.forEach(v => s += v.join(' ') + ' 255 0 0 255\n'); L.polys.forEach(f => s += `${f.length} ${f.join(' ')} 0.5 0.5 0.5\n`);
    check(await rt('l_c.off', s), LREF, 'off', null);
    s = 'NOFF\n12 8 0\n'; L.v.forEach(v => s += v.join(' ') + ' 0 0 1\n'); L.polys.forEach(f => s += `${f.length} ${f.join(' ')}\n`); check(await rt('l_n.off', s), LREF, 'off', null);
    s = 'STCNOFF\n12 8 0\n'; L.v.forEach(v => s += v.join(' ') + ' 0 0 1 1 1 1 1 0.5 0.5\n'); L.polys.forEach(f => s += `${f.length} ${f.join(' ')}\n`); check(await rt('l_stcn.off', s), LREF, 'off', null);
  });

  /* ===== AMF ===== */
  const amf = (unit) => { const s = [`<?xml version="1.0" encoding="utf-8"?>\n<amf unit="${unit}" version="1.1">\n <metadata type="name">L</metadata>\n <object id="0">\n  <mesh>\n   <vertices>`];
    L.v.forEach(v => s.push(`<vertex><coordinates><x>${v[0]}</x><y> ${v[1]} </y>\n<z>${v[2].toExponential()}</z></coordinates><normal><nx>0</nx><ny>0</ny><nz>1</nz></normal></vertex>`));
    s.push('<edge><v1>0</v1><dx1>1</dx1><v2>1</v2></edge></vertices>');
    const half = L.tris.length / 2; s.push('<volume materialid="1"><metadata type="name">a</metadata>'); L.tris.slice(0, half).forEach(t => s.push(`<triangle><v1>${t[0]}</v1><v2>${t[1]}</v2><v3>${t[2]}</v3></triangle>`));
    s.push('</volume><volume>'); L.tris.slice(half).forEach(t => s.push(`<triangle>\n<v1>${t[0]}</v1>\n<v2>${t[1]}</v2>\n<v3>${t[2]}</v3>\n</triangle>`)); s.push('</volume></mesh></object>');
    // second object with its own vertex numbering: a cube far away is NOT added here to keep the reference; indices restart check below
    s.push('</amf>'); return s.join('\n'); };
  await test('AMF plain (unit inch, two volumes, edges/normals ignored)', async () => { check(await rt('l.amf', amf('inch')), LREF, 'amf', 'in'); });
  await test('AMF zipped (deflate) + two objects with separate vertex numbering', async () => {
    check(await rt('l_zip.amf', zipWrite([{ name: 'l.amf', data: amf('millimeter'), deflate: true }])), LREF, 'amf-zip', 'mm');
    let two = '<amf unit="feet">'; for (const dx of [0, 100]) { two += '<object id="' + dx + '"><mesh><vertices>'; CUBE.v.forEach(v => two += `<vertex><coordinates><x>${v[0] + dx}</x><y>${v[1]}</y><z>${v[2]}</z></coordinates></vertex>`); two += '</vertices><volume>'; CUBE.tris.forEach(t => two += `<triangle><v1>${t[0]}</v1><v2>${t[1]}</v2><v3>${t[2]}</v3></triangle>`); two += '</volume></mesh></object>'; } two += '</amf>';
    check(await rt('two.amf', two), { count: 24, min: [0, 0, 0], max: [110, 10, 10], area: 1200, vol: 2000 }, 'amf', 'ft');
  });

  /* ===== DXF ===== */
  await test('DXF 3DFACE triangles + quads, $INSUNITS inch', async () => {
    const ent = []; L.qt.forEach(f => { const c = f.map(i => L.v[i]); if (c.length === 3) c.push(c[2]); ent.push(...dxfFace(c)); });
    ent.push('0', 'LINE', '8', '0', '10', '0', '20', '0', '30', '0', '11', '5', '21', '5', '31', '0');
    const hdr = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1015', '9', '$INSUNITS', '70', '     1', '9', '$EXTMIN', '10', '0', '20', '0', '30', '0', '0', 'ENDSEC'];
    check(await rt('l_3dface.dxf', dxfWrap(ent, hdr)), LREF, 'dxf', 'in');
    // three-corner 3DFACE with no 4th point at all, no header, bare LF, leading spaces on codes
    const ent2 = []; L.tris.forEach(t => { ent2.push(...dxfFace(t.map(i => L.v[i]))); });
    const m = await rt('l_3dface_tri.dxf', dxfWrap(ent2).replace(/\r\n/g, '\n').replace(/^(\d+)$/gm, '  $1')); check(m, LREF, 'dxf', null);
    save('l_dxf_noext', dxfWrap(ent2)); check(await parseModelAny(load('l_dxf_noext'), 'drawing'), LREF, 'dxf', null);
  });
  await test('DXF polyface mesh (flag 64, negative = hidden edge), $INSUNITS mm', async () => {
    const ent = ['0', 'POLYLINE', '8', '0', '66', '1', '70', '64', '71', String(L.v.length), '72', String(L.qt.length)];
    L.v.forEach(v => ent.push('0', 'VERTEX', '8', '0', '10', v[0], '20', v[1], '30', v[2], '70', '192'));
    L.qt.forEach(f => { ent.push('0', 'VERTEX', '8', '0', '10', '0', '20', '0', '30', '0', '70', '128'); f.forEach((i, k) => ent.push(String(71 + k), String((k === 1 ? -1 : 1) * (i + 1)))); });
    ent.push('0', 'SEQEND');
    const hdr = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC'];
    check(await rt('l_polyface.dxf', dxfWrap(ent, hdr)), LREF, 'dxf', 'mm');
  });
  await test('DXF polygon mesh (flag 16) open grid and closed tube', async () => {
    const M = 3, N = 4; let ent = ['0', 'POLYLINE', '70', '16', '71', String(M), '72', String(N)];
    for (let i = 0; i < M; i++) for (let j = 0; j < N; j++) ent.push('0', 'VERTEX', '10', i * 10, '20', j * 5, '30', 2, '70', '64'); ent.push('0', 'SEQEND');
    let m = await rt('grid.dxf', dxfWrap(ent)); ok(m.count === 12, 'count ' + m.count); near(measure(m).area, 20 * 15, 1e-3, 'area');
    // square tube closed in N (flag 32): 4 x 4 ring, height 30
    const ring = [[0, 0], [10, 0], [10, 10], [0, 10]]; ent = ['0', 'POLYLINE', '70', String(16 + 32), '71', '4', '72', '4'];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) ent.push('0', 'VERTEX', '10', ring[j][0], '20', ring[j][1], '30', i * 10, '70', '64'); ent.push('0', 'SEQEND');
    m = await rt('tube.dxf', dxfWrap(ent)); ok(m.count === 24, 'count ' + m.count); near(measure(m).area, 40 * 30, 1e-3, 'area');
  });
  await test('DXF MESH entity (92 vertices, 93/90 face list)', async () => {
    const ent = ['0', 'MESH', '5', 'A1', '100', 'AcDbEntity', '8', '0', '92', '77', '100', 'AcDbSubDMesh', '71', '2', '72', '0', '91', '0', '92', String(L.v.length)];
    L.v.forEach(v => ent.push('10', v[0], '20', v[1], '30', v[2]));
    const fl = []; L.polys.forEach(f => { fl.push(f.length, ...f); }); ent.push('93', String(fl.length)); fl.forEach(x => ent.push('90', String(x)));
    ent.push('94', '2', '90', '0', '90', '1', '90', '1', '90', '2', '95', '0', '90', '0');
    check(await rt('l_mesh.dxf', dxfWrap(ent)), LREF, 'dxf', null);
  });
  await test('DXF 2D only -> error starting "2D drawing:"; garbage .dxf -> different plain error', async () => {
    const ent = ['0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '5', '21', '5', '0', 'CIRCLE', '10', '1', '20', '1', '40', '3', '0', 'LWPOLYLINE', '90', '2', '10', '0', '20', '0', '10', '1', '20', '1',
      '0', 'POLYLINE', '70', '1', '0', 'VERTEX', '10', '0', '20', '0', '0', 'VERTEX', '10', '4', '20', '0', '0', 'SEQEND'];
    let e = await throwsMsg(() => rt('flat.dxf', dxfWrap(ent))); plain(e); ok(e.message.indexOf('2D drawing:') === 0, e.message);
    e = await throwsMsg(() => rt('junk.dxf', 'hello this is not\na dxf file at all\n')); plain(e); ok(e.message.indexOf('2D drawing:') !== 0 && /DXF/.test(e.message), e.message);
    e = await throwsMsg(() => rt('solid.dxf', dxfWrap(['0', '3DSOLID', '1', 'abc']))); plain(e); ok(e.message.indexOf('2D drawing:') !== 0 && /solid/.test(e.message), e.message);
  });

  /* ===== routing / errors ===== */
  await test('needsConvert extensions', async () => {
    for (const x of ['blend', 'fbx', 'dae', 'step', 'stp', 'iges', 'igs', 'f3d', 'sat', '3ds', 'usd', 'usdz', 'x3d']) {
      const e = await throwsMsg(() => parseModelAny(new Uint8Array([1, 2, 3]).buffer, 'Part.' + x.toUpperCase())); plain(e); ok(e.needsConvert === true, x + ' needsConvert'); ok(e.message.toLowerCase().indexOf('.' + x) >= 0, 'names format: ' + e.message);
    }
  });
  await test('garbage / unknown / empty / degenerate', async () => {
    const junk = Buffer.alloc(5000); for (let i = 0; i < junk.length; i++) junk[i] = (i * 7919 + 13) & 255;
    const ab = junk.buffer.slice(junk.byteOffset, junk.byteOffset + junk.length);
    let e = await throwsMsg(() => parseModelAny(ab, 'thing.xyz')); plain(e); ok(/not a supported 3D file/.test(e.message) && /STL, OBJ, GLB, GLTF, 3MF, PLY, OFF, AMF or DXF/.test(e.message) && !e.needsConvert, e.message);
    e = await throwsMsg(() => parseModelAny(ab, 'noext')); plain(e); ok(/not a supported 3D file/.test(e.message), e.message);
    for (const x of ['glb', 'gltf', '3mf', 'ply', 'off', 'amf', 'dxf']) { e = await throwsMsg(() => parseModelAny(ab, 'junk.' + x)); plain(e); e = await throwsMsg(() => parseModelAny(Buffer.from('some random words\nthat mean nothing\n'), 'junk.' + x)); plain(e); }
    e = await throwsMsg(() => parseModelAny(new ArrayBuffer(0), 'a.glb')); plain(e); ok(/empty/.test(e.message), e.message);
    e = await throwsMsg(() => parseModelAny(null, 'a.ply')); plain(e);
    // degenerate triangles dropped with one summary warning
    let s = 'OFF\n5 4 0\n0 0 0\n1 0 0\n0 1 0\n2 0 0\nnan 1 1\n3 0 1 2\n3 0 1 3\n3 0 0 2\n3 0 1 4\n';
    const m = await parseModelAny(Buffer.from(s), 'deg.off'); ok(m.count === 1, 'count ' + m.count); ok(m.warnings.length === 1 && /3 triangles had no area or unreadable numbers/.test(m.warnings[0]), JSON.stringify(m.warnings));
    ok(MODEL_FORMATS.map(f => f.ext).join() === 'stl,obj,glb,gltf,3mf,ply,off,amf,dxf' && MODEL_FORMATS.every(f => f.name), 'MODEL_FORMATS');
  });

  /* ===== slicing sanity ===== */
  await test('sliceModel on parsed GLB and 3MF: layer areas', async () => {
    const g = await parseModelAny(load('l_u16.glb'), 'l_u16.glb'); let r = sliceModel(g, { thickness: 2, axis: 'z' });
    ok(r.layers.length === 10, 'glb layers ' + r.layers.length); r.layers.forEach(l => { near(l.area, 700, 0.5, 'glb layer area'); ok(l.open.length === 0, 'closed'); });
    near(r.size[0], 40, 1e-3, 'W'); near(r.size[1], 30, 1e-3, 'D'); near(r.size[2], 20, 1e-3, 'H');
    const m = await parseModelAny(load('l_defl.3mf'), 'l_defl.3mf'); r = sliceModel(m, { thickness: 4, axis: 'z' });   // scaled x2: 80 x 60 x 40, rotated 90
    ok(r.layers.length === 10, '3mf layers ' + r.layers.length); r.layers.forEach(l => { near(l.area, 2800, 2, '3mf layer area'); ok(l.open.length === 0, 'closed'); });
    near(r.size[0], 60, 1e-2, 'W (rotated)'); near(r.size[1], 80, 1e-2, 'D (rotated)');
    return 'GLB 10 layers x 700; 3MF 10 layers x 2800';
  });

  /* ===== concatenated classic script in a fresh vm context ===== */
  await test('slicer.js + formats.js as one classic script in a fresh vm context', async () => {
    const src = fs.readFileSync(path.join(TOOLS, 'slicer.js'), 'utf8') + '\n' + fs.readFileSync(path.join(TOOLS, 'formats.js'), 'utf8');
    const ctx = vm.createContext({ TextDecoder, DecompressionStream, atob, console });
    const before = new Set(Object.keys(ctx));
    new vm.Script(src, { filename: 'page-inline.js' }).runInContext(ctx);
    ok(typeof ctx.parseModelAny === 'function' && Array.isArray(ctx.MODEL_FORMATS) && typeof ctx.parseModel === 'function', 'globals exist');
    const added = Object.keys(ctx).filter(k => !before.has(k));
    const stray = added.filter(k => !/^(sl|fm)/.test(k) && ['parseModel', 'sliceModel', 'nestParts', 'parseModelAny', 'MODEL_FORMATS'].indexOf(k) < 0);
    ok(stray.length === 0, 'stray globals: ' + stray.join(','));
    for (const f of ['l_u16.glb', 'l.gltf', 'l_defl.3mf', 'l_stored.3mf', 'l_le.ply', 'l.off', 'l_zip.amf', 'l_3dface.dxf', 'l.stl', 'l.obj']) {
      const m = await ctx.parseModelAny(load(f), f); ok(m.count === 20, f + ' count ' + m.count);
    }
    const e = await throwsMsg(() => ctx.parseModelAny(load('flat.dxf'), 'flat.dxf')); ok(e.message.indexOf('2D drawing:') === 0, e.message);
    // also with nothing but the bare language (no TextDecoder / DecompressionStream / atob): non-zip formats still work, zip fails politely
    const bare = vm.createContext({}); new vm.Script(src).runInContext(bare);
    ok((await bare.parseModelAny(load('l.gltf'), 'l.gltf')).count === 20 && (await bare.parseModelAny(load('l_be.ply'), 'l_be.ply')).count === 20 && (await bare.parseModelAny(load('l_3dface.dxf'), 'x.dxf')).count === 20, 'bare context');
    const e2 = await throwsMsg(() => bare.parseModelAny(load('l_zip.amf'), 'l_zip.amf')); ok(/browser cannot unpack/.test(e2.message), e2.message);
    return added.length + ' globals added, all sl*/fm*/exports';
  });

  /* ===== performance ===== */
  const lon = 548, lat = 275, sv = [], st = [];
  sv.push([0, 0, 50]); for (let i = 1; i < lat; i++) { const th = Math.PI * i / lat; for (let j = 0; j < lon; j++) { const ph = 2 * Math.PI * j / lon; sv.push([50 * Math.sin(th) * Math.cos(ph), 50 * Math.sin(th) * Math.sin(ph), 50 * Math.cos(th)]); } } sv.push([0, 0, -50]);
  const ring = i => 1 + (i - 1) * lon, south = sv.length - 1;
  for (let j = 0; j < lon; j++) { const k = (j + 1) % lon; st.push([0, ring(1) + j, ring(1) + k]); st.push([south, ring(lat - 1) + k, ring(lat - 1) + j]); }
  for (let i = 1; i < lat - 1; i++) for (let j = 0; j < lon; j++) { const k = (j + 1) % lon, a = ring(i) + j, b = ring(i) + k, c = ring(i + 1) + j, d = ring(i + 1) + k; st.push([a, c, d], [a, d, b]); }
  const SPH = { v: sv, tris: st }, sphVol = 4 / 3 * Math.PI * 125000, sphArea = 4 * Math.PI * 2500;
  const checkSphere = (m) => { ok(m.count === st.length, 'count ' + m.count); const q = measure(m); near(q.vol, sphVol, sphVol * 1e-3, 'vol'); near(q.area, sphArea, sphArea * 1e-3, 'area'); for (let k = 0; k < 3; k++) { near(m.min[k], -50, 0.01, 'min'); near(m.max[k], 50, 0.01, 'max'); } };
  const timeIt = async (name, buf) => { const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length); const t0 = process.hrtime.bigint(); const m = await parseModelAny(ab, name); const ms = Number(process.hrtime.bigint() - t0) / 1e6; checkSphere(m); return `${st.length} triangles, ${(buf.length / 1048576).toFixed(1)} MB, parse ${ms.toFixed(0)} ms`; };
  await test('PERF sphere GLB (uint32 indices)', async () => {
    const gv = sv.map(toGltf), pos = Buffer.alloc(gv.length * 12), idx = Buffer.alloc(st.length * 12);
    gv.forEach((v, i) => { pos.writeFloatLE(v[0], i * 12); pos.writeFloatLE(v[1], i * 12 + 4); pos.writeFloatLE(v[2], i * 12 + 8); }); st.forEach((t, i) => { idx.writeUInt32LE(t[0], i * 12); idx.writeUInt32LE(t[1], i * 12 + 4); idx.writeUInt32LE(t[2], i * 12 + 8); });
    const bin = Buffer.concat([idx, pos]);
    const json = { asset: { version: '2.0' }, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 1 }, indices: 0 }] }], buffers: [{ byteLength: bin.length }],
      bufferViews: [{ buffer: 0, byteLength: idx.length }, { buffer: 0, byteOffset: idx.length, byteLength: pos.length }], accessors: [{ bufferView: 0, componentType: 5125, count: st.length * 3, type: 'SCALAR' }, { bufferView: 1, componentType: 5126, count: gv.length, type: 'VEC3' }] };
    return timeIt('sphere.glb', glb(json, bin));
  });
  await test('PERF sphere binary PLY', async () => {
    const head = Buffer.from(`ply\nformat binary_little_endian 1.0\nelement vertex ${sv.length}\nproperty float x\nproperty float y\nproperty float z\nelement face ${st.length}\nproperty list uchar int vertex_indices\nend_header\n`);
    const vb = Buffer.alloc(sv.length * 12), fb = Buffer.alloc(st.length * 13);
    sv.forEach((v, i) => { vb.writeFloatLE(v[0], i * 12); vb.writeFloatLE(v[1], i * 12 + 4); vb.writeFloatLE(v[2], i * 12 + 8); }); st.forEach((t, i) => { fb[i * 13] = 3; fb.writeInt32LE(t[0], i * 13 + 1); fb.writeInt32LE(t[1], i * 13 + 5); fb.writeInt32LE(t[2], i * 13 + 9); });
    return timeIt('sphere.ply', Buffer.concat([head, vb, fb]));
  });
  await test('PERF sphere ascii PLY', async () => {
    const s = [`ply\nformat ascii 1.0\nelement vertex ${sv.length}\nproperty float x\nproperty float y\nproperty float z\nelement face ${st.length}\nproperty list uchar int vertex_indices\nend_header`];
    sv.forEach(v => s.push(v[0].toFixed(5) + ' ' + v[1].toFixed(5) + ' ' + v[2].toFixed(5))); st.forEach(t => s.push('3 ' + t[0] + ' ' + t[1] + ' ' + t[2]));
    return timeIt('sphere_ascii.ply', Buffer.from(s.join('\n') + '\n'));
  });
  await test('PERF sphere 3MF (deflated)', async () => {
    const xml = model3mf('millimeter', `<object id="1" type="model">${meshXml(SPH)}</object>`, `<item objectid="1"/>`);
    return timeIt('sphere.3mf', zipWrite([{ name: '[Content_Types].xml', data: CT, deflate: true }, { name: '_rels/.rels', data: RELS, deflate: true }, { name: '3D/3dmodel.model', data: xml, deflate: true }]));
  });
  await test('PERF sphere OFF / AMF / DXF 3DFACE', async () => {
    const o = ['OFF', `${sv.length} ${st.length} 0`]; sv.forEach(v => o.push(v.join(' '))); st.forEach(t => o.push('3 ' + t.join(' ')));
    const a = ['<amf unit="millimeter"><object id="1"><mesh><vertices>']; sv.forEach(v => a.push(`<vertex><coordinates><x>${v[0]}</x><y>${v[1]}</y><z>${v[2]}</z></coordinates></vertex>`)); a.push('</vertices><volume>'); st.forEach(t => a.push(`<triangle><v1>${t[0]}</v1><v2>${t[1]}</v2><v3>${t[2]}</v3></triangle>`)); a.push('</volume></mesh></object></amf>');
    const d = ['0', 'SECTION', '2', 'ENTITIES']; st.forEach(t => { d.push('0', '3DFACE', '8', '0'); for (let k = 0; k < 4; k++) { const p = sv[t[Math.min(k, 2)]]; d.push('1' + k, p[0], '2' + k, p[1], '3' + k, p[2]); } }); d.push('0', 'ENDSEC', '0', 'EOF');
    return 'OFF: ' + await timeIt('sphere.off', Buffer.from(o.join('\n'))) + ' | AMF: ' + await timeIt('sphere.amf', Buffer.from(a.join(''))) + ' | DXF: ' + await timeIt('sphere.dxf', Buffer.from(d.join('\n') + '\n'));
  });

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
