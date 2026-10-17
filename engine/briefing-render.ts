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

/** Slice-largest treemap of changed lines, grouped by top-level directory. */
function treemap(files: BriefingFacts["files"]) {
  type Node = { name: string; size: number; children?: Node[] };
  const groups = new Map<string, Map<string, number>>();
  for (const file of files) {
    const size = file.additions + file.deletions;
    if (!size) continue;
    const parts = file.path.split("/");
    const top = parts.length > 1 ? parts[0]! : "(root)";
    const second = parts.length > 2 ? parts[1]! : parts.at(-1)!;
    const inner = groups.get(top) ?? new Map<string, number>();
    inner.set(second, (inner.get(second) ?? 0) + size);
    groups.set(top, inner);
  }
  const nodes: Node[] = [...groups].map(([name, inner]) => ({
    name,
    size: [...inner.values()].reduce((a, b) => a + b, 0),
    children: [...inner].map(([child, size]) => ({ name: child, size })).sort((a, b) => b.size - a.size),
  })).sort((a, b) => b.size - a.size);
  if (nodes.length < 1 || files.length < 2) return "";
  const total = nodes.reduce((sum, node) => sum + node.size, 0);
  type Box = { x: number; y: number; w: number; h: number };
  const slice = (items: Node[], box: Box, out: Array<{ node: Node; box: Box }>) => {
    if (!items.length) return;
    if (items.length === 1) return void out.push({ node: items[0]!, box });
    const sum = items.reduce((a, b) => a + b.size, 0);
    const share = items[0]!.size / sum;
    if (box.w >= box.h * 1.4) {
      out.push({ node: items[0]!, box: { ...box, w: box.w * share } });
      slice(items.slice(1), { ...box, x: box.x + box.w * share, w: box.w * (1 - share) }, out);
    } else {
      out.push({ node: items[0]!, box: { ...box, h: box.h * share } });
      slice(items.slice(1), { ...box, y: box.y + box.h * share, h: box.h * (1 - share) }, out);
    }
  };
  // Lay out in pseudo-pixels (the container is about 2.4:1), emit percentages.
  const W = 240;
  const H = 100;
  const outer: Array<{ node: Node; box: Box }> = [];
  slice(nodes, { x: 0, y: 0, w: W, h: H }, outer);
  const pct = (value: number) => `${((value / total) * 100).toFixed(value / total < 0.1 ? 1 : 0)}%`;
  const style = (box: Box, w: number, h: number) =>
    `left:${((box.x / w) * 100).toFixed(2)}%;top:${((box.y / h) * 100).toFixed(2)}%;width:${((box.w / w) * 100).toFixed(2)}%;height:${((box.h / h) * 100).toFixed(2)}%`;
  const cells = outer
    .map(({ node, box }, index) => {
      const inner: Array<{ node: Node; box: Box }> = [];
      slice(node.children ?? [], { x: 0, y: 0, w: box.w, h: Math.max(box.h - 8, 1) }, inner);
      return `<div class="tm-group tm-c${index % 5}" style="${style(box, W, H)}" title="${esc(`${node.name} · ${fmt(node.size)} lines`)}"><div class="tm-head"><b>${esc(node.name)}</b> · ${fmt(node.size)} lines · ${pct(node.size)}</div><div class="tm-body">${inner
        .map(({ node: child, box: childBox }) => `<div class="tm-cell" style="${style(childBox, box.w, Math.max(box.h - 8, 1))}" title="${esc(`${node.name}/${child.name} · ${fmt(child.size)} lines`)}"><b>${esc(child.name)}</b><span>${fmt(child.size)} lines · ${pct(child.size)}</span></div>`)
        .join("")}</div></div>`;
    })
    .join("");
  return `<div class="tm-meta"><b>All</b><span>${fmt(total)} lines · ${plural(files.filter((file) => file.additions + file.deletions).length, "file")}</span></div><div class="treemap" role="img" aria-label="Changed lines by directory">${cells}</div>`;
}

// ── Impact graph ────────────────────────────────────────────────────────────

const wrap = (text: string, width: number, lines: number) => {
  const out: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
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
  return out;
};

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

function impactGraphSvg(graph: ImpactGraph) {
  const w = 180;
  const h = 46;
  const colGap = 90;
  const rowGap = 22;
  const columns = Math.max(...graph.nodes.map((node) => node.depth)) + 1;
  const tallest = Math.max(...[...Array(columns).keys()].map((depth) => graph.nodes.filter((node) => node.depth === depth).length));
  const height = 16 + tallest * (h + rowGap);
  const pos = new Map(
    graph.nodes.map((node) => {
      const inColumn = graph.nodes.filter((other) => other.depth === node.depth).length;
      const offset = (height - inColumn * (h + rowGap) + rowGap) / 2;
      return [node.id, { x: 8 + node.depth * (w + colGap), y: offset + node.row * (h + rowGap) - 8 }];
    }),
  );
  const width = 16 + columns * w + (columns - 1) * colGap;
  const edges = graph.edges
    .map((edge) => {
      const a = pos.get(edge.from)!;
      const b = pos.get(edge.to)!;
      const x1 = a.x + w;
      const y1 = a.y + h / 2;
      const x2 = b.x - 4;
      const y2 = b.y + h / 2;
      return `<path d="M${x1},${y1} C${x1 + colGap / 2},${y1} ${x2 - colGap / 2},${y2} ${x2},${y2}" class="edge" marker-end="url(#arrow)"/>`;
    })
    .join("");
  const nodes = graph.nodes
    .map((node) => {
      const { x, y } = pos.get(node.id)!;
      const lines = wrap(node.name, 24, 2);
      const first = y + h / 2 - (lines.length - 1) * 7.5 + 4;
      return `<g><title>${esc(`${node.name} · ${node.kind}${node.changed ? " · changed by this PR" : ""}`)}</title><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" class="node${node.changed ? " changed" : ""}"/>${lines
        .map((line, index) => `<text x="${x + w / 2}" y="${first + index * 15}" text-anchor="middle" class="node-label">${esc(line)}</text>`)
        .join("")}</g>`;
    })
    .join("");
  return `<figure class="diagram"><svg viewBox="0 0 ${width} ${height}" style="max-width:${width}px" role="img" aria-label="Impact graph"><defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrow"/></marker></defs>${edges}${nodes}</svg></figure>`;
}

// ── Tab contents ────────────────────────────────────────────────────────────

function overview(document: ResolvedDocument, facts: BriefingFacts) {
  const rows = document.summary
    .map((item) => {
      const where = item.evidence.slice(0, 2).map(location).join(" · ");
      return `<li class="row"><span class="tile">${icon(KIND_ICON[item.kind] ?? "info")}</span><span class="row-main"><b>${esc(item.claim)}</b>${where ? `<span class="muted mono">${esc(where)}</span>` : ""}</span>${badge(item.kind === "compatibility" ? "compat" : item.kind, KIND_TONE[item.kind])}</li>`;
    })
    .join("");
  return `<ul class="list">${rows}</ul>${facts.areas.labels.length ? areaChart(facts.areas) + areaCaption(facts.areas) : ""}`;
}

function diffBlock(patch: string, path: string) {
  const lines = patch.split("\n");
  const header = lines.slice(2);
  let oldLine = 0;
  let newLine = 0;
  const added = header.filter((line) => line.startsWith("+")).length;
  const removed = header.filter((line) => line.startsWith("-")).length;
  const rows = header
    .map((line) => {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        return "";
      }
      const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
      const number = kind === "del" ? oldLine++ : kind === "add" ? newLine++ : (oldLine++, newLine++);
      return `<span class="dl dl-${kind}"><span class="ln">${number}</span>${esc(line.slice(1)) || " "}</span>`;
    })
    .join("");
  return `<figure class="code"><figcaption><code>${esc(path)}</code> <span class="plus">+${added}</span> <span class="minus">−${removed}</span></figcaption><pre>${rows}</pre></figure>`;
}

const dataUri = (image: NonNullable<VisualPair["before"]>) => `data:${image.mime};base64,${image.bytes.toString("base64")}`;
function visuals(pairs: VisualPair[]) {
  if (!pairs.length) return "";
  const changed = pairs.filter((pair) => !pair.identical).length;
  return `<p><b>What it looks like</b> — ${plural(pairs.length, "image")} rendered at base and head${changed ? `; ${changed} changed` : "; all identical"}.</p>${pairs
    .map(
      (pair) => `<div class="compare"><div class="compare-head"><span class="pill"><span class="muted">Reference</span> Base</span><span class="pill"><span class="muted">Compared</span> Head</span></div><p class="muted mono">${esc(pair.label)} ${pair.identical ? badge("identical", "good") : badge("changed", "warn")}</p><div class="compare-pair"><div>${pair.before ? `<img alt="Before: ${esc(pair.path)}" src="${dataUri(pair.before)}">` : '<span class="muted">Not present at base</span>'}</div><div>${pair.after ? `<img alt="After: ${esc(pair.path)}" src="${dataUri(pair.after)}">` : '<span class="muted">Removed at head</span>'}</div></div></div>`,
    )
    .join("")}`;
}

function beforeAfter(document: ResolvedDocument, facts: BriefingFacts) {
  return `<div class="cols"><div>${badge("Before", "bad")}<p>${esc(document.behavior.before)}</p>${evidenceLinks(document.behavior.beforeEvidence)}</div><div>${badge("After", "good")}<p>${esc(document.behavior.after)}</p>${evidenceLinks(document.behavior.afterEvidence)}</div></div>${
    facts.keyHunk ? `<p><b>A typical change</b> — ${esc(facts.keyHunk.path.split("/").pop()!)}</p>${diffBlock(facts.keyHunk.patch, facts.keyHunk.path)}` : ""
  }${visuals(facts.visuals)}`;
}

function excerptBlock(excerpt: CodeExcerpt) {
  const lines = excerpt.code
    .split("\n")
    .map((line, index) => {
      const number = excerpt.from + index;
      return `<span class="dl${number === excerpt.focus ? " dl-focus" : ""}"><span class="ln">${number}</span>${esc(line) || " "}</span>`;
    })
    .join("");
  return `<figure class="code"><figcaption><a href="${esc(excerpt.url)}" target="_blank" rel="noreferrer"><code>${esc(excerpt.path)}:${excerpt.focus}</code></a> <span class="muted">· ${excerpt.side === "base" ? "before" : "after"} · ${esc(excerpt.note)}</span></figcaption><pre>${lines}</pre></figure>`;
}

function impactAndFlow(document: ResolvedDocument, facts: BriefingFacts) {
  const graph = impactGraph(document.impacts);
  const impacts = document.impacts
    .map(
      (item) =>
        `<details class="disclosure"><summary>${icon("chevron", "chev")}<b>${esc(item.name)}</b>${item.changed ? badge("changed by this PR", "info") : ""}<span class="muted">${esc(item.kind)}</span></summary><div class="disclosure-body"><p>${esc(item.change)}</p>${evidenceLinks(item.evidence)}</div></details>`,
    )
    .join("");
  const flows = document.flows
    .map(
      (flow) =>
        `<details class="disclosure"><summary>${icon("chevron", "chev")}Flow: ${esc(flow.title)}</summary><div class="disclosure-body"><ol class="steps">${flow.steps
          .map((step) => `<li class="${step.changed ? "current" : ""}"><b>${esc(step.label)}</b>${step.changed ? ` ${badge("changed", "info")}` : ""}<span class="muted">${esc(step.detail)}</span></li>`)
          .join("")}</ol></div></details>`,
    )
    .join("");
  const excerpts = facts.excerpts.length
    ? `<details class="disclosure"><summary>${icon("chevron", "chev")}Key code · ${plural(facts.excerpts.length, "excerpt")}</summary><div class="disclosure-body">${facts.excerpts.map(excerptBlock).join("")}</div></details>`
    : "";
  return `${graph ? impactGraphSvg(graph) + '<p class="hint">Open an impact below to see what changes there and its evidence.</p>' : ""}<div class="group">${impacts}</div>${treemap(facts.files)}<div class="group">${flows}${excerpts}</div>`;
}

const ACCEPT_WORD: Record<AcceptanceRow["status"], string> = { passed: "Passed", failed: "Failed", untested: "Not tested", claimed: "Only claimed" };
function verified(rows: AcceptanceRow[], checks: CheckRun[] | null) {
  const count = (status: AcceptanceRow["status"]) => rows.filter((row) => row.status === status).length;
  const passed = count("passed");
  const done = passed === rows.length;
  const segments = (["passed", "claimed", "untested", "failed"] as const)
    .filter((status) => count(status))
    .map((status) => `<span class="seg seg-${status}" style="flex:${count(status)}"></span>`)
    .join("");
  const needs = rows.filter((row) => row.needs);
  const tally = [
    count("failed") && `${icon("failed", "s-failed")} <b>${count("failed")}</b> failing`,
    count("untested") && `${icon("untested", "s-untested")} <b>${count("untested")}</b> not tested`,
    count("claimed") && `${icon("claimed", "s-claimed")} <b>${count("claimed")}</b> only claimed`,
  ].filter(Boolean);
  return `<p class="muted">What this briefing verified vs. what it only claims</p><h3 class="verdict">${done ? '<span class="t-good">Verified:</span>' : '<span class="t-bad">Not done:</span>'} ${passed} of ${plural(rows.length, "criterion").replace(/criterions$/, "criteria")} proven</h3>${tally.length ? `<p class="tally">${tally.join(" ")}</p>` : ""}<div class="segbar">${segments}</div>${
    needs.length
      ? `<div class="needs"><p class="needs-title">${icon("user")} Needs you</p>${needs.map((row) => `<p><b>${esc(row.needs!)}</b><span class="muted">${esc(row.name)}</span></p>`).join("")}</div>`
      : ""
  }<ul class="list accept">${rows
    .map(
      (row) =>
        `<li class="row">${icon(row.status, `s-${row.status}`)}<span class="row-main"><b>${esc(row.name)}</b>${row.note ? `<span class="muted">${esc(row.note)}</span>` : ""}${row.needs ? `<span class="t-warn">Needs you: ${esc(row.needs)}</span>` : ""}</span><span class="row-side"><b class="st-${row.status}">${ACCEPT_WORD[row.status]}</b><span class="muted">${row.status === "claimed" ? "claimed by" : "by"} ${esc(row.by)}</span></span></li>`,
    )
    .join("")}</ul>${checksSection(checks)}`;
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
  if (!checks) return `<h3 class="sub">${icon("untested", "s-untested")} Checks</h3><p class="muted">Check runs could not be read for this head.</p>`;
  if (!checks.length) return `<h3 class="sub">${icon("untested", "s-untested")} Checks</h3><p class="muted">No check runs were reported for this head.</p>`;
  const counts = checkCounts(checks)!;
  const state = counts.failed ? "failed" : counts.pending ? "untested" : "passed";
  const label = counts.failed ? "Failed" : counts.pending ? "Running" : "Succeeded";
  const groups = new Map<string, CheckRun[]>();
  for (const check of checks) groups.set(check.workflow ?? "Checks", [...(groups.get(check.workflow ?? "Checks") ?? []), check]);
  const time = duration(checks);
  return `<h3 class="sub">${icon(state, `s-${state}`)} Checks</h3><p><b class="st-${state}">${label}</b>${time ? ` <span class="muted">· ${time}</span>` : ""}</p><p class="muted">${plural(checks.length, "check")}: ${counts.passed} passed${counts.failed ? `, ${counts.failed} failed` : ""}${counts.pending ? `, ${counts.pending} pending` : ""}</p>${[...groups]
    .map(
      ([name, runs]) =>
        `<details class="disclosure"><summary>${icon("chevron", "chev")}${icon(runs.some((r) => r.bucket === "fail") ? "failed" : runs.some((r) => r.bucket === "pending") ? "untested" : "passed", runs.some((r) => r.bucket === "fail") ? "s-failed" : runs.some((r) => r.bucket === "pending") ? "s-untested" : "s-passed")}<b>${esc(name)}</b><span class="muted">${runs.filter((r) => r.bucket === "pass").length} passed</span></summary><div class="disclosure-body"><ul class="checks">${runs
          .map((run) => `<li><span class="ev-status ev-${run.bucket === "pass" ? "resolved" : run.bucket === "fail" ? "unresolved" : "unverified"}">${BUCKET_WORD[run.bucket]}</span> ${run.link ? `<a href="${esc(run.link)}" target="_blank" rel="noreferrer">${esc(run.name)}</a>` : esc(run.name)}</li>`)
          .join("")}</ul></div></details>`,
    )
    .join("")}`;
}

const LEVELS = ["risk", "watch", "note"] as const;
const LEVEL_WORD = { risk: "high", watch: "medium", note: "low" } as const;
function risks(document: ResolvedDocument) {
  const items = [...document.considerations].sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level));
  if (!items.length) return `<h3 class="sub">What to pay attention to</h3><p class="muted">No high-level risks or open questions were identified.</p>`;
  const anchor = (item: (typeof items)[number]) => item.evidence.find((e) => e.status === "resolved") ?? item.evidence[0] ?? null;
  const byFile = new Map<string, typeof items>();
  for (const item of items) {
    const key = anchor(item)?.path ?? "";
    byFile.set(key, [...(byFile.get(key) ?? []), item]);
  }
  const count = (level: (typeof LEVELS)[number]) => items.filter((item) => item.level === level).length;
  const files = [...byFile.keys()].filter(Boolean).length;
  return `<h3 class="sub">What to pay attention to</h3><p class="muted">${plural(items.length, "finding")}${files ? ` · ${plural(files, "file")}` : ""}</p><div class="segbar">${LEVELS.filter(count)
    .map((level) => `<span class="seg sev-${level}" style="flex:${count(level)}"></span>`)
    .join("")}</div><p class="tally">${LEVELS.filter(count)
    .map((level) => `<span class="dot sev-${level}"></span><b>${count(level)}</b> ${LEVEL_WORD[level]}`)
    .join(" ")}</p>${[...byFile]
    .map(
      ([file, group]) =>
        `<div class="file-group"><p class="file-head">${icon("file")}<code>${esc(file || "General")}</code><span class="count"><span class="dot sev-${group[0]!.level}"></span>${group.length}</span></p>${group
          .map((item) => {
            const at = anchor(item);
            return `<details class="disclosure finding"><summary>${icon("chevron", "chev")}${icon(item.level === "note" ? "info" : "warn", `sev-i-${item.level}`)}<span class="grow">${esc(item.title)}</span>${at?.line ? `<span class="mono muted">${at.line}</span>` : ""}${badge("Open")}</summary><div class="disclosure-body"><p>${esc(item.detail)}</p>${evidenceLinks(item.evidence)}</div></details>`;
          })
          .join("")}</div>`,
    )
    .join("")}`;
}

function evidence(pr: PullRequest, references: ResolvedEvidence[], document: ResolvedDocument, generationId: string, model: string) {
  const counts = evidenceCounts(references);
  const boundaries = Array.from({ length: Math.max(document.boundaries.inScope.length, document.boundaries.outOfScope.length, document.boundaries.unchanged.length) }, (_, index) =>
    [document.boundaries.inScope[index], document.boundaries.outOfScope[index], document.boundaries.unchanged[index]].map((cell) => `<td>${esc(cell ?? "")}</td>`).join(""),
  );
  return `<p>${counts.resolved} of ${plural(counts.total, "citation")} matched their quoted code${counts.unverified ? `, ${counts.unverified} unchecked` : ""}${counts.unresolved ? `, ${counts.unresolved} not found` : ""}. Before-evidence links to the base commit, after-evidence to the head; lines are re-anchored to the quoted code.</p><p class="muted">Sources</p><ol class="sources">${references
    .map(
      (item, index) =>
        `<li><span class="num">${index + 1}</span><span class="row-main"><span><a href="${esc(item.url)}" target="_blank" rel="noreferrer">${esc(`${item.path.split("/").pop()}${item.line ? `:${item.line}` : ""} · ${item.side === "base" ? "before" : "after"}`)}</a> <span class="ev-status ev-${item.status}">${STATUS_WORD[item.status]}</span></span><span class="muted">${icon("globe")} ${esc(pr.host)} · <span class="mono">${esc(item.path)}</span></span><span>${esc(item.note)}${item.citedLine !== null && item.status === "resolved" ? ` <span class="muted">(model cited line ${item.citedLine})</span>` : ""}</span></span></li>`,
    )
    .join("")}</ol><details class="disclosure"><summary>${icon("chevron", "chev")}Scope boundaries</summary><div class="disclosure-body"><table class="table"><thead><tr><th>In scope</th><th>Out of scope</th><th>Unchanged</th></tr></thead><tbody>${boundaries.map((row) => `<tr>${row}</tr>`).join("")}</tbody></table></div></details><dl class="kv"><dt>Briefed head</dt><dd class="mono">${pr.headSha.slice(0, 12)}</dd><dt>Merge base</dt><dd class="mono">${pr.baseSha.slice(0, 12)}</dd><dt>Generation</dt><dd class="mono">${esc(generationId.slice(0, 8))}</dd><dt>Model</dt><dd>${esc(model)}</dd></dl>`;
}

// ── Styles (BB / Generative UI card look, light and dark) ───────────────────

const STYLE = `:root{color-scheme:light dark;--bg:#f7f9fb;--card:#eef4f9;--line:#d7dfe8;--ink:#1d2939;--muted:#5d6878;--soft:#dfe8f1;--accent:#3d6fa6;--accent-soft:#d9e6f3;--good:#1e7a6e;--good-soft:#d4ece7;--bad:#b4323a;--bad-soft:#f6dcdc;--warn:#9a5b16;--warn-soft:#f3e6d3;--purple:#3d6fa6;--bar-add:#4573a8;--bar-del:#9aa6b2;--code:#ffffff;--add:#e3f3e6;--del:#fbe2e2}
@media(prefers-color-scheme:dark){:root{--bg:#111418;--card:#1a2129;--line:#303a46;--ink:#e6ebf1;--muted:#9aa6b4;--soft:#232d38;--accent:#8db6e3;--accent-soft:#223448;--good:#6fcfb8;--good-soft:#173a33;--bad:#f09a9f;--bad-soft:#3d2224;--warn:#e8b56d;--warn-soft:#3a2d1a;--bar-add:#6d9bd0;--bar-del:#5e6b78;--code:#141a20;--add:#173323;--del:#3a1d20}}
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
.code{margin:6px 0 14px;background:var(--code);border:1px solid var(--line);border-radius:8px;overflow:hidden}.code figcaption{padding:8px 12px;border-bottom:1px solid var(--line);font-size:12.5px}.code figcaption code{background:none;padding:0}.plus{color:var(--good);font-family:ui-monospace,Menlo,monospace;font-size:12px}.minus{color:var(--bad);font-family:ui-monospace,Menlo,monospace;font-size:12px}.code pre{margin:0;padding:8px 0;overflow-x:auto;font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}.dl{display:block;white-space:pre;padding-right:12px}.dl .ln{display:inline-block;width:3.6em;padding-right:1em;text-align:right;color:var(--muted);user-select:none}.dl-add{background:var(--add)}.dl-del{background:var(--del)}.dl-focus{background:var(--accent-soft)}
.compare{margin:8px 0 14px}.compare-head{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:8px}.pill{background:var(--soft);border-radius:8px;padding:6px 10px;font-size:13px}.pill .muted{margin-right:6px}.compare-pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}.compare-pair>div{display:grid;place-items:center;min-height:120px;background:var(--code);border:1px solid var(--line);border-radius:8px;padding:10px}.compare-pair img{max-width:100%;max-height:320px;object-fit:contain}
.diagram{margin:0 0 6px;overflow-x:auto;border-bottom:1px solid var(--line);padding-bottom:12px}.diagram svg{width:100%;height:auto}.node{fill:#d0ebff;stroke:#1c7ed6;stroke-width:1.3}.node.changed{fill:#a5d8ff;stroke:#1864ab;stroke-width:2.2}.node-label{font-size:12px;fill:#1d2939}.edge{fill:none;stroke:var(--muted);stroke-width:1.3}.arrow{fill:var(--muted)}.hint{color:var(--muted);font-size:13px}
@media(prefers-color-scheme:dark){.node{fill:#1b3a57;stroke:#4dabf7}.node.changed{fill:#1e4f7a;stroke:#a5d8ff}.node-label{fill:#e6ebf1}}
.group{margin:6px 0 14px}.disclosure{border-bottom:1px solid var(--line)}.disclosure summary{display:flex;gap:8px;align-items:center;padding:9px 0;cursor:pointer;list-style:none}.disclosure summary::-webkit-details-marker{display:none}.disclosure .chev{transition:transform .15s;color:var(--muted);width:14px;height:14px}.disclosure[open]>summary .chev{transform:rotate(90deg)}.disclosure summary b{font-weight:500}.disclosure-body{padding:0 0 12px 22px}.grow{flex:1}
.tm-meta{display:flex;justify-content:space-between;align-items:baseline;margin:14px 0 6px}.tm-meta span{color:var(--muted);font-size:13px}.treemap{position:relative;height:300px;margin-bottom:14px}.tm-group{position:absolute;padding:2px;overflow:hidden}.tm-group>*{border-radius:4px}.tm-head{position:absolute;inset:2px 2px auto;height:20px;padding:1px 6px;font-size:12px;color:var(--ink);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.tm-body{position:absolute;inset:24px 4px 4px}.tm-cell{position:absolute;border:2px solid transparent;background-clip:padding-box;padding:4px 6px;overflow:hidden;font-size:12px;display:grid;grid-template-columns:minmax(0,1fr);align-content:start}.tm-cell b{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tm-cell span{color:var(--muted);font-size:11.5px}
.tm-c0{background:#d3e2f1}.tm-c0 .tm-cell{background:#b9cfe6}.tm-c1{background:#d3e9e6}.tm-c1 .tm-cell{background:#b5d6d1}.tm-c2{background:#ecdfd2}.tm-c2 .tm-cell{background:#dcc6b2}.tm-c3{background:#e2dcef}.tm-c3 .tm-cell{background:#cbc1e3}.tm-c4{background:#e4e8dc}.tm-c4 .tm-cell{background:#cdd6c0}
@media(prefers-color-scheme:dark){.tm-c0{background:#1f3347}.tm-c0 .tm-cell{background:#2a4561}.tm-c1{background:#1d3a37}.tm-c1 .tm-cell{background:#285049}.tm-c2{background:#3a2e22}.tm-c2 .tm-cell{background:#4e3d2c}.tm-c3{background:#2c2840}.tm-c3 .tm-cell{background:#3b3557}.tm-c4{background:#2c3226}.tm-c4 .tm-cell{background:#3c4533}}
.steps{margin:0;padding:0;list-style:none;counter-reset:s}.steps li{position:relative;padding:0 0 12px 34px;display:grid;counter-increment:s}.steps li:before{content:counter(s);position:absolute;left:0;top:0;width:22px;height:22px;border-radius:50%;border:1.5px solid var(--line);display:grid;place-items:center;font-size:12px;color:var(--muted);background:var(--card)}.steps li.current:before{border-color:var(--accent);color:var(--accent);font-weight:700}.steps li b{font-weight:600}
.verdict{font-size:16px;margin:2px 0 6px}.tally{color:var(--muted);font-size:13px;display:flex;flex-wrap:wrap;gap:4px 14px;align-items:center}.tally b{color:var(--ink);font-weight:600}.segbar{display:flex;gap:2px;height:6px;border-radius:3px;overflow:hidden;margin:6px 0 12px}.seg-passed{background:var(--good)}.seg-claimed{background:repeating-linear-gradient(135deg,var(--accent) 0 3px,var(--accent-soft) 3px 6px)}.seg-untested{background:var(--bar-del)}.seg-failed{background:var(--bad)}
.needs{background:var(--warn-soft);border-radius:8px;padding:10px 14px;margin-bottom:12px}.needs-title{color:var(--warn);font-weight:600}.needs p{margin:0 0 4px}.needs p span{display:block;font-size:12.5px}
.s-passed{color:var(--good)}.s-passed .fill{fill:var(--good);stroke:none}.s-failed{color:var(--bad)}.s-failed .fill{fill:var(--bad);stroke:none}.on-fill{stroke:#fff}.s-untested{color:var(--muted)}.s-claimed{color:var(--accent)}.st-passed{color:var(--good)}.st-failed{color:var(--bad)}.st-claimed{color:var(--accent)}.st-untested{color:var(--ink)}.row-side b{font-weight:600}.accept .row{align-items:flex-start}.accept .row>.i{margin-top:3px}
h3.sub{display:flex;gap:8px;align-items:center;font-size:15px;margin:16px 0 4px}.checks{list-style:none;margin:0;padding:0;display:grid;gap:4px}
.seg.sev-risk,.dot.sev-risk{background:var(--bad)}.seg.sev-watch,.dot.sev-watch{background:var(--warn)}.seg.sev-note,.dot.sev-note{background:var(--accent)}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:2px}.file-group{border-top:1px solid var(--line);padding-top:8px;margin-top:8px}.file-head{display:flex;gap:8px;align-items:center;margin:0 0 2px}.file-head code{background:none;padding:0}.file-head .count{margin-left:auto;font-size:12.5px;color:var(--muted)}.finding{border-bottom:0}.sev-i-risk{color:var(--bad)}.sev-i-watch{color:var(--warn)}.sev-i-note{color:var(--accent)}
.sources{list-style:none;margin:0 0 12px;padding:0;display:grid;gap:10px}.sources li{display:flex;gap:10px}.num{display:grid;place-items:center;width:20px;height:20px;border-radius:50%;background:var(--soft);font-size:11.5px;flex:none;margin-top:1px}.sources a{font-weight:500}.sources .muted{font-size:12.5px}
.table{width:100%;border-collapse:collapse;font-size:13px}.table th,.table td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}.table th{color:var(--muted);font-weight:500}
.kv{display:grid;grid-template-columns:130px 1fr;margin:8px 0 0}.kv dt,.kv dd{margin:0;padding:9px 0;border-bottom:1px solid var(--line)}.kv dt{color:var(--muted)}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}.button{display:inline-flex;gap:8px;align-items:center;border:1px solid var(--line);background:var(--card);border-radius:8px;padding:6px 12px;text-decoration:none;font-weight:500}.button:hover{background:var(--soft)}
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
    metric("Lines", `+${fmt(lines.added)} −${fmt(lines.removed)}`, "added / removed"),
    !checks
      ? metric("CI", "—", "checks unavailable")
      : !checks.total
        ? metric("CI", "none", "no check runs")
        : metric("CI", `${checks.passed}/${checks.total}`, checks.failed ? `${checks.failed} failing` : checks.pending ? `${checks.pending} pending` : "checks passing", checks.failed ? "bad" : checks.pending ? "warn" : "good"),
    metric("Evidence", `${counts.resolved}/${counts.total}`, "citations matched", counts.unresolved ? "bad" : counts.total && counts.resolved === counts.total ? "good" : "warn"),
  ].join("");
  const panels = [
    overview(document, facts),
    beforeAfter(document, facts),
    impactAndFlow(document, facts),
    verified(facts.acceptance, facts.checks),
    risks(document),
    evidence(pr, references, document, generationId, model),
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
