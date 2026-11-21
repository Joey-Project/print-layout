import { Matrix4, Vector3 } from 'three';
import type { Seam, SpineAxis } from './timeline';

const a0 = new Vector3();
const a1 = new Vector3();
const b0 = new Vector3();
const b1 = new Vector3();
const ta = new Vector3();
const tb = new Vector3();
const axisO = new Vector3();
const axisD = new Vector3();
const ca = new Vector3();
const cb = new Vector3();
const u = new Vector3();
const w = new Vector3();
const v = new Vector3();

/**
 * Shape of the paper joining the two panels of a seam: for each end of the shared edge, a curve
 * that leaves panel a's edge heading away from a, and arrives at panel b's edge heading into b
 * (a cubic Hermite curve, so the paper bends smoothly out of both panels).
 *
 * Folded back on each other (a nested sheet wrapping the ones inside it) the curve is close to a
 * half circle whose diameter is the gap between the two panels, so outer sheets get a little extra
 * paper to wrap around the inner ones. Lying flat side by side, it shrinks to nothing.
 *
 * With a spine axis (a book being read) and both panels the same distance from it — the two halves
 * of a nested sheet — the curve is instead an exact arc around the axis. Leaves turn about that
 * axis too, so the arcs of different sheets stay nested and never cut through a page.
 *
 * Writes `segments + 1` vertex pairs (edge start, edge end) to `out` and returns the largest gap,
 * which is ~0 when the panels meet flat.
 */
export function seamStrip(
  seam: Seam,
  ma: Matrix4,
  mb: Matrix4,
  segments: number,
  out: Float32Array,
  axis: SpineAxis | null = null,
): number {
  a0.set(seam.p0[0], seam.p0[1], 0).applyMatrix4(ma);
  a1.set(seam.p1[0], seam.p1[1], 0).applyMatrix4(ma);
  b0.set(seam.p0[0], seam.p0[1], 0).applyMatrix4(mb);
  b1.set(seam.p1[0], seam.p1[1], 0).applyMatrix4(mb);
  ta.set(seam.inA[0], seam.inA[1], 0).transformDirection(ma);
  tb.set(seam.inB[0], seam.inB[1], 0).transformDirection(mb);
  const gap = Math.max(a0.distanceTo(b0), a1.distanceTo(b1));
  if (axis && gap > 1e-9 && spineArc(axis, segments, out)) return gap;
  // Tangent length: 2·gap gives a near half circle when folded back (ta = tb), gap when flat.
  const k = gap * (1.5 + 0.5 * ta.dot(tb));
  for (let i = 0; i <= segments; i++) {
    const s = i / segments;
    const s2 = s * s;
    const s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1;
    const h10 = (s3 - 2 * s2 + s) * -k; // leaving a: along −ta
    const h01 = -2 * s3 + 3 * s2;
    const h11 = (s3 - s2) * k; // arriving at b: along +tb
    for (let e = 0; e < 2; e++) {
      const pa = e === 0 ? a0 : a1;
      const pb = e === 0 ? b0 : b1;
      const o = (i * 2 + e) * 3;
      out[o] = h00 * pa.x + h10 * ta.x + h01 * pb.x + h11 * tb.x;
      out[o + 1] = h00 * pa.y + h10 * ta.y + h01 * pb.y + h11 * tb.y;
      out[o + 2] = h00 * pa.z + h10 * ta.z + h01 * pb.z + h11 * tb.z;
    }
  }
  return gap;
}

/** The arc around `axis` from a's edge to b's edge, or false if they are not on one circle. */
function spineArc(axis: SpineAxis, segments: number, out: Float32Array): boolean {
  axisO.fromArray(axis.origin);
  axisD.fromArray(axis.dir).normalize();
  for (let e = 0; e < 2; e++) {
    const pa = e === 0 ? a0 : a1;
    const pb = e === 0 ? b0 : b1;
    // Centres: the axis points level with each end of the edge.
    ca.copy(axisD).multiplyScalar(v.copy(pa).sub(axisO).dot(axisD)).add(axisO);
    cb.copy(axisD).multiplyScalar(v.copy(pb).sub(axisO).dot(axisD)).add(axisO);
    const ra = pa.distanceTo(ca);
    const rb = pb.distanceTo(cb);
    if (ca.distanceTo(cb) > 1e-6 || Math.abs(ra - rb) > 1e-6 * Math.max(1, ra) || ra < 1e-9) {
      return false;
    }
    // Start radially out at a, heading away from a (the paper leaves the page backwards).
    u.copy(pa).sub(ca).divideScalar(ra);
    w.copy(ta).negate();
    w.addScaledVector(u, -w.dot(u)).normalize();
    v.copy(pb).sub(ca).divideScalar(ra);
    let sweep = Math.atan2(v.dot(w), v.dot(u));
    if (sweep < 0) sweep += 2 * Math.PI;
    for (let i = 0; i <= segments; i++) {
      const ang = (sweep * i) / segments;
      const c = Math.cos(ang) * ra;
      const sn = Math.sin(ang) * ra;
      const o = (i * 2 + e) * 3;
      out[o] = ca.x + c * u.x + sn * w.x;
      out[o + 1] = ca.y + c * u.y + sn * w.y;
      out[o + 2] = ca.z + c * u.z + sn * w.z;
    }
  }
  return true;
}
