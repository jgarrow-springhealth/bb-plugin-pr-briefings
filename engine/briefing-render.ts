// Deterministic HTML rendering of a validated briefing plus its computed facts.
//
// The layout mirrors the Generative UI briefing card: one card with a header,
// four metrics, a "Remember this" callout, and six tabs (Overview, Before /
// after, Impact & flow, Verified, Risks, Evidence). The report is opened in
// BB's file preview and may not run scripts, so the tabs are CSS-only radio
// inputs, charts/diagrams are server-drawn SVG, and images are data URIs in
// <img>, which cannot run scripts or fetch.
import type { PullRequest } from "../contract.ts";
import { MAX_BRIEFING_HTML_BYTES } from "./briefing-html.ts";
import type { BriefingDocument } from "./briefing-template.ts";
import {
  allEvidence,
  buildFacts,
  checkCounts,
  evidenceCounts,
  type AcceptanceRow,
  type AreaBreakdown,
  type BriefingFacts,
  type CheckRun,
  type CodeExcerpt,
  type ResolvedDocument,
  type ResolvedEvidence,
  type VisualPair,
} from "./facts.ts";
import { SKETCH_FONT_FACE, SKETCH_STYLE, seedOf, sketchArrow, sketchBox, textWidth, wrapText, type SketchColor } from "./sketch.ts";

const esc = (value: string | number) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const fmt = (value: number) => value.toLocaleString("en-US");

// ── Icons (trusted, hand-written SVG; lucide-style strokes) ────────────────

const ICON_PATHS: Record<string, string> = {
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  play: '<circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>',
  passed: '<circle cx="12" cy="12" r="9" class="fill"/><path d="m8 12 3 3 5-6" class="on-fill"/>',
  failed: '<circle cx="12" cy="12" r="9" class="fill"/><path d="m9 9 6 6M15 9l-6 6" class="on-fill"/>',
  untested: '<circle cx="12" cy="12" r="9" stroke-dasharray="3 3"/>',
  claimed: '<circle cx="12" cy="12" r="9"/><path d="m7 7 10 10M5 11l8 8M11 5l8 8"/>',
  warn: '<path d="M12 4 2.5 20h19z"/><path d="M12 10v4M12 17h.01"/>',
  file: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4M9 13h6M9 17h6"/>',
  pr: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-4"/><path d="m13 4-2 2 2 2"/>',
  diff: '<path d="M12 3v8M8 7h8M8 17h8"/><rect x="3" y="3" width="18" height="18" rx="3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
};
const icon = (name: string, className = "") =>
  `<svg class="i${className ? ` ${className}` : ""}" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[name] ?? ""}</svg>`;

const KIND_ICON: Record<string, string> = { behavior: "play", surface: "layers", scope: "lock", compatibility: "check" };
const KIND_TONE: Record<string, string> = { behavior: "info", surface: "info", scope: "neutral", compatibility: "good" };
const badge = (text: string, tone = "neutral") => `<span class="badge tone-${tone}">${esc(text)}</span>`;

const location = (item: ResolvedEvidence) => `${item.path}${item.line ? `:${item.line}` : ""}`;
const STATUS_WORD: Record<ResolvedEvidence["status"], string> = { resolved: "matched", unverified: "unchecked", unresolved: "not found" };
function evidenceLinks(items: ResolvedEvidence[]) {
  if (!items.length) return "";
  return `<ul class="ev">${items
    .map(
      (item) =>
        `<li><a href="${esc(item.url)}" target="_blank" rel="noreferrer"><code>${esc(location(item))}</code></a> <span class="ev-status ev-${item.status}">${STATUS_WORD[item.status]}</span><span class="ev-note">${esc(item.note)}${item.citedLine !== null && item.status === "resolved" ? ` · model cited line ${item.citedLine}` : ""}</span></li>`,
    )
    .join("")}</ul>`;
}

// ── Charts ──────────────────────────────────────────────────────────────────

const niceStep = (raw: number) => {
  const power = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  const unit = raw / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
};

/** Grouped vertical bars, added vs removed per area (the prototype's Chart("bar")). */
function areaChart(areas: AreaBreakdown) {
  const max = Math.max(1, ...areas.added, ...areas.removed);
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const width = 660;
  const height = 210;
  const left = 64;
  const bottom = 26;
  const plot = height - bottom - 8;
  const group = (width - left) / areas.labels.length;
  const bar = Math.min(28, (group - 14) / 2);
  const y = (value: number) => 8 + plot - (value / top) * plot;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, index) => index * step);
  const grid = ticks
    .map((tick) => `<line x1="${left}" x2="${width}" y1="${y(tick)}" y2="${y(tick)}" class="grid${tick ? "" : " base"}"/><text x="${left - 6}" y="${y(tick) + 4}" class="tick" text-anchor="end">${fmt(tick)} lines</text>`)
    .join("");
  const bars = areas.labels
    .map((label, index) => {
      const x = left + index * group + group / 2;
      const shown = label.length > 14 ? `${label.slice(0, 13)}…` : label;
      const rect = (value: number, dx: number, cls: string) =>
        `<rect x="${(x + dx).toFixed(1)}" y="${y(value).toFixed(1)}" width="${bar.toFixed(1)}" height="${(8 + plot - y(value)).toFixed(1)}" rx="2" class="${cls}"/>`;
      return `<g><title>${esc(`${areas.paths?.[index] ?? label}: +${fmt(areas.added[index]!)} −${fmt(areas.removed[index]!)} in ${plural(areas.files[index]!, "file")}`)}</title>${rect(areas.added[index]!, -bar - 1, "bar-add")}${rect(areas.removed[index]!, 1, "bar-del")}<text x="${x}" y="${height - 8}" class="xlab" text-anchor="middle">${esc(shown)}</text></g>`;
    })
    .join("");
  return `<figure class="chart"><div class="legend"><span><i class="sw sw-add"></i>Added</span><span><i class="sw sw-del"></i>Removed</span></div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Lines added and removed by area">${grid}${bars}</svg></figure>`;
}

function areaCaption(areas: AreaBreakdown) {
  if (!areas.labels.length) return "";
  const most = areas.added.indexOf(Math.max(...areas.added));
  const net = areas.added.map((added, index) => added - areas.removed[index]!);
  const shrink = net.indexOf(Math.min(...net));
  const parts = [`Most new lines land in <b>${esc(areas.labels[most]!)}</b> (+${fmt(areas.added[most]!)})`];
  if (net[shrink]! < 0) parts.push(`<b>${esc(areas.labels[shrink]!)}</b> shrinks the most (${fmt(net[shrink]!)} net)`);
  return `<p class="caption">${parts.join("; ")}.</p>`;
}

// ── Impact graph ────────────────────────────────────────────────────────────

export interface ImpactGraph {
  nodes: Array<{ id: string; name: string; kind: string; changed: boolean; depth: number; row: number }>;
  edges: Array<{ from: string; to: string }>;
}

/** Layered layout of impacts that reference each other through `dependsOn`. */
export function impactGraph(
  impacts: ReadonlyArray<Pick<BriefingDocument["impacts"][number], "id" | "dependsOn" | "name" | "kind" | "changed">>,
): ImpactGraph | null {
  const ids = impacts.map((item, index) => item.id ?? `impact-${index + 1}`);
  const known = new Set(ids);
  const edges = impacts.flatMap((item, index) =>
    (item.dependsOn ?? [])
      .filter((dep) => known.has(dep) && dep !== ids[index])
      .map((dep) => ({ from: dep, to: ids[index]! })),
  );
  if (!edges.length) return null;
  // Transitive reduction for drawing: skip A→C when A→…→C already exists, so
  // the diagram shows chains instead of bundles of long edges. Cards still
  // list every dependency.
  const reachable = (from: string, to: string, skip: { from: string; to: string }) => {
    const seen = new Set<string>();
    const stack = edges.filter((edge) => edge.from === from && edge !== skip).map((edge) => edge.to);
    while (stack.length) {
      const next = stack.pop()!;
      if (next === to) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      for (const edge of edges) if (edge.from === next) stack.push(edge.to);
    }
    return false;
  };
  const reduced = edges.filter((edge) => !reachable(edge.from, edge.to, edge));
  edges.splice(0, edges.length, ...(reduced.length ? reduced : edges));
  const depth = new Map(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false;
    for (const edge of edges) {
      const next = depth.get(edge.from)! + 1;
      if (next > depth.get(edge.to)! && next < ids.length) {
        depth.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const rows = new Map<number, number>();
  const nodes = impacts.map((item, index) => {
    const d = depth.get(ids[index]!)!;
    const row = rows.get(d) ?? 0;
    rows.set(d, row + 1);
    return { id: ids[index]!, name: item.name, kind: item.kind, changed: item.changed, depth: d, row };
  });
  return { nodes, edges: edges.filter((edge) => depth.get(edge.from)! < depth.get(edge.to)!) };
}

function impactSketch(document: ResolvedDocument, graph: ImpactGraph) {
  const w = 200;
  const relationOf = new Map(document.impacts.map((item, index) => [item.id ?? `impact-${index + 1}`, (item.relation ?? "").slice(0, 26)]));
  const longest = Math.max(0, ...graph.edges.map((edge) => textWidth(relationOf.get(edge.to) ?? "", 13)));
  const colGap = Math.max(120, Math.min(260, longest + 90));
  const rowGap = 34;
  const pad = 14;
  const labels = graph.nodes.map((node) => wrapText(node.name, 18, 3));
  const heights = labels.map((lines) => 34 + lines.length * 19);
  const columns = Math.max(...graph.nodes.map((node) => node.depth)) + 1;
  const columnHeight = (depth: number) =>
    graph.nodes.reduce((sum, node, index) => (node.depth === depth ? sum + heights[index]! + rowGap : sum), -rowGap);
  const tallest = Math.max(...[...Array(columns).keys()].map(columnHeight));
  const height = tallest + pad * 2 + 24;
  const pos = new Map<string, { x: number; y: number; h: number; index: number }>();
  for (let depth = 0; depth < columns; depth++) {
    let y = pad + 24 + (tallest - columnHeight(depth)) / 2;
    graph.nodes.forEach((node, index) => {
      if (node.depth !== depth) return;
      pos.set(node.id, { x: pad + depth * (w + colGap), y, h: heights[index]!, index });
      y += heights[index]! + rowGap;
    });
  }
  const width = pad * 2 + columns * w + (columns - 1) * colGap;
  const linked = new Set(graph.edges.flatMap((edge) => [edge.from, edge.to]));
  const labelled = new Set<string>();
  // Fan outgoing edges across the source's right side (ordered by target
  // height) so they don't bunch, and end each edge with a straight run that
  // carries its label just before the arrowhead.
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  for (const [from, targets] of outgoing) targets.sort((p1, p2) => pos.get(p1)!.y - pos.get(p2)!.y), outgoing.set(from, targets);
  const edges = graph.edges
    .map((edge) => {
      const a = pos.get(edge.from)!;
      const b = pos.get(edge.to)!;
      const siblings = outgoing.get(edge.from)!;
      const slot = siblings.indexOf(edge.to);
      const x1 = a.x + w + 2;
      const y1 = a.y + (a.h * (slot + 1)) / (siblings.length + 1);
      const x2 = b.x - 6;
      const y2 = b.y + b.h / 2;
      const span = graph.nodes.find((n) => n.id === edge.to)!.depth - graph.nodes.find((n) => n.id === edge.from)!.depth;
      const label = labelled.has(edge.to) ? "" : (relationOf.get(edge.to) ?? "");
      if (label) labelled.add(edge.to);
      const run = Math.max(28, textWidth(label, 13) + 40);
      const points: Array<[number, number]> =
        span > 1
          ? [[x1, y1], [x1 + 30, pad + 10], [x2 - run, pad + 10], [x2 - run, y2], [x2, y2]]
          : [[x1, y1], [x1 + Math.min(40, (x2 - run - x1) / 2), y1], [x2 - run, y2], [x2, y2]];
      const lx = x2 - (run - 24) / 2 - 8;
      const ly = y2 - 7;
      const labelSvg = label
        ? `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" class="sk-edge-label">${esc(label)}</text>`
        : "";
      return `<g class="sk-edge">${sketchArrow(points, seedOf(`${edge.from}>${edge.to}`))}${labelSvg}</g>`;
    })
    .join("");
  const nodes = graph.nodes
    .map((node, index) => {
      const { x, y, h } = pos.get(node.id)!;
      const color = node.changed ? "yellow" : linked.has(node.id) ? "blue" : "gray";
      const lines = labels[index]!;
      const first = y + h / 2 - ((lines.length - 1) * 19) / 2 + 6;
      return `<g class="sk-node ${color}"><a href="#impact-${index + 1}" aria-label="${esc(node.name)}: details"><title>${esc(`${node.name} · ${node.kind}${node.changed ? " · changed by this PR" : ""}`)}</title>${sketchBox(x, y, w, h, seedOf(node.id), { strokeWidth: node.changed ? 2.4 : 1.6 })}${lines
        .map((line, li) => `<text x="${x + w / 2}" y="${(first + li * 19).toFixed(1)}" text-anchor="middle" font-size="16">${esc(line)}</text>`)
        .join("")}</a></g>`;
    })
    .join("");
  return `<figure class="sketch-figure"><svg class="sketch" viewBox="0 0 ${width} ${height}" style="max-width:${width}px;min-width:${Math.min(width, Math.round(width * 0.7))}px" role="img" aria-label="Impact graph">${edges}${nodes}</svg><figcaption class="legend">${swatch("yellow")}Changed by this PR ${swatch("blue")}Affected by the change ${graph.nodes.some((node) => !linked.has(node.id)) ? `${swatch("gray")}Not linked ` : ""}<span class="muted">· Select a box to jump to its details.</span></figcaption></figure>`;
}
const swatch = (color: SketchColor) => `<svg class="swatch" viewBox="0 0 14 14" aria-hidden="true"><rect x="1" y="1" width="12" height="12" rx="3" class="sk-solid ${color} sk-swatch"/></svg>`;

function flowSketch(flow: ResolvedDocument["flows"][number], flowIndex: number) {
  const w = 168;
  const gap = 58;
  const perRow = 4;
  const pad = 10;
  const labels = flow.steps.map((step, index) => wrapText(`${index + 1}. ${step.label}`, 17, 3));
  const h = 34 + Math.max(...labels.map((lines) => lines.length)) * 18;
  const rows = Math.ceil(flow.steps.length / perRow);
  const cols = Math.min(perRow, flow.steps.length);
  const width = pad * 2 + cols * w + (cols - 1) * gap;
  const height = pad * 2 + rows * h + (rows - 1) * 46;
  // Snake layout: odd rows run right-to-left so the path never jumps back.
  const place = (index: number) => {
    const row = Math.floor(index / perRow);
    const col = index % perRow;
    const x = pad + (row % 2 ? cols - 1 - col : col) * (w + gap);
    return { x, y: pad + row * (h + 46), row };
  };
  const arrows = flow.steps
    .slice(1)
    .map((_, index) => {
      const a = place(index);
      const b = place(index + 1);
      const seed = seedOf(`${flow.title}:${index}`);
      if (a.row === b.row) {
        const forward = b.x > a.x;
        return sketchArrow([[forward ? a.x + w + 4 : a.x - 4, a.y + h / 2], [forward ? b.x - 6 : b.x + w + 6, b.y + h / 2]], seed);
      }
      return sketchArrow([[a.x + w / 2, a.y + h + 4], [a.x + w / 2 + 6, (a.y + h + b.y) / 2], [b.x + w / 2, b.y - 6]], seed);
    })
    .join("");
  const boxes = flow.steps
    .map((step, index) => {
      const { x, y } = place(index);
      const lines = labels[index]!;
      const first = y + h / 2 - ((lines.length - 1) * 18) / 2 + 6;
      return `<g class="sk-node ${step.changed ? "yellow" : "blue"}"><title>${esc(step.detail)}</title>${sketchBox(x, y, w, h, seedOf(`${flowIndex}:${step.label}`), { strokeWidth: step.changed ? 2.4 : 1.6 })}${lines
        .map((line, li) => `<text x="${x + w / 2}" y="${(first + li * 18).toFixed(1)}" text-anchor="middle" font-size="16">${esc(line)}</text>`)
        .join("")}</g>`;
    })
    .join("");
  return `<svg class="sketch" viewBox="0 0 ${width} ${height}" style="max-width:${width}px" role="img" aria-label="${esc(flow.title)}">${arrows}${boxes}</svg>`;
}

// ── Tab contents ────────────────────────────────────────────────────────────

const intro = (title: string, body: string) => `<div class="explain">${icon("info")}<div><b>${title}</b><p>${body}</p></div></div>`;

function overview(document: ResolvedDocument, facts: BriefingFacts) {
  const rows = document.summary
    .map((item) => {
      const where = item.evidence.slice(0, 2).map(location).join(" · ");
      return `<li class="row"><span class="tile">${icon(KIND_ICON[item.kind] ?? "info")}</span><span class="row-main"><b>${esc(item.claim)}</b>${where ? `<span class="muted mono">${esc(where)}</span>` : ""}</span>${badge(item.kind === "compatibility" ? "compat" : item.kind, KIND_TONE[item.kind])}</li>`;
    })
    .join("");
  return `<ul class="list">${rows}</ul>${facts.areas.labels.length ? `<h3 class="sec">Where the lines changed</h3>${areaChart(facts.areas)}${areaCaption(facts.areas)}` : ""}`;
}

function diffBlock(patch: string, path: string, options: { focus?: number; counts?: { added: number; removed: number } } = {}) {
  const lines = patch.split("\n").slice(2);
  let oldLine = 0;
  let newLine = 0;
  let bodyIndex = -1;
  const added = options.counts?.added ?? lines.filter((line) => line.startsWith("+")).length;
  const removed = options.counts?.removed ?? lines.filter((line) => line.startsWith("-")).length;
  const rows = lines
    .map((line) => {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        return "";
      }
      bodyIndex++;
      const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
      const sign = kind === "add" ? "+" : kind === "del" ? "−" : " ";
      // Two number columns, like GitHub: the line before and after the change.
      const before = kind === "add" ? "" : String(oldLine++);
      const after = kind === "del" ? "" : String(newLine++);
      return `<span class="dl dl-${kind}${bodyIndex === options.focus ? " dl-mark" : ""}"><span class="ln">${before}</span><span class="ln">${after}</span><span class="sign">${sign}</span>${esc(line.slice(1)) || " "}</span>`;
    })
    .join("");
  return `<figure class="code"><figcaption><code>${esc(path)}</code> <span class="plus">+${added}</span> <span class="minus">−${removed}</span>${options.counts ? ' <span class="muted">in this file</span>' : ""}</figcaption><pre>${rows}</pre></figure>`;
}

const dataUri = (image: { mime: string; bytes: Buffer }) => `data:${image.mime};base64,${image.bytes.toString("base64")}`;

function screenshots(shots: BriefingFacts["screenshots"], visualsList: VisualPair[], prUrl: string) {
  const parts: string[] = [];
  if (shots === null) parts.push(`<p class="muted">The PR description and comments could not be read, so screenshots are not shown.</p>`);
  else if (!shots.length)
    parts.push(
      `<div class="empty">${icon("image")}<div><b>No screenshots on this PR</b><p class="muted">Screenshots attached to the PR description or its comments show up here, side by side when they're labeled Before and After (for example, a two-column Before | After table).</p></div></div>`,
    );
  else
    for (const shot of shots) {
      if (shot.kind === "recording") {
        parts.push(`<div class="empty recording">${icon("play")}<div><b>Screen recording in the ${esc(shot.source)}</b><p class="muted">Recordings aren't embedded in briefings. <a href="${esc(prUrl)}" target="_blank" rel="noreferrer">Open the pull request</a> to watch it.</p></div></div>`);
        continue;
      }
      const caption = `${shot.label ? `<b>${esc(shot.label)}</b> · ` : ""}<span class="muted">from the ${esc(shot.source)}</span>`;
      parts.push(
        shot.kind === "pair"
          ? `<figure class="shot"><figcaption>${caption}</figcaption><div class="shot-pair"><div><span class="shot-tag before">Before</span><img alt="Before: ${esc(shot.label)}" src="${dataUri(shot.before)}"></div><div><span class="shot-tag after">After</span><img alt="After: ${esc(shot.label)}" src="${dataUri(shot.after)}"></div></div></figure>`
          : `<figure class="shot"><figcaption>${caption}</figcaption><div class="shot-single"><img alt="${esc(shot.label || "Screenshot")}" src="${dataUri(shot.image)}"></div></figure>`,
      );
    }
  if (visualsList.length)
    parts.push(
      `<p class="sub-label">Changed image files</p>${visualsList
        .map(
          (pair) => `<figure class="shot"><figcaption><code>${esc(pair.label)}</code> ${pair.identical ? badge("identical", "good") : badge("changed", "warn")}</figcaption><div class="shot-pair"><div><span class="shot-tag before">Before</span>${pair.before ? `<img alt="Before: ${esc(pair.path)}" src="${dataUri(pair.before)}">` : '<span class="muted">Not in the base commit</span>'}</div><div><span class="shot-tag after">After</span>${pair.after ? `<img alt="After: ${esc(pair.path)}" src="${dataUri(pair.after)}">` : '<span class="muted">Removed by this PR</span>'}</div></div></figure>`,
        )
        .join("")}`,
    );
  return parts.join("");
}

function beforeAfter(document: ResolvedDocument, facts: BriefingFacts, prUrl: string) {
  const evidenceCount = document.behavior.beforeEvidence.length + document.behavior.afterEvidence.length;
  const code = facts.examples.length
    ? facts.examples
        .map(
          (example) =>
            `<figure class="example"><p><b>What to notice:</b> ${esc(example.caption)}</p>${diffBlock(example.patch, example.path, { focus: example.focus, counts: { added: example.fileAdditions, removed: example.fileDeletions } })}</figure>`,
        )
        .join("")
    : facts.keyHunk
      ? `<p class="muted">The model didn't point at specific lines, so this is one changed hunk from a file it cited.</p>${diffBlock(facts.keyHunk.patch, facts.keyHunk.path)}`
      : `<p class="muted">No code example is available for this PR.</p>`;
  return `<p class="muted">What this PR changes, three ways: in words, in the code, and on screen.</p><h3 class="sec">In words</h3><div class="cols"><div class="side before"><span class="side-tag">Before this PR</span><p>${esc(document.behavior.before)}</p></div><div class="side after"><span class="side-tag">After this PR</span><p>${esc(document.behavior.after)}</p></div></div><h3 class="sec">In the code</h3>${code}<h3 class="sec">On screen</h3>${screenshots(facts.screenshots, facts.visuals, prUrl)}${
    evidenceCount
      ? `<details class="disclosure"><summary>${icon("chevron", "chev")}Evidence for this comparison <span class="muted">· ${plural(evidenceCount, "citation")}</span></summary><div class="disclosure-body cols"><div><p class="sub-label">Before</p>${evidenceLinks(document.behavior.beforeEvidence)}</div><div><p class="sub-label">After</p>${evidenceLinks(document.behavior.afterEvidence)}</div></div></details>`
      : ""
  }`;
}

function excerptBlock(excerpt: CodeExcerpt) {
  const lines = excerpt.code
    .split("\n")
    .map((line, index) => {
      const number = excerpt.from + index;
      return `<span class="dl${number === excerpt.focus ? " dl-mark" : ""}"><span class="ln">${number}</span>${esc(line) || " "}</span>`;
    })
    .join("");
  return `<figure class="code"><figcaption><a href="${esc(excerpt.url)}" target="_blank" rel="noreferrer"><code>${esc(excerpt.path)}:${excerpt.focus}</code></a> <span class="muted">· ${excerpt.side === "base" ? "before" : "after"} · ${esc(excerpt.note)}</span></figcaption><pre>${lines}</pre></figure>`;
}

function dependsLine(document: ResolvedDocument, item: ResolvedDocument["impacts"][number]) {
  const names = (item.dependsOn ?? [])
    .map((id) => document.impacts.find((other, index) => (other.id ?? `impact-${index + 1}`) === id)?.name)
    .filter((name): name is string => !!name);
  if (!names.length) return "";
  return `<p class="depends"><span class="muted">Depends on</span> ${names.map((name) => `<b>${esc(name)}</b>`).join(", ")}${item.relation ? ` <span class="muted">— ${esc(item.relation)}</span>` : ""}</p>`;
}

function impactAndFlow(document: ResolvedDocument) {
  const graph = impactGraph(document.impacts);
  const changed = document.impacts.filter((item) => item.changed).length;
  const linked = new Set(graph?.edges.flatMap((edge) => [edge.from, edge.to]) ?? []);
  // Compact, expandable rows instead of tall cards. A box in the diagram links
  // to its row; :target opens it without scripts.
  const row = (item: ResolvedDocument["impacts"][number], index: number) => {
    const id = item.id ?? `impact-${index + 1}`;
    const role = item.changed ? "changed" : linked.has(id) ? "affected" : "related";
    const roleWord = role === "changed" ? "Changed by this PR" : role === "affected" ? "Affected" : "Related";
    const count = item.evidence.length;
    return `<div class="xrow role-${role}" id="impact-${index + 1}"><input class="xtoggle" type="checkbox" id="impact-${index + 1}-open"${item.changed ? " checked" : ""}><label class="xhead" for="impact-${index + 1}-open">${icon("chevron", "chev")}<span class="role-dot"></span><span class="xtitle"><b>${esc(item.name)}</b><span class="xsum">${esc(item.change)}</span></span><span class="xmeta">${esc(roleWord)} · ${esc(item.kind)}${count ? ` · ${plural(count, "source")}` : ""}</span></label><div class="xbody"><p>${esc(item.change)}</p>${dependsLine(document, item)}${evidenceLinks(item.evidence)}</div></div>`;
  };
  const cards = document.impacts.map(row).join("");
  const flows = document.flows.length
    ? document.flows
        .map(
          (flow, index) =>
            `<section class="flow"><h4>${esc(flow.title)}</h4>${flowSketch(flow, index)}<ol class="flow-steps">${flow.steps
              .map((step) => `<li${step.changed ? ' class="changed"' : ""}><b>${esc(step.label)}</b>${step.changed ? ` ${badge("changed", "warn")}` : ""} <span class="muted">${esc(step.detail)}</span></li>`)
              .join("")}</ol></section>`,
        )
        .join("")
    : `<p class="muted">This PR doesn't change how requests or data move through the system.</p>`;
  return `<p class="muted">Who is affected by the change, and how information moves through it.</p><h3 class="sec">What this touches</h3><p>${changed ? `${plural(changed, "part")} changed directly` : "No single part is marked as the change"}${graph ? `; ${plural(linked.size - changed, "part")} depend on it` : ""}.</p>${graph ? impactSketch(document, graph) : ""}<div class="xlist">${cards}</div><h3 class="sec">How it flows</h3>${flows}`;
}

/** Progress line the in-app viewer keeps current as ticks change. */
const progressText = (group: string, total: number) => `<span data-progress="${group}">0 of ${total} confirmed</span>`;

function verified(rows: AcceptanceRow[], checks: CheckRun[] | null, references: ResolvedEvidence[]) {
  const counts = evidenceCounts(references);
  // The "N citations without a quote" row is part of the citation check, not a separate claim.
  const isCitationGap = (row: AcceptanceRow) => / without a quote$/.test(row.name);
  const checked = rows.filter((row) => row.status === "passed" || row.status === "failed");
  const needs = rows.filter((row) => row.status === "untested");
  const claims = rows.filter((row) => row.status === "claimed" && !isCitationGap(row));
  const failed = checked.filter((row) => row.status === "failed").length;
  const missing = references.filter((item) => item.status === "unresolved");
  const checkSentence = (row: AcceptanceRow) => {
    if (row.name === "Quoted citations match the code") {
      const quoted = counts.resolved + counts.unresolved;
      const lead = !quoted ? "No citation carried a quote to check." : counts.unresolved ? `${counts.resolved} of ${quoted} quoted citations were found in the code; ${counts.unresolved} were not.` : `All ${quoted} quoted citations were found in the code they point to.`;
      return `${lead}${counts.unverified ? ` ${plural(counts.unverified, "citation")} had no quote, so ${counts.unverified === 1 ? "it wasn't" : "they weren't"} checked.` : ""}`;
    }
    return row.note ?? "";
  };
  const tile = (id: string, tone: string, value: string, label: string, hint: string) =>
    `<a class="vtile tone-${tone}" href="#${id}"><b>${value}</b><span class="vtile-label">${label}</span><span class="muted">${hint}</span></a>`;
  const checkRows = checked
    .map(
      (row) =>
        `<li class="vcheck">${icon(row.status, `s-${row.status}`)}<div><b>${esc(row.name)}</b><p>${esc(checkSentence(row))}</p>${row.name === "Quoted citations match the code" && missing.length ? `<details class="disclosure inline"><summary>${icon("chevron", "chev")}Show the ${plural(missing.length, "citation")} not found</summary><div class="disclosure-body">${evidenceLinks(missing)}</div></details>` : ""}</div><span class="vby">${esc(row.by)}</span></li>`,
    )
    .join("");
  const todo = (list: AcceptanceRow[], prefix: string) =>
    list
      .map(
        (row, index) =>
          `<li><input type="checkbox" id="${prefix}-${index}" data-check="${prefix}-${seedOf(row.name).toString(36)}"><label for="${prefix}-${index}"><span class="box">${icon("check")}</span><span><b>${esc(row.name)}</b>${row.needs ? `<span class="muted">${esc(row.needs)}</span>` : ""}</span></label></li>`,
      )
      .join("");
  return `<p class="lede">An AI wrote this briefing. Here's what PR Briefings confirmed on its own, and what's left for you to confirm while you review.</p><div class="vtiles">${tile(
    "v-checked",
    failed ? "bad" : "good",
    `${checked.length - failed}/${checked.length}`,
    "Checked automatically",
    failed ? `${failed} check${failed === 1 ? "" : "s"} disagreed` : "against the code and GitHub",
  )}${tile("v-needs", needs.length ? "warn" : "neutral", String(needs.length), "Need you", needs.length ? progressText("need", needs.length) : "nothing to look at by hand")}${tile(
    "v-claims",
    "info",
    String(claims.length),
    "Claims to confirm",
    claims.length ? progressText("claim", claims.length) : "stated by the AI, not checked",
  )}</div>
<h3 class="sec" id="v-checked">Checked automatically</h3><ul class="vchecks">${checkRows}</ul>
${needs.length ? `<h3 class="sec" id="v-needs">Needs you</h3><p class="muted">Only a person can confirm these, for example by trying the change in the running app.</p><ul class="todo">${todo(needs, "need")}</ul>` : ""}
<h3 class="sec" id="v-claims">Claims to confirm while you review</h3>${
    claims.length
      ? `<p class="muted">The AI says these stay true, but nothing checked them. Tick each one off once the diff convinces you. Your ticks are saved with this version of the PR and reset when it gets new commits.</p><ul class="todo">${todo(claims, "claim")}</ul>`
      : `<p class="muted">The AI made no claims that need confirming.</p>`
  }
${checksSection(checks)}`;
}

const BUCKET_WORD: Record<CheckRun["bucket"], string> = { pass: "passed", fail: "failed", pending: "pending", skipping: "skipped", cancel: "cancelled" };
function duration(checks: CheckRun[]) {
  const starts = checks.map((check) => Date.parse(check.startedAt ?? "")).filter(Number.isFinite);
  const ends = checks.map((check) => Date.parse(check.completedAt ?? "")).filter(Number.isFinite);
  if (!starts.length || !ends.length) return "";
  const seconds = Math.max(0, Math.round((Math.max(...ends) - Math.min(...starts)) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
function checksSection(checks: CheckRun[] | null) {
  const head = `<h3 class="sec">CI checks on this commit</h3>`;
  if (!checks) return `${head}<p class="muted">GitHub check runs could not be read for this commit.</p>`;
  if (!checks.length) return `${head}<p class="muted">GitHub reported no check runs for this commit.</p>`;
  const counts = checkCounts(checks)!;
  const state = counts.failed ? "failed" : counts.pending ? "untested" : "passed";
  const label = counts.failed ? "Failing" : counts.pending ? "Still running" : "All passing";
  const time = duration(checks);
  return `${head}<p>${icon(state, `s-${state}`)} <b class="st-${state}">${label}</b> <span class="muted">· ${counts.passed} of ${plural(checks.length, "check")} passed${time ? ` · ${time}` : ""}</span></p><ul class="checks">${checks
    .map((run) => `<li><span class="ev-status ev-${run.bucket === "pass" ? "resolved" : run.bucket === "fail" ? "unresolved" : "unverified"}">${BUCKET_WORD[run.bucket]}</span> ${run.link ? `<a href="${esc(run.link)}" target="_blank" rel="noreferrer">${esc(run.name)}</a>` : esc(run.name)}${run.workflow ? ` <span class="muted">· ${esc(run.workflow)}</span>` : ""}</li>`)
    .join("")}</ul>`;
}

const LEVELS = ["risk", "watch", "note"] as const;
const LEVEL_WORD = { risk: "High", watch: "Medium", note: "Low" } as const;
const LEVEL_HINT = { risk: "could change behavior or break something", watch: "worth checking", note: "good to know" } as const;
function risks(document: ResolvedDocument) {
  const lead = `<p class="lede">Spots the AI thinks deserve a closer look while you review: likely trouble spots and open questions, not confirmed bugs. Open one to see how to check it and where to look.</p>`;
  if (!document.considerations.length) return `${lead}<p class="muted">The AI didn't flag any risks or open questions for this PR.</p>`;
  const items = [...document.considerations].sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level));
  const count = (level: (typeof LEVELS)[number]) => items.filter((item) => item.level === level).length;
  // CSS-only severity filter: radio chips hide the other severities.
  const chips = `<input class="rfilter" type="radio" name="risk-filter" id="rf-all" checked>${LEVELS.filter(count)
    .map((level) => `<input class="rfilter" type="radio" name="risk-filter" id="rf-${level}">`)
    .join("")}<div class="rchips"><label for="rf-all">All <b>${items.length}</b></label>${LEVELS.filter(count)
    .map((level) => `<label for="rf-${level}"><span class="dot sev-${level}"></span>${LEVEL_WORD[level]} <b>${count(level)}</b></label>`)
    .join("")}<span class="muted rchips-hint">High: ${LEVEL_HINT.risk} · Medium: ${LEVEL_HINT.watch} · Low: ${LEVEL_HINT.note}</span></div>`;
  const rows = items
    .map((item, index) => {
      const where = item.evidence[0] ? location(item.evidence[0]) : "";
      return `<div class="xrow rrow sev-row-${item.level}" id="risk-${index + 1}"><input class="xtoggle" type="checkbox" id="risk-${index + 1}-open"${index === 0 && item.level === "risk" ? " checked" : ""}><label class="xhead" for="risk-${index + 1}-open">${icon("chevron", "chev")}<span class="sev-pill sev-${item.level}">${LEVEL_WORD[item.level]}</span><span class="xtitle"><b>${esc(item.title)}</b><span class="xsum">${esc(item.detail)}</span></span>${where ? `<span class="xmeta mono">${esc(where)}${item.evidence.length > 1 ? ` +${item.evidence.length - 1}` : ""}</span>` : ""}</label><div class="xbody"><p>${esc(item.detail)}</p>${item.check ? `<p class="check"><b>How to check:</b> ${esc(item.check)}</p>` : ""}${item.evidence.length ? `<p class="sub-label">Where to look</p>${evidenceLinks(item.evidence)}` : ""}</div></div>`;
    })
    .join("");
  return `${lead}${chips}<div class="xlist risks-list">${rows}</div>`;
}

function evidence(pr: PullRequest, references: ResolvedEvidence[], document: ResolvedDocument, facts: BriefingFacts, generationId: string, model: string) {
  const counts = evidenceCounts(references);
  const boundaries = Array.from({ length: Math.max(document.boundaries.inScope.length, document.boundaries.outOfScope.length, document.boundaries.unchanged.length) }, (_, index) =>
    [document.boundaries.inScope[index], document.boundaries.outOfScope[index], document.boundaries.unchanged[index]].map((cell) => `<td>${esc(cell ?? "")}</td>`).join(""),
  );
  return `<p>Every source the briefing cites. For each one, the model quoted the code it relies on, and PR Briefings looked for that quote in the real file: <b>${counts.resolved}</b> of ${counts.total} matched${counts.unverified ? `, ${counts.unverified} had no quote to check` : ""}${counts.unresolved ? `, <b class="t-bad">${counts.unresolved}</b> weren't found` : ""}. Before-evidence links to the base commit; after-evidence links to the head.</p><ol class="sources">${references
    .map(
      (item, index) =>
        `<li><span class="num">${index + 1}</span><span class="row-main"><span><a href="${esc(item.url)}" target="_blank" rel="noreferrer">${esc(`${item.path.split("/").pop()}${item.line ? `:${item.line}` : ""} · ${item.side === "base" ? "before" : "after"}`)}</a> <span class="ev-status ev-${item.status}">${STATUS_WORD[item.status]}</span></span><span class="muted mono">${esc(item.path)}</span><span>${esc(item.note)}${item.citedLine !== null && item.status === "resolved" ? ` <span class="muted">(model cited line ${item.citedLine})</span>` : ""}</span></span></li>`,
    )
    .join("")}</ol>${
    facts.excerpts.length
      ? `<details class="disclosure"><summary>${icon("chevron", "chev")}Code at the cited lines <span class="muted">· ${plural(facts.excerpts.length, "excerpt")}</span></summary><div class="disclosure-body">${facts.excerpts.map(excerptBlock).join("")}</div></details>`
      : ""
  }<details class="disclosure"><summary>${icon("chevron", "chev")}Scope boundaries</summary><div class="disclosure-body"><table class="table"><thead><tr><th>In scope</th><th>Out of scope</th><th>Unchanged</th></tr></thead><tbody>${boundaries.map((row) => `<tr>${row}</tr>`).join("")}</tbody></table></div></details><dl class="kv"><dt>Briefed head</dt><dd class="mono">${pr.headSha.slice(0, 12)}</dd><dt>Merge base</dt><dd class="mono">${pr.baseSha.slice(0, 12)}</dd><dt>Generation</dt><dd class="mono">${esc(generationId.slice(0, 8))}</dd><dt>Model</dt><dd>${esc(model)}</dd></dl>`;
}

// ── Styles (BB / Generative UI card look, light and dark) ───────────────────

const STYLE = `:root{color-scheme:light dark;--bg:#f7f9fb;--card:#eef4f9;--line:#d7dfe8;--ink:#1d2939;--muted:#5d6878;--soft:#dfe8f1;--accent:#3d6fa6;--accent-soft:#d9e6f3;--good:#1e7a6e;--good-soft:#d4ece7;--bad:#b4323a;--bad-soft:#f6dcdc;--warn:#9a5b16;--warn-soft:#f3e6d3;--purple:#3d6fa6;--bar-add:#2da44e;--bar-del:#cf222e;--gh-add:#1a7f37;--gh-del:#cf222e;--code:#ffffff;--add:#e3f3e6;--del:#fbe2e2}
@media(prefers-color-scheme:dark){:root{--bg:#111418;--card:#1a2129;--line:#303a46;--ink:#e6ebf1;--muted:#9aa6b4;--soft:#232d38;--accent:#8db6e3;--accent-soft:#223448;--good:#6fcfb8;--good-soft:#173a33;--bad:#f09a9f;--bad-soft:#3d2224;--warn:#e8b56d;--warn-soft:#3a2d1a;--bar-add:#3fb950;--bar-del:#f85149;--gh-add:#3fb950;--gh-del:#f85149;--code:#141a20;--add:#173323;--del:#3a1d20}}
*{box-sizing:border-box}html{background:var(--bg);color:var(--ink);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{margin:0;padding:24px 16px 48px}a{color:var(--ink);text-underline-offset:3px}p{margin:0 0 10px}h1{font-size:15px;font-weight:650;margin:0 0 12px}code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.86em}code{background:var(--soft);border-radius:4px;padding:1px 5px;overflow-wrap:anywhere}.muted{color:var(--muted)}.t-good{color:var(--good)}.t-bad{color:var(--bad)}.t-warn{color:var(--warn)}
.card{max-width:940px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 20px 16px}
.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:14px 0}.metric span{display:block;color:var(--muted);font-size:13px}.metric b{display:block;font-size:21px;font-weight:700;letter-spacing:-.01em;line-height:1.3}.metric.tone-good b{color:var(--good)}.metric.tone-bad b{color:var(--bad)}.metric.tone-warn b{color:var(--warn)}
.callout{display:flex;gap:10px;background:var(--soft);border-radius:8px;padding:11px 14px;margin-bottom:16px}.callout b{display:block;font-weight:600}.i{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;vertical-align:-3px}.callout .i{color:var(--accent);margin-top:3px}
.tab-input{position:absolute;opacity:0;pointer-events:none}.tabbar{display:flex;flex-wrap:wrap;gap:4px 18px;border-bottom:1px solid var(--line);margin-bottom:16px}.tabbar label{cursor:pointer;padding:6px 0 9px;color:var(--muted);border-bottom:2px solid transparent;margin-bottom:-1px}.tabbar label:hover{color:var(--ink)}.panel{display:none}
${[1, 2, 3, 4, 5, 6].map((n) => `#tab-${n}:checked~.tabbar label[for=tab-${n}]{color:var(--ink);font-weight:600;border-bottom-color:var(--ink)}#tab-${n}:checked~.panel-${n}{display:block}#tab-${n}:focus-visible~.tabbar label[for=tab-${n}]{outline:2px solid var(--accent);outline-offset:2px}`).join("")}
.badge{display:inline-block;flex:none;border-radius:999px;padding:0 8px;font-size:12px;line-height:20px;background:var(--soft);color:var(--muted);white-space:nowrap}.badge.tone-info{background:var(--accent-soft);color:var(--accent)}.badge.tone-good{background:var(--good-soft);color:var(--good)}.badge.tone-bad{background:var(--bad-soft);color:var(--bad)}.badge.tone-warn{background:var(--warn-soft);color:var(--warn)}
.list{list-style:none;margin:0 0 14px;padding:0}.row{display:flex;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line)}.row:last-child{border-bottom:0}.row-main{display:grid;gap:1px;flex:1;min-width:0}.row-main b{font-weight:500}.row-side{display:grid;justify-items:end;text-align:right;font-size:12.5px}.tile{display:grid;place-items:center;width:30px;height:30px;border-radius:7px;background:var(--soft);color:var(--muted);flex:none}
.chart{margin:4px 0 8px}.chart svg{width:100%;height:auto}.legend{display:flex;gap:16px;color:var(--muted);font-size:13px;margin-bottom:4px}.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px}.sw-add,.bar-add{background:var(--bar-add);fill:var(--bar-add)}.sw-del,.bar-del{background:var(--bar-del);fill:var(--bar-del)}.grid{stroke:var(--line);stroke-dasharray:3 4}.grid.base{stroke-dasharray:none}.tick,.xlab{font-size:11px;fill:var(--muted)}.caption{color:var(--ink)}.caption b{font-weight:600}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:14px}.cols .badge{margin-bottom:10px}.ev{list-style:none;margin:0;padding:0;display:grid;gap:6px;font-size:12.5px}.ev li{display:block}.ev-note{display:block;color:var(--muted)}.ev-status{font-size:11px;border-radius:999px;padding:0 6px;background:var(--soft);color:var(--muted)}.ev-resolved{background:var(--good-soft);color:var(--good)}.ev-unresolved{background:var(--bad-soft);color:var(--bad)}.ev-side{font-size:11px;color:var(--muted)}
.code{margin:6px 0 14px;background:var(--code);border:1px solid var(--line);border-radius:8px;overflow:hidden}.code figcaption{padding:8px 12px;border-bottom:1px solid var(--line);font-size:12.5px}.code figcaption code{background:none;padding:0}.plus{color:var(--gh-add);font-family:ui-monospace,Menlo,monospace;font-size:12px}.minus{color:var(--gh-del);font-family:ui-monospace,Menlo,monospace;font-size:12px}.code pre{margin:0;padding:8px 0;overflow-x:auto;font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}.dl{display:block;white-space:pre;padding-right:12px}.dl .ln{display:inline-block;width:3.6em;padding-right:1em;text-align:right;color:var(--muted);user-select:none}.dl .ln+.ln{width:3em}.dl-add{background:var(--add)}.dl-del{background:var(--del)}.dl-focus{background:var(--accent-soft)}
.compare{margin:8px 0 14px}.compare-head{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:8px}.pill{background:var(--soft);border-radius:8px;padding:6px 10px;font-size:13px}.pill .muted{margin-right:6px}.compare-pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}.compare-pair>div{display:grid;place-items:center;min-height:120px;background:var(--code);border:1px solid var(--line);border-radius:8px;padding:10px}.compare-pair img{max-width:100%;max-height:320px;object-fit:contain}
.diagram{margin:0 0 6px;overflow-x:auto;border-bottom:1px solid var(--line);padding-bottom:12px}.diagram svg{width:100%;height:auto}.node{fill:#d0ebff;stroke:#1c7ed6;stroke-width:1.3}.node.changed{fill:#a5d8ff;stroke:#1864ab;stroke-width:2.2}.node-label{font-size:12px;fill:#1d2939}.edge{fill:none;stroke:var(--muted);stroke-width:1.3}.arrow{fill:var(--muted)}.hint{color:var(--muted);font-size:13px}
@media(prefers-color-scheme:dark){.node{fill:#1b3a57;stroke:#4dabf7}.node.changed{fill:#1e4f7a;stroke:#a5d8ff}.node-label{fill:#e6ebf1}}
.group{margin:6px 0 14px}.disclosure{border-bottom:1px solid var(--line)}.disclosure summary{display:flex;gap:8px;align-items:center;padding:9px 0;cursor:pointer;list-style:none}.disclosure summary::-webkit-details-marker{display:none}.disclosure .chev{transition:transform .15s;color:var(--muted);width:14px;height:14px}.disclosure[open]>summary .chev{transform:rotate(90deg)}.disclosure summary b{font-weight:500}.disclosure-body{padding:0 0 12px 22px}.grow{flex:1}
.tm-meta{display:flex;justify-content:space-between;align-items:baseline;margin:14px 0 6px}.tm-meta span{color:var(--muted);font-size:13px}.treemap{position:relative;height:300px;margin-bottom:14px}.tm-group{position:absolute;padding:2px;overflow:hidden}.tm-group>*{border-radius:4px}.tm-head{position:absolute;inset:2px 2px auto;height:20px;padding:1px 6px;font-size:12px;color:var(--ink);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.tm-body{position:absolute;inset:24px 4px 4px}.tm-cell{position:absolute;border:2px solid transparent;background-clip:padding-box;padding:4px 6px;overflow:hidden;font-size:12px;display:grid;grid-template-columns:minmax(0,1fr);align-content:start}.tm-cell b{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tm-cell span{color:var(--muted);font-size:11.5px}
.tm-c0{background:#d3e2f1}.tm-c0 .tm-cell{background:#b9cfe6}.tm-c1{background:#d3e9e6}.tm-c1 .tm-cell{background:#b5d6d1}.tm-c2{background:#ecdfd2}.tm-c2 .tm-cell{background:#dcc6b2}.tm-c3{background:#e2dcef}.tm-c3 .tm-cell{background:#cbc1e3}.tm-c4{background:#e4e8dc}.tm-c4 .tm-cell{background:#cdd6c0}
@media(prefers-color-scheme:dark){.tm-c0{background:#1f3347}.tm-c0 .tm-cell{background:#2a4561}.tm-c1{background:#1d3a37}.tm-c1 .tm-cell{background:#285049}.tm-c2{background:#3a2e22}.tm-c2 .tm-cell{background:#4e3d2c}.tm-c3{background:#2c2840}.tm-c3 .tm-cell{background:#3b3557}.tm-c4{background:#2c3226}.tm-c4 .tm-cell{background:#3c4533}}
.steps{margin:0;padding:0;list-style:none;counter-reset:s}.steps li{position:relative;padding:0 0 12px 34px;display:grid;counter-increment:s}.steps li:before{content:counter(s);position:absolute;left:0;top:0;width:22px;height:22px;border-radius:50%;border:1.5px solid var(--line);display:grid;place-items:center;font-size:12px;color:var(--muted);background:var(--card)}.steps li.current:before{border-color:var(--accent);color:var(--accent);font-weight:700}.steps li b{font-weight:600}
.verdict{font-size:16px;margin:2px 0 6px}.tally{color:var(--muted);font-size:13px;display:flex;flex-wrap:wrap;gap:4px 14px;align-items:center}.tally b{color:var(--ink);font-weight:600}.segbar{display:flex;gap:2px;height:6px;border-radius:3px;overflow:hidden;margin:6px 0 12px}.seg-passed{background:var(--good)}.seg-claimed{background:repeating-linear-gradient(135deg,var(--accent) 0 3px,var(--accent-soft) 3px 6px)}.seg-untested{background:var(--warn)}.seg-failed{background:var(--bad)}
.needs{background:var(--warn-soft);border-radius:8px;padding:10px 14px;margin-bottom:12px}.needs-title{color:var(--warn);font-weight:600}.needs p{margin:0 0 4px}.needs p span{display:block;font-size:12.5px}
.s-passed{color:var(--good)}.s-passed .fill{fill:var(--good);stroke:none}.s-failed{color:var(--bad)}.s-failed .fill{fill:var(--bad);stroke:none}.on-fill{stroke:#fff}.s-untested{color:var(--muted)}.s-claimed{color:var(--accent)}.st-passed{color:var(--good)}.st-failed{color:var(--bad)}.st-claimed{color:var(--accent)}.st-untested{color:var(--ink)}.row-side b{font-weight:600}.accept .row{align-items:flex-start}.accept .row>.i{margin-top:3px}
h3.sub{display:flex;gap:8px;align-items:center;font-size:15px;margin:16px 0 4px}.checks{list-style:none;margin:0;padding:0;display:grid;gap:4px}
.seg.sev-risk,.dot.sev-risk{background:var(--bad)}.seg.sev-watch,.dot.sev-watch{background:var(--warn)}.seg.sev-note,.dot.sev-note{background:var(--accent)}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:2px}.file-group{border-top:1px solid var(--line);padding-top:8px;margin-top:8px}.file-head{display:flex;gap:8px;align-items:center;margin:0 0 2px}.file-head code{background:none;padding:0}.file-head .count{margin-left:auto;font-size:12.5px;color:var(--muted)}.finding{border-bottom:0}.sev-i-risk{color:var(--bad)}.sev-i-watch{color:var(--warn)}.sev-i-note{color:var(--accent)}
.sources{list-style:none;margin:0 0 12px;padding:0;display:grid;gap:10px}.sources li{display:flex;gap:10px}.num{display:grid;place-items:center;width:20px;height:20px;border-radius:50%;background:var(--soft);font-size:11.5px;flex:none;margin-top:1px}.sources a{font-weight:500}.sources .muted{font-size:12.5px}
.table{width:100%;border-collapse:collapse;font-size:13px}.table th,.table td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}.table th{color:var(--muted);font-weight:500}
.kv{display:grid;grid-template-columns:130px 1fr;margin:8px 0 0}.kv dt,.kv dd{margin:0;padding:9px 0;border-bottom:1px solid var(--line)}.kv dt{color:var(--muted)}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}.button{display:inline-flex;gap:8px;align-items:center;border:1px solid var(--line);background:var(--card);border-radius:8px;padding:6px 12px;text-decoration:none;font-weight:500}.button:hover{background:var(--soft)}
.metric b span,.metric .plus,.metric .minus{display:inline;font:inherit;color:inherit}.metric b .plus{color:var(--gh-add)}.metric b .minus{color:var(--gh-del)}.sec{font-size:14.5px;font-weight:650;margin:20px 0 8px}.sec:first-child{margin-top:0}.sub-label{font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin:10px 0 4px}
.explain{display:flex;gap:10px;background:var(--soft);border-radius:8px;padding:10px 14px;margin-bottom:14px}.explain .i{color:var(--accent);margin-top:3px}.explain b{display:block;font-weight:600}.explain p{margin:2px 0 0}
.side{background:var(--code);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.side p{margin:6px 0 0}.side-tag{font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}.side.before .side-tag{color:var(--bad)}.side.after .side-tag{color:var(--good)}.side.before{border-top:3px solid var(--bad)}.side.after{border-top:3px solid var(--good)}
.example{margin:0 0 16px}.example>p{margin-bottom:6px}.dl .sign{display:inline-block;width:1.4em;color:var(--muted);user-select:none}.dl-add .sign{color:var(--gh-add)}.dl-del .sign{color:var(--gh-del)}.dl-mark{box-shadow:inset 3px 0 0 var(--warn);font-weight:600}
.empty{display:flex;gap:12px;border:1px dashed var(--line);border-radius:10px;padding:12px 14px;margin-bottom:12px}.empty .i{width:22px;height:22px;color:var(--muted)}.empty p{margin:2px 0 0}
.shot{margin:0 0 14px}.shot figcaption{margin-bottom:6px;font-size:13px}.shot-pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}.shot-pair>div,.shot-single{position:relative;display:grid;place-items:center;background:var(--code);border:1px solid var(--line);border-radius:10px;padding:28px 10px 10px;min-height:120px}.shot img{max-width:100%;max-height:520px;object-fit:contain;border-radius:4px}.shot-tag{position:absolute;top:6px;left:8px;font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}.shot-tag.before{color:var(--bad)}.shot-tag.after{color:var(--good)}
.sketch-figure{margin:4px 0 12px;overflow-x:auto}.sketch-figure .legend{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;margin-top:6px}.swatch{width:14px;height:14px;vertical-align:-2px}
.impacts{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;margin-bottom:8px}.impact{background:var(--code);border:1px solid var(--line);border-radius:10px;padding:12px 14px;scroll-margin-top:12px}.impact:target{outline:2px solid var(--accent)}.impact-head{display:flex;gap:8px;align-items:center;font-size:12.5px}.impact h4{margin:8px 0 4px;font-size:14px}.impact p{margin:0 0 8px}.impact .depends{font-size:13px}.impact .depends b{font-weight:600}
.flow{margin:0 0 16px}.flow h4{margin:0 0 6px;font-size:14px}.flow .sketch{margin-bottom:8px}.flow-steps{margin:0;padding-left:22px;display:grid;gap:4px;font-size:13.5px}.flow-steps li.changed b{color:var(--warn)}
.summary-line{font-size:15px;margin:0 0 6px}.key{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:center;color:var(--muted);font-size:12.5px}.key b{color:var(--ink);font-weight:600;margin-left:-6px}.disclosure.inline{border:0}.disclosure.inline summary{padding:4px 0;font-size:12.5px;color:var(--accent)}
.risk{background:var(--code);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:10px;padding:12px 14px;margin-bottom:10px}.risk-risk{border-left-color:var(--bad)}.risk-watch{border-left-color:var(--warn)}.risk h4{display:flex;gap:8px;align-items:center;margin:0 0 6px;font-size:14px}.risk .check{background:var(--soft);border-radius:6px;padding:6px 10px}.sec .dot{margin-right:8px}
@media(max-width:700px){.shot-pair{grid-template-columns:1fr}}
.lede{font-size:14.5px;margin:0 0 14px}
.xlist{border:1px solid var(--line);border-radius:10px;background:var(--code);margin:4px 0 14px;overflow:hidden}.xrow{border-bottom:1px solid var(--line);scroll-margin-top:12px}.xrow:last-child{border-bottom:0}.xtoggle{position:absolute;opacity:0;pointer-events:none}.xhead{display:flex;gap:10px;align-items:center;padding:10px 12px;cursor:pointer}.xhead:hover{background:var(--soft)}.xhead .chev{flex:none;color:var(--muted);transition:transform .15s}.xtoggle:checked+.xhead .chev,.xrow:target .xhead .chev{transform:rotate(90deg)}.xtitle{display:grid;flex:1;min-width:0}.xtitle b{font-weight:600}.xsum{color:var(--muted);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.xtoggle:checked+.xhead .xsum,.xrow:target .xsum{display:none}.xmeta{flex:none;color:var(--muted);font-size:12.5px;text-align:right;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.xbody{display:none;padding:0 14px 12px 46px}.xbody>p:first-child{margin-top:0}.xtoggle:checked~.xbody,.xrow:target .xbody{display:block}.xrow:target,.xrow.flash,.impacts .flash{box-shadow:inset 3px 0 0 var(--accent);background:var(--accent-soft)}.xrow{transition:background .4s}.xtoggle:focus-visible+.xhead{outline:2px solid var(--accent);outline-offset:-2px}
.role-dot{width:10px;height:10px;border-radius:3px;flex:none;border:1px solid var(--sk-ink)}.role-changed .role-dot{background:var(--sk-yellow)}.role-affected .role-dot{background:var(--sk-blue)}.role-related .role-dot{background:var(--sk-gray)}
.rfilter{position:absolute;opacity:0;pointer-events:none}.rchips{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:10px}.rchips label{display:inline-flex;gap:6px;align-items:center;border:1px solid var(--line);border-radius:999px;padding:3px 11px;cursor:pointer;background:var(--code);font-size:13px}.rchips label b{font-weight:600}.rchips-hint{font-size:12px;margin-left:6px}
#rf-all:checked~.rchips label[for=rf-all],#rf-risk:checked~.rchips label[for=rf-risk],#rf-watch:checked~.rchips label[for=rf-watch],#rf-note:checked~.rchips label[for=rf-note]{background:var(--ink);color:var(--card);border-color:var(--ink)}
#rf-risk:checked~.risks-list .rrow:not(.sev-row-risk),#rf-watch:checked~.risks-list .rrow:not(.sev-row-watch),#rf-note:checked~.risks-list .rrow:not(.sev-row-note){display:none}
.sev-pill{flex:none;font-size:11.5px;font-weight:700;border-radius:999px;padding:1px 8px;color:#fff}.sev-pill.sev-risk{background:var(--bad)}.sev-pill.sev-watch{background:var(--warn)}.sev-pill.sev-note{background:var(--accent)}
.vtiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:6px}.vtile{display:grid;gap:1px;text-decoration:none;color:var(--ink);background:var(--code);border:1px solid var(--line);border-top:3px solid var(--line);border-radius:10px;padding:10px 14px}.vtile:hover{background:var(--soft)}.vtile b{font-size:22px;line-height:1.2}.vtile-label{font-weight:600}.vtile .muted{font-size:12.5px}.vtile.tone-good{border-top-color:var(--good)}.vtile.tone-good b{color:var(--good)}.vtile.tone-bad{border-top-color:var(--bad)}.vtile.tone-bad b{color:var(--bad)}.vtile.tone-warn{border-top-color:var(--warn)}.vtile.tone-warn b{color:var(--warn)}.vtile.tone-info{border-top-color:var(--accent)}.vtile.tone-info b{color:var(--accent)}
.vchecks{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:10px;background:var(--code)}.vcheck{display:flex;gap:10px;align-items:flex-start;padding:10px 14px;border-bottom:1px solid var(--line)}.vcheck:last-child{border-bottom:0}.vcheck>.i{margin-top:3px}.vcheck>div{flex:1}.vcheck p{margin:2px 0 0;color:var(--muted)}.vby{flex:none;font-size:12px;color:var(--muted);background:var(--soft);border-radius:999px;padding:1px 8px}
.todo{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:10px;background:var(--code)}.todo li{border-bottom:1px solid var(--line)}.todo li:last-child{border-bottom:0}.todo input{position:absolute;opacity:0;pointer-events:none}.todo label{display:flex;gap:10px;align-items:flex-start;padding:10px 14px;cursor:pointer}.todo label>span:last-child{display:grid}.todo b{font-weight:500}.todo .box{display:grid;place-items:center;flex:none;width:18px;height:18px;margin-top:1px;border:1.5px solid var(--muted);border-radius:5px}.todo .box .i{width:12px;height:12px;stroke-width:3;opacity:0;color:#fff}.todo input:checked+label .box{background:var(--good);border-color:var(--good)}.todo input:checked+label .box .i{opacity:1}.todo input:checked+label b{color:var(--muted);text-decoration:line-through}.todo input:focus-visible+label{outline:2px solid var(--accent);outline-offset:-2px}
@media(max-width:700px){.vtiles{grid-template-columns:1fr}.xmeta{display:none}}
@media(max-width:700px){.metrics{grid-template-columns:1fr 1fr}.cols,.compare-head,.compare-pair{grid-template-columns:1fr}.card{padding:16px 14px}body{padding:12px 8px 32px}}
@media print{.tab-input,.tabbar{display:none}.panel{display:block!important;margin-bottom:18px}.panel:before{content:attr(data-title);display:block;font-weight:700;font-size:15px;border-bottom:1px solid var(--line);margin-bottom:10px}}`;

const TABS = ["Overview", "Before / after", "Impact & flow", "Verified", "Risks", "Evidence"] as const;

export function renderBriefingHtml(options: {
  pr: PullRequest;
  generationId: string;
  document: BriefingDocument;
  model: string;
  facts?: BriefingFacts;
}) {
  const { pr, generationId, model } = options;
  const facts = options.facts ?? buildFacts({ pr, document: options.document, diff: "" });
  const document = facts.document;
  const references = allEvidence(document);
  const counts = evidenceCounts(references);
  const checks = checkCounts(facts.checks);
  const lines = facts.files.length
    ? { files: facts.files.length, added: facts.files.reduce((n, f) => n + f.additions, 0), removed: facts.files.reduce((n, f) => n + f.deletions, 0) }
    : { files: pr.changedFiles ?? 0, added: pr.additions ?? 0, removed: pr.deletions ?? 0 };
  const metric = (label: string, value: string, note: string, tone = "") => `<div class="metric${tone ? ` tone-${tone}` : ""}"><span>${esc(label)}</span><b>${esc(value)}</b><span>${esc(note)}</span></div>`;
  const metrics = [
    metric("Files", fmt(lines.files), "changed"),
    `<div class="metric"><span>Lines</span><b><span class="plus">+${fmt(lines.added)}</span> <span class="minus">−${fmt(lines.removed)}</span></b><span>added / removed</span></div>`,
    !checks
      ? metric("CI", "—", "checks unavailable")
      : !checks.total
        ? metric("CI", "none", "no check runs")
        : metric("CI", `${checks.passed}/${checks.total}`, checks.failed ? `${checks.failed} failing` : checks.pending ? `${checks.pending} pending` : "checks passing", checks.failed ? "bad" : checks.pending ? "warn" : "good"),
    metric("Evidence", `${counts.resolved}/${counts.total}`, "citations matched", counts.unresolved ? "bad" : counts.total && counts.resolved === counts.total ? "good" : "warn"),
  ].join("");
  const panels = [
    overview(document, facts),
    beforeAfter(document, facts, pr.url),
    impactAndFlow(document),
    verified(facts.acceptance, facts.checks, references),
    risks(document),
    evidence(pr, references, document, facts, generationId, model),
  ];
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="description" content="PR briefing for pull request ${pr.number}">
<title>${esc(pr.title)} · PR briefing</title>
<style>
${SKETCH_FONT_FACE}
${SKETCH_STYLE}
${STYLE}
</style>
</head>
<body>
<main class="card">
<h1>PR #${pr.number} · ${esc(pr.title)}</h1>
<p><b>${esc(`${pr.owner}/${pr.repo}`)}</b> · by ${esc(pr.author)} · base <code>${pr.baseSha.slice(0, 7)}</code> → head <code>${pr.headSha.slice(0, 7)}</code> · briefed by ${esc(model)}</p>
<p>${esc(document.verdict)}</p>
<div class="metrics">${metrics}</div>
<div class="callout">${icon("info")}<div><b>Remember this</b>${esc(document.boundaries.unchanged[0]!)}</div></div>
<div class="tabs">
${TABS.map((_, index) => `<input class="tab-input" type="radio" name="tabs" id="tab-${index + 1}"${index ? "" : " checked"}>`).join("")}
<nav class="tabbar" aria-label="Briefing sections">${TABS.map((label, index) => `<label for="tab-${index + 1}">${esc(label)}</label>`).join("")}</nav>
${panels.map((body, index) => `<section class="panel panel-${index + 1}" data-title="${esc(TABS[index]!)}" aria-label="${esc(TABS[index]!)}">${body}</section>`).join("\n")}
</div>
<div class="actions"><a class="button" href="${esc(pr.url)}" target="_blank" rel="noreferrer">${icon("pr")} Open pull request</a><a class="button" href="${esc(pr.url)}/files" target="_blank" rel="noreferrer">${icon("diff")} Files changed</a></div>
</main>
</body>
</html>`;
  if (Buffer.byteLength(html) > MAX_BRIEFING_HTML_BYTES)
    throw Error("Rendered briefing HTML exceeds the 5 MiB preview limit");
  return html;
}
