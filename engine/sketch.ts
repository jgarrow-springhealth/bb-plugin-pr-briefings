// Excalidraw-style ("sketch") SVG for static reports. Uses roughjs — the
// library Excalidraw itself draws with — in generator mode, which needs no DOM,
// so diagrams are computed on the server and embedded as plain SVG. Colours are
// CSS classes (not inline values) so the report's light and dark themes apply.
// Seeds derive from the content, so a briefing always draws the same wobble.
import rough from "roughjs";
import { EXCALIFONT_WOFF2_BASE64 } from "./excalifont.ts";

export const SKETCH_FONT = "Excalifont, 'Segoe Print', 'Bradley Hand', 'Comic Sans MS', cursive";

/** @font-face for Excalifont as a data URI (no remote loads). */
export const SKETCH_FONT_FACE = `@font-face{font-family:Excalifont;src:url(data:font/woff2;base64,${EXCALIFONT_WOFF2_BASE64}) format("woff2");font-display:block}`;

/** Excalidraw's default palette (light) and its dark-theme counterpart. */
export const SKETCH_STYLE = `:root{--sk-ink:#1e1e1e;--sk-canvas:#ffffff;--sk-blue:#a5d8ff;--sk-yellow:#ffec99;--sk-green:#b2f2bb;--sk-red:#ffc9c9;--sk-violet:#d0bfff;--sk-gray:#e9ecef;--sk-link:#1971c2}
@media(prefers-color-scheme:dark){:root{--sk-ink:#e3e3e3;--sk-canvas:#121212;--sk-blue:#154163;--sk-yellow:#4a4211;--sk-green:#174a20;--sk-red:#5b2424;--sk-violet:#3b2f63;--sk-gray:#2a2d31;--sk-link:#a5d8ff}}
.sketch{display:block;width:100%;height:auto;overflow:visible}.sketch text{font-family:${SKETCH_FONT};fill:var(--sk-ink)}.sk-ink{fill:none;stroke:var(--sk-ink);stroke-linecap:round}.sk-fill{fill:none}.sk-node.blue .sk-fill{stroke:var(--sk-blue)}.sk-node.yellow .sk-fill{stroke:var(--sk-yellow)}.sk-node.green .sk-fill{stroke:var(--sk-green)}.sk-node.red .sk-fill{stroke:var(--sk-red)}.sk-node.violet .sk-fill{stroke:var(--sk-violet)}.sk-node.gray .sk-fill{stroke:var(--sk-gray)}.sk-solid.blue{fill:var(--sk-blue)}.sk-solid.yellow{fill:var(--sk-yellow)}.sk-solid.gray{fill:var(--sk-gray)}.sk-label-bg{fill:var(--card,var(--sk-canvas))}.sk-edge-label{font-size:13px}.sk-node a:hover .sk-ink,.sk-link:hover .sk-ink{stroke:var(--sk-link);stroke-width:2.2}.sk-swatch{stroke:var(--sk-ink);stroke-width:1}`;

export type SketchColor = "blue" | "yellow" | "green" | "red" | "violet" | "gray";
type Point = [number, number];

const generator = rough.generator();

/** FNV-1a: a stable positive seed from text. */
export function seedOf(text: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 2147483646 || 1;
}

const FILL = "#000001";
const STROKE = "#000002";
const paths = (drawable: ReturnType<typeof generator.path>) =>
  generator
    .toPaths(drawable)
    .map((path) => `<path d="${path.d}" class="${path.stroke === FILL ? "sk-fill" : "sk-ink"}" stroke-width="${path.strokeWidth}"/>`)
    .join("");

/** A rounded, hand-drawn rectangle with Excalidraw's hachure fill. */
export function sketchBox(x: number, y: number, w: number, h: number, seed: number, options: { fill?: boolean; strokeWidth?: number; dashed?: boolean } = {}) {
  const r = Math.min(14, w / 4, h / 4);
  const d = `M${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} L${x + r},${y + h} Q${x},${y + h} ${x},${y + h - r} L${x},${y + r} Q${x},${y} ${x + r},${y}`;
  return paths(
    generator.path(d, {
      seed,
      roughness: 1,
      bowing: 1,
      stroke: STROKE,
      strokeWidth: options.strokeWidth ?? 1.6,
      ...(options.fill === false ? {} : { fill: FILL, fillStyle: "hachure", hachureGap: 6, fillWeight: 1.1, hachureAngle: -41 }),
      ...(options.dashed ? { strokeLineDash: [6, 6] } : {}),
    }),
  );
}

/** A hand-drawn arrow through `points` (a smooth curve) with an open arrowhead. */
export function sketchArrow(points: Point[], seed: number, options: { dashed?: boolean } = {}) {
  const line = paths(
    points.length > 2
      ? generator.curve(points, { seed, roughness: 0.9, bowing: 0.6, stroke: STROKE, strokeWidth: 1.5, ...(options.dashed ? { strokeLineDash: [5, 6] } : {}) })
      : generator.line(points[0]![0], points[0]![1], points[1]![0], points[1]![1], { seed, roughness: 0.9, bowing: 0.8, stroke: STROKE, strokeWidth: 1.5, ...(options.dashed ? { strokeLineDash: [5, 6] } : {}) }),
  );
  const [tip, from] = [points.at(-1)!, points.at(-2)!];
  const angle = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  const head = (offset: number) => {
    const a = angle + Math.PI - offset;
    return paths(generator.line(tip[0], tip[1], tip[0] + 12 * Math.cos(a), tip[1] + 12 * Math.sin(a), { seed: seed + 1, roughness: 0.6, stroke: STROKE, strokeWidth: 1.5 }));
  };
  return `${line}${head(0.45)}${head(-0.45)}`;
}

/** Splits text into at most `lines` lines of about `width` characters. */
export function wrapText(text: string, width: number, lines: number) {
  const out: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if ((current + " " + word).trim().length > width && current) {
      out.push(current);
      current = word;
    } else current = (current + " " + word).trim();
  }
  if (current) out.push(current);
  if (out.length > lines) {
    out.length = lines;
    out[lines - 1] = `${out[lines - 1]!.slice(0, width - 1)}…`;
  }
  return out.map((line) => (line.length > width + 6 ? `${line.slice(0, width + 5)}…` : line));
}

/** Approximate rendered width of Excalifont text. */
export const textWidth = (text: string, size: number) => text.length * size * 0.6;
