import { Matrix4, Vector3 } from 'three';
import type { Seam } from './timeline';

const a0 = new Vector3();
const a1 = new Vector3();
const b0 = new Vector3();
const b1 = new Vector3();
const ta = new Vector3();
const tb = new Vector3();

/**
 * Shape of the paper joining the two panels of a seam: for each end of the shared edge, a curve
 * that leaves panel a's edge heading away from a, and arrives at panel b's edge heading into b
 * (a cubic Hermite curve, so the paper bends smoothly out of both panels).
 *
 * Folded back on each other (a nested sheet wrapping the ones inside it) the curve is close to a
 * half circle whose diameter is the gap between the two panels, so outer sheets get a little extra
 * paper to wrap around the inner ones. Lying flat side by side, it shrinks to nothing.
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
): number {
  a0.set(seam.p0[0], seam.p0[1], 0).applyMatrix4(ma);
  a1.set(seam.p1[0], seam.p1[1], 0).applyMatrix4(ma);
  b0.set(seam.p0[0], seam.p0[1], 0).applyMatrix4(mb);
  b1.set(seam.p1[0], seam.p1[1], 0).applyMatrix4(mb);
  ta.set(seam.inA[0], seam.inA[1], 0).transformDirection(ma);
  tb.set(seam.inB[0], seam.inB[1], 0).transformDirection(mb);
  const gap = Math.max(a0.distanceTo(b0), a1.distanceTo(b1));
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
