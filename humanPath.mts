import { Point } from "@nut-tree-fork/nut-js";

interface PathOptions {
  /** Number of points to generate along the path (default: 50) */
  steps?: number;
  /** How wide the arc bends as a ratio of total distance (default: 0.2) */
  curvature?: number;
  /** Pixel radius of random micro-tremors along the path (default: 1.5) */
  jitter?: number;
}

export function generateHumanPath(
  start: Point,
  end: Point,
  options: PathOptions = {}
): Point[] {
  const { steps = 50, curvature = 0.2, jitter = 1.5 } = options;

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);

  // If start and end are identical, return early
  if (distance === 0) return [start];

  // Unit vector perpendicular to the straight line between start and end
  const perpX = -dy / distance;
  const perpY = dx / distance;

  // Pick a random direction (left or right) for the natural curve
  const arcDirection = Math.random() < 0.5 ? 1 : -1;
  const maxOffset = distance * curvature * arcDirection;

  // Generate two asymmetric control points for a Cubic Bézier curve
  const cp1: Point = {
    x: start.x + dx * (0.2 + Math.random() * 0.2) + perpX * maxOffset * (0.5 + Math.random() * 0.5),
    y: start.y + dy * (0.2 + Math.random() * 0.2) + perpY * maxOffset * (0.5 + Math.random() * 0.5),
  };

  const cp2: Point = {
    x: start.x + dx * (0.6 + Math.random() * 0.2) + perpX * maxOffset * (0.5 + Math.random() * 0.5),
    y: start.y + dy * (0.6 + Math.random() * 0.2) + perpY * maxOffset * (0.5 + Math.random() * 0.5),
  };

  const path: Point[] = [];

  for (let i = 0; i <= steps; i++) {
    const rawT = i / steps;

    // Apply ease-in-out (smoothstep) so points cluster at the start and end
    // This mimics human acceleration and target-acquisition deceleration
    const t = rawT * rawT * (3 - 2 * rawT);

    // Cubic Bézier formula
    const oneMinusT = 1 - t;
    const x =
      oneMinusT ** 3 * start.x +
      3 * oneMinusT ** 2 * t * cp1.x +
      3 * oneMinusT * t ** 2 * cp2.x +
      t ** 3 * end.x;

    const y =
      oneMinusT ** 3 * start.y +
      3 * oneMinusT ** 2 * t * cp1.y +
      3 * oneMinusT * t ** 2 * cp2.y +
      t ** 3 * end.y;

    // Apply subtle hand tremor (skip exact start and end points for precision)
    const isEndpoint = i === 0 || i === steps;
    const noiseX = isEndpoint ? 0 : (Math.random() - 0.5) * 2 * jitter;
    const noiseY = isEndpoint ? 0 : (Math.random() - 0.5) * 2 * jitter;

    path.push({
      x: Math.round(x + noiseX),
      y: Math.round(y + noiseY),
    });
  }

  return path;
}