// The little geometry the outline needs.

/** Distance from a point to a segment, and how far along the segment (0-1) is nearest. */
export function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  let t = lengthSquared === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { distance: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t };
}
