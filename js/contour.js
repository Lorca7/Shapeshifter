// Turn a selection mask back into geometry.
//
// Needed twice over: the marching-ants outline on screen, and the real vector
// <clipPath> written into an exported SVG. Each cell of the pixel grid is split
// into two triangles before contouring — unlike marching squares that has no
// ambiguous saddle cases, so the loops it produces always close cleanly.

const LEVEL = 128;

/**
 * Trace a mask into closed polygons in image coordinates.
 * Nested loops (holes) come out as separate rings; render them with
 * fill-rule evenodd and holes take care of themselves.
 *
 * @returns {Array<Array<{x:number,y:number}>>}
 */
export function traceContours(mask, { tolerance = 0.6, minArea = 2 } = {}) {
  const { width: w, height: h, data } = mask;

  // Sample grid padded by one cell of zeros, so shapes running off the edge of
  // the image still close instead of producing open ends.
  const gw = w + 2;
  const gh = h + 2;
  const field = new Float32Array(gw * gh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) field[(y + 1) * gw + (x + 1)] = data[y * w + x];
  }
  // Grid node (i,j) sits at image coordinate (i - 0.5, j - 0.5).
  const cx = (i) => i - 0.5;
  const cy = (j) => j - 0.5;

  /** @type {Map<string, {ax:number,ay:number,bx:number,by:number}>} */
  const segments = new Map();
  const key = (x, y) => `${Math.round(x * 64)},${Math.round(y * 64)}`;

  const addSegment = (ax, ay, bx, by) => {
    if (ax === bx && ay === by) return;
    const k = key(ax, ay);
    if (!segments.has(k)) segments.set(k, { ax, ay, bx, by });
  };

  const interp = (x0, y0, v0, x1, y1, v1) => {
    const t = v1 === v0 ? 0.5 : (LEVEL - v0) / (v1 - v0);
    const c = t < 0 ? 0 : t > 1 ? 1 : t;
    return [x0 + (x1 - x0) * c, y0 + (y1 - y0) * c];
  };

  // Each triangle's vertices are listed counter-clockwise in grid space.
  const tri = (p0, p1, p2) => {
    const [x0, y0, v0] = p0;
    const [x1, y1, v1] = p1;
    const [x2, y2, v2] = p2;
    const b0 = v0 >= LEVEL ? 1 : 0;
    const b1 = v1 >= LEVEL ? 1 : 0;
    const b2 = v2 >= LEVEL ? 1 : 0;
    const count = b0 + b1 + b2;
    if (count === 0 || count === 3) return;

    // Edges: e0 = v0->v1, e1 = v1->v2, e2 = v2->v0.
    const crossing = (e) =>
      e === 0 ? interp(x0, y0, v0, x1, y1, v1)
      : e === 1 ? interp(x1, y1, v1, x2, y2, v2)
      : interp(x2, y2, v2, x0, y0, v0);

    if (count === 1) {
      // One corner inside: the two edges touching it are the ones crossed.
      const k = b0 ? 0 : b1 ? 1 : 2;
      const [ax, ay] = crossing((k + 2) % 3);
      const [bx, by] = crossing(k);
      addSegment(ax, ay, bx, by);
    } else {
      // One corner outside: mirror of the above, which flips the direction and
      // keeps every loop consistently wound.
      const k = !b0 ? 0 : !b1 ? 1 : 2;
      const [ax, ay] = crossing(k);
      const [bx, by] = crossing((k + 2) % 3);
      addSegment(ax, ay, bx, by);
    }
  };

  for (let j = 0; j < gh - 1; j++) {
    for (let i = 0; i < gw - 1; i++) {
      const tl = field[j * gw + i];
      const tr = field[j * gw + i + 1];
      const bl = field[(j + 1) * gw + i];
      const br = field[(j + 1) * gw + i + 1];
      if (tl < LEVEL && tr < LEVEL && bl < LEVEL && br < LEVEL) continue;
      if (tl >= LEVEL && tr >= LEVEL && bl >= LEVEL && br >= LEVEL) continue;

      const TL = [cx(i), cy(j), tl];
      const TR = [cx(i + 1), cy(j), tr];
      const BR = [cx(i + 1), cy(j + 1), br];
      const BL = [cx(i), cy(j + 1), bl];
      tri(TL, BR, TR);
      tri(TL, BL, BR);
    }
  }

  // Stitch directed segments head-to-tail into closed rings.
  const loops = [];
  const unused = new Set(segments.keys());
  while (unused.size) {
    const startKey = unused.values().next().value;
    let k = startKey;
    const points = [];
    while (k && unused.has(k)) {
      const seg = segments.get(k);
      unused.delete(k);
      points.push({ x: seg.ax, y: seg.ay });
      k = key(seg.bx, seg.by);
      if (k === startKey) break;
    }
    if (points.length < 3) continue;
    const simplified = simplifyClosed(points, tolerance);
    if (simplified.length >= 3 && Math.abs(signedArea(simplified)) >= minArea) {
      loops.push(simplified);
    }
  }
  return loops;
}

/** Contours as an SVG path `d` string, ready for a <clipPath>. */
export function contoursToPathData(loops, { offsetX = 0, offsetY = 0, scale = 1, precision = 2 } = {}) {
  const f = (n) => Number((n * scale).toFixed(precision));
  return loops
    .map((loop) => {
      const head = loop[0];
      const parts = [`M${f(head.x - offsetX)} ${f(head.y - offsetY)}`];
      for (let i = 1; i < loop.length; i++) {
        parts.push(`L${f(loop[i].x - offsetX)} ${f(loop[i].y - offsetY)}`);
      }
      parts.push('Z');
      return parts.join('');
    })
    .join('');
}

/** Contours as a Path2D in image coordinates (for the on-screen outline). */
export function contoursToPath2D(loops) {
  const path = new Path2D();
  for (const loop of loops) {
    path.moveTo(loop[0].x, loop[0].y);
    for (let i = 1; i < loop.length; i++) path.lineTo(loop[i].x, loop[i].y);
    path.closePath();
  }
  return path;
}

export function signedArea(points) {
  let a = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const p = points[i];
    const q = points[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/**
 * Ramer–Douglas–Peucker on a closed ring. Cuts the staircase of per-pixel
 * crossings down to a handful of points without visibly moving the outline,
 * which keeps exported SVGs small.
 */
function simplifyClosed(points, tolerance) {
  if (tolerance <= 0 || points.length < 4) return points;
  // Anchor on the two most distant-ish points so the ring splits into two open
  // chains that RDP can handle.
  let far = 0;
  let best = -1;
  const p0 = points[0];
  for (let i = 1; i < points.length; i++) {
    const d = (points[i].x - p0.x) ** 2 + (points[i].y - p0.y) ** 2;
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const first = rdp(points.slice(0, far + 1), tolerance);
  const second = rdp(points.slice(far), tolerance);
  return first.slice(0, -1).concat(second.slice(0, -1));
}

function rdp(points, tolerance) {
  if (points.length < 3) return points.slice();
  const sqTol = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    let maxDist = -1;
    let index = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = sqSegmentDistance(points[i], points[lo], points[hi]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (maxDist > sqTol && index > 0) {
      keep[index] = 1;
      stack.push([lo, index], [index, hi]);
    }
  }
  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

function sqSegmentDistance(p, a, b) {
  let x = a.x;
  let y = a.y;
  let dx = b.x - x;
  let dy = b.y - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = b.x;
      y = b.y;
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = p.x - x;
  dy = p.y - y;
  return dx * dx + dy * dy;
}
