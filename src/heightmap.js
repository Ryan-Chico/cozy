/**
 * heightmap.js — a bilinear height sampler pulled out of a Blender grid mesh.
 *
 * The terrain was authored as a regular grid, so its vertex positions are
 * already the height samples. That makes the sampler exact and cheap, with a
 * downward raycast kept as a fallback in case the export ever changes shape.
 *
 * Shared by the walker (which stands on this), the monster (which wades just
 * off the waterline) and the wind (which needs a root for every blade), so it
 * lives on its own rather than inside any of them.
 */

import * as THREE from 'three';

// one sampler per mesh, however many callers want it
const cache = new WeakMap();

/**
 * Returns null if the mesh doesn't look like a regular grid.
 */
export function buildHeightSampler(mesh) {
  let sampler = cache.get(mesh);
  if (sampler === undefined) {
    sampler = createSampler(mesh);
    cache.set(mesh, sampler);
  }
  return sampler;
}

function createSampler(mesh) {
  const geo = mesh.geometry;
  const attr = geo && geo.attributes.position;
  if (!attr) return null;

  mesh.updateWorldMatrix(true, false);
  const matrix = mesh.matrixWorld;
  const v = new THREE.Vector3();
  const count = attr.count;

  const xs = new Float32Array(count);
  const ys = new Float32Array(count);
  const zs = new Float32Array(count);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;

  for (let i = 0; i < count; i++) {
    v.fromBufferAttribute(attr, i).applyMatrix4(matrix);
    xs[i] = v.x; ys[i] = v.y; zs[i] = v.z;
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.z < minZ) minZ = v.z;
    if (v.z > maxZ) maxZ = v.z;
  }

  // Collect the distinct coordinate values on each axis. A regular grid has a
  // handful of them (144 x 104 here); anything else means we should bail out.
  const indexX = new Map();
  const indexZ = new Map();
  for (let i = 0; i < count; i++) {
    const rx = Math.round(xs[i] * 1000) / 1000;
    const rz = Math.round(zs[i] * 1000) / 1000;
    if (!indexX.has(rx)) indexX.set(rx, indexX.size);
    if (!indexZ.has(rz)) indexZ.set(rz, indexZ.size);
  }

  const nx = indexX.size;
  const nz = indexZ.size;
  if (nx < 4 || nz < 4 || nx > 512 || nz > 512) return null;

  const heights = new Float32Array(nx * nz).fill(NaN);
  for (let i = 0; i < count; i++) {
    const ix = indexX.get(Math.round(xs[i] * 1000) / 1000);
    const iz = indexZ.get(Math.round(zs[i] * 1000) / 1000);
    const cell = iz * nx + ix;
    // grid meshes split by the exporter repeat the same corner; keep the first
    if (Number.isNaN(heights[cell])) heights[cell] = ys[i];
  }

  let filled = 0;
  for (let i = 0; i < heights.length; i++) if (!Number.isNaN(heights[i])) filled++;
  if (filled < heights.length * 0.9) return null;   // not a grid after all

  const stepX = (maxX - minX) / (nx - 1);
  const stepZ = (maxZ - minZ) / (nz - 1);
  if (!(stepX > 1e-4 && stepZ > 1e-4)) return null;

  return {
    minX, maxX, minZ, maxZ, nx, nz, stepX, stepZ,
    sample(x, z) {
      const fx = THREE.MathUtils.clamp((x - minX) / stepX, 0, nx - 1.0001);
      const fz = THREE.MathUtils.clamp((z - minZ) / stepZ, 0, nz - 1.0001);
      const i0 = Math.floor(fx), j0 = Math.floor(fz);
      const i1 = Math.min(i0 + 1, nx - 1), j1 = Math.min(j0 + 1, nz - 1);
      const tx = fx - i0, tz = fz - j0;
      const h00 = heights[j0 * nx + i0];
      const h10 = heights[j0 * nx + i1];
      const h01 = heights[j1 * nx + i0];
      const h11 = heights[j1 * nx + i1];
      const a = h00 + (h10 - h00) * tx;
      const b = h01 + (h11 - h01) * tx;
      const h = a + (b - a) * tz;
      return Number.isNaN(h) ? 0 : h;
    },
  };
}
