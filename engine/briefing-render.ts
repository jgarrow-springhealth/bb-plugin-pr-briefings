// Deterministic HTML rendering of a validated briefing plus its computed facts.
// The report is a static, script-free document opened in BB's file preview:
// charts and the impact graph are server-drawn SVG, and before/after images
// are embedded as data URIs in <img>, which cannot run scripts or fetch.
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
const list = (items: string[], className = "") =>
  `<ul${className ? ` class="${className}"` : ""}>${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const STATUS_LABEL: Record<ResolvedEvidence["status"], string> = {
  resolved: "matched",
  unverified: "unchecked",
  unresolved: "not found",
};

function evidenceItem(item: ResolvedEvidence, compact = false) {
  const location = `${item.path}${item.line ? `:${item.line}` : ""}`;
  const moved = item.citedLine !== null && item.status === "resolved" ? ` <span class="muted">(cited line ${item.citedLine})</span>` : "";
  return `<li><span class="ev-head"><a href="${esc(item.url)}" target="_blank" rel="noreferrer"><code>${esc(location)}</code></a><span class="chip chip-${item.status}" title="${item.status === "resolved" ? "The quoted code was found at this line" : item.status === "unverified" ? "No quote was given, so this citation was not checked" : "The quoted code or line was not found"}">${STATUS_LABEL[item.status]}</span><span class="chip chip-side">${item.side === "base" ? "before" : "after"}</span>${moved}</span>${compact ? "" : `<span class="muted">${esc(item.note)}</span>`}</li>`;
}
const evidenceList = (items: ResolvedEvidence[], compact = false) =>
  items.length ? `<ul class="evidence${compact ? " evidence-compact" : ""}">${items.map((item) => evidenceItem(item, compact)).join("")}</ul>` : "";

// ── Charts and diagrams (server-drawn SVG) ──────────────────────────────────

function areaChart(areas: AreaBreakdown) {
  if (!areas.labels.length) return "";
  const max = Math.max(1, ...areas.added, ...areas.removed);
  const labelWidth = 210;
  const barWidth = 420;
  const row = 34;
  const height = areas.labels.length * row + 8;
  const rows = areas.labels
    .map((label, index) => {
      const y = index * row + 4;
      const added = (areas.added[index]! / max) * barWidth;
      const removed = (areas.removed[index]! / max) * barWidth;
      const shown = label.length > 30 ? `…${label.slice(-29)}` : label;
      return `<g><title>${esc(`${label}: +${areas.added[index]} −${areas.removed[index]} in ${plural(areas.files[index]!, "file")}`)}</title>
<text x="${labelWidth - 10}" y="${y + 19}" text-anchor="end" class="svg-label">${esc(shown)}</text>
<rect x="${labelWidth}" y="${y + 4}" width="${Math.max(added, areas.added[index] ? 2 : 0).toFixed(1)}" height="11" rx="3" class="svg-add"/>
<rect x="${labelWidth}" y="${y + 17}" width="${Math.max(removed, areas.removed[index] ? 2 : 0).toFixed(1)}" height="11" rx="3" class="svg-del"/>
<text x="${labelWidth + Math.max(added, removed) + 8}" y="${y + 20}" class="svg-num">+${areas.added[index]} −${areas.removed[index]}</text></g>`;
    })
    .join("");
  return `<figure class="chart"><svg viewBox="0 0 ${labelWidth + barWidth + 110} ${height}" width="${labelWidth + barWidth + 110}" role="img" aria-label="Lines added and removed by area">${rows}</svg>
<figcaption><span class="key key-add"></span>added <span class="key key-del"></span>removed · lines per area</figcaption></figure>`;
}

const wrap = (text: string, width: number, lines: number) => {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > width && current) {
      out.push(current);
      current = word;
    } else current = (current + " " + word).trim();
  }
  if (current) out.push(current);
  if (out.length > lines) {
    out.length = lines;
    out[lines - 1] = out[lines - 1]!.replace(/.{0,1}$/, "…");
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
  const w = 200;
  const h = 62;
  const colGap = 64;
  const rowGap = 16;
  const pos = new Map(graph.nodes.map((node) => [node.id, { x: 12 + node.depth * (w + colGap), y: 12 + node.row * (h + rowGap) }]));
  const width = Math.max(...graph.nodes.map((node) => pos.get(node.id)!.x)) + w + 12;
  const height = Math.max(...graph.nodes.map((node) => pos.get(node.id)!.y)) + h + 12;
  const edges = graph.edges
    .map((edge) => {
      const a = pos.get(edge.from)!;
      const b = pos.get(edge.to)!;
      const x1 = a.x + w;
      const y1 = a.y + h / 2;
      const x2 = b.x - 6;
      const y2 = b.y + h / 2;
      return `<path d="M${x1},${y1} C${x1 + colGap / 2},${y1} ${x2 - colGap / 2},${y2} ${x2},${y2}" class="svg-edge" marker-end="url(#arrow)"/>`;
    })
    .join("");
  const nodes = graph.nodes
    .map((node) => {
      const { x, y } = pos.get(node.id)!;
      const lines = wrap(node.name, 27, 2);
      return `<g><title>${esc(node.name)}</title><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="11" class="svg-node${node.changed ? " is-changed" : ""}"/>
${lines.map((line, index) => `<text x="${x + 12}" y="${y + 22 + index * 16}" class="svg-node-label">${esc(line)}</text>`).join("")}
<text x="${x + 12}" y="${y + h - 9}" class="svg-node-kind">${esc(node.changed ? `${node.kind} · changed` : node.kind)}</text></g>`;
    })
    .join("");
  return `<div class="graph-wrap"><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Impact graph"><defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="svg-arrow"/></marker></defs>${edges}${nodes}</svg></div>`;
}

// ── Sections ────────────────────────────────────────────────────────────────

const LEVEL_ORDER = { risk: 0, watch: 1, note: 2 } as const;

function attention(document: ResolvedDocument) {
  if (!document.considerations.length)
    return `<p class="muted">No high-level risks or open questions were identified.</p>`;
  return `<div class="findings">${[...document.considerations]
    .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])
    .map(
      (item) => `<article class="finding finding-${item.level}"><div class="finding-head"><span class="chip chip-level-${item.level}">${item.level}</span><h3>${esc(item.title)}</h3></div><p>${esc(item.detail)}</p>${evidenceList(item.evidence, true)}</article>`,
    )
    .join("")}</div>`;
}

const ACCEPTANCE_LABEL: Record<AcceptanceRow["status"], string> = {
  passed: "verified",
  failed: "failed",
  untested: "needs you",
  claimed: "claimed",
};
function acceptanceTable(rows: AcceptanceRow[]) {
  return `<table class="accept"><thead><tr><th>Status</th><th>Claim or check</th><th>Checked by</th></tr></thead><tbody>${rows
    .map(
      (row) => `<tr><td><span class="chip chip-accept-${row.status}">${ACCEPTANCE_LABEL[row.status]}</span></td><td><strong>${esc(row.name)}</strong>${row.note ? `<span class="muted">${esc(row.note)}</span>` : ""}${row.needs ? `<span class="needs">Needs you: ${esc(row.needs)}</span>` : ""}</td><td class="muted">${esc(row.by)}</td></tr>`,
    )
    .join("")}</tbody></table>`;
}

function diffBlock(patch: string, path: string) {
  const lines = patch
    .split("\n")
    .slice(2)
    .map((line) => {
      const kind = line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
      return `<span class="d-${kind}">${esc(line) || " "}</span>`;
    })
    .join("");
  return `<figure class="code"><figcaption><code>${esc(path)}</code> · a representative change</figcaption><pre class="diff">${lines}</pre></figure>`;
}

const dataUri = (image: NonNullable<VisualPair["before"]>) => `data:${image.mime};base64,${image.bytes.toString("base64")}`;
function visuals(pairs: VisualPair[]) {
  if (!pairs.length) return "";
  return `<h3 class="sub-h">What it looks like</h3><div class="visuals">${pairs
    .map(
      (pair) => `<figure class="visual"><figcaption><code>${esc(pair.label)}</code>${pair.identical ? '<span class="chip chip-resolved">identical</span>' : '<span class="chip chip-unverified">changed</span>'}</figcaption><div class="visual-pair"><div><span class="tag-sm">Before</span>${pair.before ? `<img alt="Before: ${esc(pair.path)}" src="${dataUri(pair.before)}">` : '<span class="muted">Not present</span>'}</div><div><span class="tag-sm">After</span>${pair.after ? `<img alt="After: ${esc(pair.path)}" src="${dataUri(pair.after)}">` : '<span class="muted">Removed</span>'}</div></div></figure>`,
    )
    .join("")}</div>`;
}

function excerptBlock(excerpt: CodeExcerpt) {
  const lines = excerpt.code
    .split("\n")
    .map((line, index) => {
      const number = excerpt.from + index;
      return `<span class="${number === excerpt.focus ? "focus" : ""}"><span class="ln">${number}</span>${esc(line) || " "}</span>`;
    })
    .join("");
  return `<figure class="code"><figcaption><a href="${esc(excerpt.url)}" target="_blank" rel="noreferrer"><code>${esc(excerpt.path)}:${excerpt.focus}</code></a> · ${excerpt.side === "base" ? "before" : "after"} · ${esc(excerpt.note)}</figcaption><pre>${lines}</pre></figure>`;
}

const CHECK_LABEL: Record<CheckRun["bucket"], string> = { pass: "passed", fail: "failed", pending: "pending", skipping: "skipped", cancel: "cancelled" };
function checksList(checks: CheckRun[] | null) {
  if (!checks) return `<p class="muted">Check runs could not be read for this head.</p>`;
  if (!checks.length) return `<p class="muted">No check runs were reported for this head.</p>`;
  return `<ul class="checks-list">${checks
    .map(
      (check) => `<li><span class="chip chip-check-${check.bucket}">${CHECK_LABEL[check.bucket]}</span>${check.link ? `<a href="${esc(check.link)}" target="_blank" rel="noreferrer">${esc(check.name)}</a>` : esc(check.name)}${check.workflow ? ` <span class="muted">· ${esc(check.workflow)}</span>` : ""}</li>`,
    )
    .join("")}</ul>`;
}

const STYLE = `:root{color-scheme:light dark;--bg:#f5f6fa;--panel:#fff;--ink:#151a2d;--muted:#596276;--line:#d8deea;--accent:#315f86;--accent-soft:#e8f1f8;--purple:#6f5bd3;--purple-soft:#f0edfc;--brown:#8b5e3c;--brown-soft:#f4ece5;--good:#087b5b;--good-soft:#e3f6ee;--bad:#9f3733;--bad-soft:#fbe9e7;--warn:#925700;--warn-soft:#fff3d7;--shadow:0 9px 28px rgba(25,32,56,.08);--card-shadow:0 2px 7px rgba(25,32,56,.04)}
@media(prefers-color-scheme:dark){:root{--bg:#10131b;--panel:#171c27;--ink:#eef2fb;--muted:#b3bdce;--line:#354054;--accent:#8fbce2;--accent-soft:#1b3042;--purple:#b9adff;--purple-soft:#2d2946;--brown:#d7ad86;--brown-soft:#38291f;--good:#72d9b7;--good-soft:#17372e;--bad:#ffaaa2;--bad-soft:#3b2424;--warn:#ffd078;--warn-soft:#3d2e16;--shadow:0 10px 30px rgba(0,0,0,.25);--card-shadow:0 2px 8px rgba(0,0,0,.18)}}
*{box-sizing:border-box}html{scroll-behavior:smooth;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{margin:0}main{max-width:1120px;margin:auto;padding:28px 22px 64px}a{color:var(--accent);text-underline-offset:3px}h1,h2,h3,p{margin-top:0}h1{font-size:clamp(2rem,4vw,2.6rem);line-height:1.08;letter-spacing:-.035em;margin:0 0 10px}h2{font-size:1.4rem;letter-spacing:-.018em;margin:0 0 14px}h3{font-size:1rem;margin:0 0 7px}.sub-h{margin:22px 0 10px}
.hero{background:linear-gradient(135deg,var(--panel),var(--accent-soft));border:1px solid var(--line);border-radius:22px;padding:clamp(24px,4vw,40px);box-shadow:var(--shadow)}.eyebrow,.memory-label{font-size:.72rem;font-weight:800;letter-spacing:.11em;text-transform:uppercase}.eyebrow{color:var(--accent);margin-bottom:9px}.eyebrow a{color:inherit;text-decoration:none}.memory-label{color:var(--purple)}.sub{max-width:820px;color:var(--muted);font-size:1.08rem}
.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:18px 0 22px}.metric{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:11px 14px}.metric b{display:block;font-size:1.35rem;letter-spacing:-.02em}.metric span{color:var(--muted);font-size:.78rem}.metric.tone-good b{color:var(--good)}.metric.tone-bad b{color:var(--bad)}.metric.tone-warn b{color:var(--warn)}
code{background:var(--accent-soft);color:var(--ink);padding:2px 5px;border-radius:5px;font:500 .88em/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.muted{color:var(--muted)}
.scan{display:grid;grid-template-columns:1.2fr .8fr;gap:24px;align-items:start}.plain-summary{margin:0;padding:0;list-style:none}.plain-summary li{display:flex;gap:10px;align-items:baseline;margin:0 0 9px}.memory{background:var(--panel);border:1px solid var(--line);border-left:5px solid var(--purple);border-radius:14px;padding:16px 17px}.memory h2{font-size:1rem;font-weight:650;margin:5px 0}.memory p{margin:0;color:var(--muted)}
.jump{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}.jump a{text-decoration:none;border:1px solid var(--line);border-radius:9px;background:var(--panel);padding:7px 10px;font-size:.78rem}.jump a:hover{border-color:var(--accent)}section{margin-top:32px}
.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:13px}.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px;box-shadow:var(--card-shadow);min-width:0}
.chip{display:inline-block;flex:none;border-radius:999px;padding:1px 8px;font-size:.66rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap;border:1px solid transparent}.chip-kind{background:var(--accent-soft);color:var(--accent)}.chip-resolved,.chip-accept-passed,.chip-check-pass{background:var(--good-soft);color:var(--good)}.chip-unverified,.chip-accept-claimed,.chip-check-skipping,.chip-check-cancel{background:var(--purple-soft);color:var(--purple)}.chip-unresolved,.chip-accept-failed,.chip-check-fail,.chip-level-risk{background:var(--bad-soft);color:var(--bad)}.chip-accept-untested,.chip-check-pending,.chip-level-watch{background:var(--warn-soft);color:var(--warn)}.chip-level-note{background:var(--accent-soft);color:var(--accent)}.chip-side{border-color:var(--line);color:var(--muted)}
.findings{display:grid;gap:10px}.finding{background:var(--panel);border:1px solid var(--line);border-left:5px solid var(--accent);border-radius:14px;padding:14px 16px}.finding-risk{border-left-color:var(--bad)}.finding-watch{border-left-color:var(--warn)}.finding-head{display:flex;gap:10px;align-items:baseline}.finding p{margin:4px 0 0}
.accept{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden}.accept th,.accept td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top;font-size:.9rem}.accept th{font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}.accept td span.muted,.accept td .needs{display:block;font-size:.82rem}.needs{color:var(--warn);font-weight:650}
.comparison{border-top:4px solid var(--bad)}.comparison.after{border-top-color:var(--good)}.tag{display:inline-block;margin-bottom:10px;border-radius:999px;padding:4px 8px;font-size:.7rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.before .tag{background:var(--bad-soft);color:var(--bad)}.after .tag{background:var(--good-soft);color:var(--good)}.tag-sm{display:block;font-size:.66rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
.evidence{display:grid;gap:7px;margin:11px 0 0;padding:0;list-style:none;font-size:.8rem}.evidence li{display:grid;gap:2px}.ev-head{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.evidence-compact{margin-top:10px}
.code{margin:14px 0 0;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}.code figcaption{padding:8px 12px;border-bottom:1px solid var(--line);font-size:.8rem;color:var(--muted)}.code pre{margin:0;padding:10px 0;overflow-x:auto;font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}.code pre>span{display:block;padding:0 12px;white-space:pre}.code .ln{display:inline-block;width:3.2em;color:var(--muted);user-select:none}.code .focus{background:var(--accent-soft)}.d-add{background:var(--good-soft)}.d-del{background:var(--bad-soft)}.d-hunk{color:var(--accent)}
.visuals{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}.visual{margin:0;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px}.visual figcaption{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-bottom:10px;font-size:.8rem}.visual-pair{display:grid;grid-template-columns:1fr 1fr;gap:10px}.visual-pair>div{display:grid;align-content:start;justify-items:center;background:repeating-conic-gradient(color-mix(in srgb,var(--line) 40%,transparent) 0 25%,transparent 0 50%) 0 0/16px 16px;border:1px solid var(--line);border-radius:9px;padding:10px;min-height:110px}.visual img{max-width:100%;max-height:220px;min-width:48px;object-fit:contain}
.chart{margin:0;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px}.chart svg{max-width:100%;height:auto}.chart figcaption{font-size:.78rem;color:var(--muted);margin-top:6px}.svg-label{font-size:12px;fill:var(--ink);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.svg-num{font-size:11.5px;fill:var(--muted)}.svg-add{fill:var(--good)}.svg-del{fill:var(--bad)}.key{display:inline-block;width:10px;height:10px;border-radius:3px;margin:0 4px 0 10px;vertical-align:-1px}.key-add{background:var(--good)}.key-del{background:var(--bad)}
.graph-wrap{overflow-x:auto;background:var(--panel);border:1px dashed var(--line);border-radius:18px;padding:14px;margin-bottom:14px}.svg-node{fill:var(--panel);stroke:var(--line);stroke-width:1.2}.svg-node.is-changed{fill:var(--accent-soft);stroke:var(--accent);stroke-width:2}.svg-node-label{font-size:12.5px;font-weight:650;fill:var(--ink)}.svg-node-kind{font-size:10.5px;fill:var(--muted);text-transform:uppercase;letter-spacing:.05em}.svg-edge{fill:none;stroke:var(--accent);stroke-width:1.5;opacity:.75}.svg-arrow{fill:var(--accent)}
.impact-card{padding:14px}.impact-card p{display:-webkit-box;margin-bottom:8px;font-size:.86rem;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}.impact-card.changed{outline:2px solid var(--accent);outline-offset:-2px}.change-badge{display:inline-block;margin-bottom:8px;border:1px solid var(--accent);border-radius:999px;padding:2px 7px;background:var(--accent-soft);color:var(--accent);font-size:.63rem;font-weight:800;letter-spacing:.07em;text-transform:uppercase;white-space:nowrap}
.flow-group+.flow-group{margin-top:18px}.flow-wrap{overflow-x:auto;background:var(--panel);border:1px dashed var(--line);border-radius:18px;padding:18px;box-shadow:var(--card-shadow)}.flow-diagram{display:flex;align-items:stretch;min-width:880px}.flow-step{display:grid;flex:1;align-content:center;min-width:190px;min-height:112px;padding:14px;border:1px solid var(--line);border-radius:13px;background:var(--panel)}.flow-step strong{margin-bottom:6px}.flow-step .flow-detail{color:var(--muted);font-size:.82rem}.flow-step.changed{border:2px solid var(--accent);background:var(--accent-soft)}.flow-step .change-badge{justify-self:start;align-self:start}.flow-arrow{display:grid;place-items:center;width:38px;color:var(--accent);font-size:1.4rem}.empty-flow{padding:18px;border:1px dashed var(--line);border-radius:14px;color:var(--muted)}
.checks{list-style:none;margin:0;padding:0}.checks li{position:relative;padding:7px 0 7px 25px;border-bottom:1px solid var(--line)}.checks li:last-child{border-bottom:0}.checks li:before{content:"✓";position:absolute;left:2px;color:var(--accent);font-weight:900}.checks-list{list-style:none;margin:0;padding:0;display:grid;gap:6px}.checks-list li{display:flex;gap:8px;align-items:center;font-size:.9rem}
details{margin-top:12px;background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden}summary{cursor:pointer;padding:14px 16px;font-weight:750}details>div{border-top:1px solid var(--line);padding:16px}.attention{background:var(--brown-soft);border:1px solid color-mix(in srgb,var(--brown) 34%,var(--line));border-radius:17px;padding:19px}.attention>h2{color:var(--brown)}
.refs{font-size:.86rem}.refs .evidence{margin-top:0}.integrity{display:grid;grid-template-columns:130px minmax(0,1fr);gap:7px 12px;margin:0}.integrity dt{color:var(--muted)}.integrity dd{margin:0}footer{margin-top:32px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:.78rem}
@media(max-width:780px){main{padding:16px 13px 42px}.hero{border-radius:16px}.scan,.grid2,.grid3,.metrics{grid-template-columns:1fr 1fr}.scan,.grid2,.grid3{grid-template-columns:1fr}.flow-wrap{padding:13px}.visual-pair{grid-template-columns:1fr}}
@media print{html{background:#fff;color:#151a2d}.hero,.card,.flow-wrap{box-shadow:none}.hero{background:#fff}a{color:#151a2d;text-decoration:none}}`;

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
  const metric = (label: string, value: string, note: string, tone = "") => `<div class="metric${tone ? ` tone-${tone}` : ""}"><b>${esc(value)}</b><span>${esc(label)} · ${esc(note)}</span></div>`;
  const metrics = [
    metric("Files", String(lines.files), "changed"),
    metric("Lines", `+${lines.added} −${lines.removed}`, "added / removed"),
    !checks
      ? metric("CI", "—", "unavailable")
      : !checks.total
        ? metric("CI", "none", "no check runs")
        : metric("CI", `${checks.passed}/${checks.total}`, checks.failed ? `${checks.failed} failing` : checks.pending ? `${checks.pending} pending` : "passing", checks.failed ? "bad" : checks.pending ? "warn" : "good"),
    metric("Evidence", `${counts.resolved}/${counts.total}`, "citations matched", counts.unresolved ? "bad" : counts.total && counts.resolved === counts.total ? "good" : "warn"),
  ].join("");
  const graph = impactGraph(document.impacts);
  const impactCards = document.impacts
    .map(
      (item) => `<article class="card impact-card${item.changed ? " changed" : ""}">
${item.changed ? '<span class="change-badge">Changed by this PR</span>' : ""}
<h3>${esc(item.name)}</h3>
<p title="${esc(item.change)}">${esc(item.change)}</p>
${item.changed ? evidenceList(item.evidence, true) : ""}
</article>`,
    )
    .join("");
  const flows = document.flows.length
    ? document.flows
        .map(
          (flow) =>
            `<div class="flow-group"><h3>${esc(flow.title)}</h3><div class="flow-wrap"><div class="flow-diagram">${flow.steps
              .map(
                (step, index) =>
                  `${index ? '<div class="flow-arrow" aria-hidden="true">→</div>' : ""}<div class="flow-step${step.changed ? " changed" : ""}">${step.changed ? '<span class="change-badge">Changed by this PR</span>' : ""}<strong>${esc(step.label)}</strong><span class="flow-detail">${esc(step.detail)}</span></div>`,
              )
              .join("")}</div></div></div>`,
        )
        .join("")
    : `<div class="empty-flow">No meaningful request or data-flow change in this pull request.</div>`;
  const sections: Array<[string, string]> = [
    ["attention", "Pay attention"],
    ["verified", "Verified vs. claimed"],
    ["before-after", "Before / after"],
    ...(facts.areas.labels.length ? ([["where", "Where it lands"]] as Array<[string, string]>) : []),
    ["impact", "Impact map"],
    ["flow", "Flow"],
    ...(facts.excerpts.length ? ([["code", "Key code"]] as Array<[string, string]>) : []),
    ["boundaries", "Boundaries"],
    ["ci", "CI checks"],
    ["evidence", "Evidence"],
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
<main>
<article class="hero" id="top">
<div class="eyebrow">Visual briefing · <a href="${esc(pr.url)}">${esc(`${pr.owner}/${pr.repo}`)} #${pr.number}</a> · head <code>${pr.headSha.slice(0, 7)}</code></div>
<h1>${esc(pr.title)}</h1>
<p class="sub">${esc(document.verdict)}</p>
<div class="metrics">${metrics}</div>
<div class="scan"><div><h2>In plain language</h2><ul class="plain-summary">${document.summary.map((item) => `<li><span class="chip chip-kind">${esc(item.kind)}</span><span>${esc(item.claim)}</span></li>`).join("")}</ul></div><aside class="memory"><div class="memory-label">Remember this</div><h2>What stays stable</h2><p>${esc(document.boundaries.unchanged[0]!)}</p></aside></div>
<nav class="jump" aria-label="Report sections">${sections.map(([id, label]) => `<a href="#${id}">${esc(label)}</a>`).join("")}</nav>
</article>
<section id="attention" class="attention"><h2>What to pay attention to</h2>${attention(document)}</section>
<section id="verified"><h2>Verified vs. claimed</h2>${acceptanceTable(facts.acceptance)}</section>
<section id="before-after"><h2>Before and after</h2><div class="grid2"><article class="card comparison before"><span class="tag">Before</span><h3>Previous behavior</h3><p>${esc(document.behavior.before)}</p>${evidenceList(document.behavior.beforeEvidence)}</article><article class="card comparison after"><span class="tag">After</span><h3>Reviewed behavior</h3><p>${esc(document.behavior.after)}</p>${evidenceList(document.behavior.afterEvidence)}</article></div>${facts.keyHunk ? diffBlock(facts.keyHunk.patch, facts.keyHunk.path) : ""}${visuals(facts.visuals)}</section>
${facts.areas.labels.length ? `<section id="where"><h2>Where the change lands</h2>${areaChart(facts.areas)}</section>` : ""}
<section id="impact"><h2>Impact map</h2>${graph ? impactGraphSvg(graph) : ""}<div class="grid3">${impactCards}</div></section>
<section id="flow"><h2>Information and interaction flow</h2>${flows}</section>
${facts.excerpts.length ? `<section id="code"><h2>Key code</h2>${facts.excerpts.map(excerptBlock).join("")}</section>` : ""}
<section id="boundaries"><h2>Boundaries and compatibility</h2><div class="grid2"><article class="card"><h3>In scope</h3>${list(document.boundaries.inScope, "checks")}</article><article class="card"><h3>Important invariants</h3>${list(document.boundaries.unchanged, "checks")}</article></div><details><summary>What is intentionally unchanged or out of scope</summary><div>${list(document.boundaries.outOfScope)}</div></details></section>
<section id="ci"><h2>CI checks</h2>${checksList(facts.checks)}</section>
<section id="evidence"><h2>Evidence and references</h2><details open><summary>${plural(references.length, "source reference")} · ${counts.resolved} matched${counts.unverified ? ` · ${counts.unverified} unchecked` : ""}${counts.unresolved ? ` · ${counts.unresolved} not found` : ""}</summary><div class="refs">${evidenceList(references)}</div></details><details><summary>Diff integrity and generation snapshot</summary><div><dl class="integrity"><dt>Pull request</dt><dd><a href="${esc(pr.url)}">${esc(`${pr.owner}/${pr.repo} #${pr.number}`)}</a></dd><dt>Briefed head</dt><dd><code>${pr.headSha}</code></dd><dt>Merge base</dt><dd><code>${pr.baseSha}</code></dd><dt>Generation</dt><dd><code>${esc(generationId)}</code></dd><dt>Model</dt><dd>${esc(model)}</dd></dl></div></details></section>
<footer>Model-authored explanation checked against immutable pull-request evidence · base <code>${pr.baseSha.slice(0, 12)}</code> → head <code>${pr.headSha.slice(0, 12)}</code></footer>
</main>
</body>
</html>`;
  if (Buffer.byteLength(html) > MAX_BRIEFING_HTML_BYTES)
    throw Error("Rendered briefing HTML exceeds the 5 MiB preview limit");
  return html;
}
