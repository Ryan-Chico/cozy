/**
 * model-budget.mjs — the one thing that gets worse every time someone contributes.
 *
 * The scene is a single page that downloads everything before it can show you
 * anything, so its weight is the sum of every model in models/. That is fine at
 * two guests and it would not be fine at twelve, and the person adding the
 * twelfth cannot see the trend from where they are standing. This can.
 *
 *   npm run check        # or: node tools/model-budget.mjs
 *
 * It reads each .glb's own JSON chunk rather than asking a renderer, so it needs
 * nothing installed and takes about as long as listing the folder. Triangles come
 * from the accessors the meshes point at, which is what the GPU will actually be
 * asked to draw; the numbers may differ by a few per cent from what Blender
 * reports, because a primitive that is not `mode: 4` is not triangles at all.
 *
 * The limits are deliberately roomy — roomy enough to add something small without
 * thinking about it, tight enough that nobody ships a photogrammetry scan by
 * accident. They are guides with a build failure behind them, not laws: if you
 * have a reason, say so in the pull request and raise them in the same commit.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Measured against what is already here rather than picked out of the air: the
// B-17 is 4.05 MB and 104k triangles, the toad 1.35 MB and 50k, and the two
// together are 5.4 MB — about the same as assets/creek.glb. So a guest may be as
// large as the largest guest already in the scene, and the whole guest list may
// grow to roughly twice what it is now. Both are meant to be argued with; the
// point is that the argument happens in a pull request, with the numbers printed,
// rather than in the page's load time.
const MAX_MODEL_BYTES = 5 * 1024 * 1024;      // one guest
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;     // all of them together
const MAX_MODEL_TRIS = 250_000;               // one guest
const MAX_TOTAL_TRIS = 500_000;               // all of them together

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));const MODELS = join(ROOT, 'models');

/** Every .glb under a directory, at any depth. */
function findGlbs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findGlbs(path));
    else if (entry.name.toLowerCase().endsWith('.glb')) out.push(path);
  }
  return out;
}

/**
 * Bytes and triangles out of a GLB, without loading it.
 *
 * GLB is a 12-byte header and then length-prefixed chunks; the first chunk is
 * always the JSON. Only that chunk is read, so a 100 MB model costs the same as
 * a small one.
 */
function readGlb(path) {
  const size = statSync(path).size;
  const buf = readFileSync(path);
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) {
    throw new Error('not a GLB — the header magic is wrong');
  }
  const jsonLen = buf.readUInt32LE(12);
  const jsonType = buf.readUInt32LE(16);
  if (jsonType !== 0x4e4f534a) {
    throw new Error('the first chunk is not JSON — is this an older binary glTF?');
  }
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));

  let tris = 0;
  for (const mesh of gltf.meshes || []) {
    for (const prim of mesh.primitives || []) {
      if (prim.mode !== undefined && prim.mode !== 4) continue;   // not triangles
      const accessor = gltf.accessors?.[prim.indices ?? prim.attributes?.POSITION];
      const count = accessor?.count || 0;
      tris += Math.floor(count / 3);
    }
  }

  return { size, tris, meshes: gltf.meshes?.length || 0 };
}

const mb = (bytes) => (bytes / 1048576).toFixed(2) + ' MB';
const k = (tris) => (tris / 1000).toFixed(0) + 'k';

let files;
try {
  files = findGlbs(MODELS).sort();
} catch {
  console.error(`no models/ folder at ${relative(ROOT, MODELS)}`);
  process.exit(1);
}

if (!files.length) {
  console.log('no .glb files under models/ — nothing to weigh');
  process.exit(0);
}

const failures = [];
let totalBytes = 0;
let totalTris = 0;

console.log('\n  model budgets\n');
for (const path of files) {
  const name = relative(ROOT, path).split(sep).join('/');
  let info;
  try {
    info = readGlb(path);
  } catch (err) {
    failures.push(`${name}: unreadable — ${err.message}`);
    console.log(`  ${name.padEnd(28)}  ???  — ${err.message}`);
    continue;
  }

  totalBytes += info.size;
  totalTris += info.tris;

  const over = [];
  if (info.size > MAX_MODEL_BYTES) over.push('size');
  if (info.tris > MAX_MODEL_TRIS) over.push('triangles');
  if (over.length) failures.push(`${name}: over budget on ${over.join(' and ')}`);

  console.log(
    `  ${name.padEnd(28)}  ${mb(info.size).padStart(9)}  ${k(info.tris).padStart(7)} tris`
    + `  ${info.meshes} mesh${info.meshes === 1 ? '' : 'es'}`
    + (over.length ? '   <-- over budget' : ''),
  );
}

console.log(`\n  ${files.length} models`
  + `  ·  ${mb(totalBytes)} / ${mb(MAX_TOTAL_BYTES)}`
  + `  ·  ${k(totalTris)} / ${k(MAX_TOTAL_TRIS)} tris`);
console.log('  (assets/creek.glb is not counted: it is the scene itself, not a guest)\n');

if (totalBytes > MAX_TOTAL_BYTES) {
  failures.push(`all models together are ${mb(totalBytes)}, over the ${mb(MAX_TOTAL_BYTES)} budget`);
}
if (totalTris > MAX_TOTAL_TRIS) {
  failures.push(`all models together are ${k(totalTris)} triangles, over the ${k(MAX_TOTAL_TRIS)} budget`);
}

if (failures.length) {
  console.error('  over budget:');
  for (const f of failures) console.error('   -', f);
  console.error('\n  Re-export smaller: decimate the mesh, cut textures to 1024, and let');
  console.error('  opaque maps go to JPEG. Failing that, raise the limits here and say');
  console.error('  why in the pull request.\n');
  process.exit(1);
}

console.log('  within budget\n');
