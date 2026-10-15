import { z } from "zod";
import { MAX_BRIEFING_HTML_BYTES } from "./briefing-html.ts";
import type { PullRequest } from "../contract.ts";

const Copy = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value), {
      message: "Text contains control characters",
    });
const RepositoryPath = Copy(500).refine(
  (value) =>
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value
      .split("/")
      .some((part) => part === "" || part === "." || part === ".."),
  { message: "Evidence path must be repository-relative" },
);
const Evidence = z
  .object({
    path: RepositoryPath,
    line: z.number().int().positive().max(10_000_000).optional(),
    note: Copy(300),
  })
  .strict();
const EvidenceList = z.array(Evidence).max(8);
const Impact = z
  .object({
    name: Copy(120),
    kind: z.enum([
      "product surface",
      "service",
      "package",
      "data",
      "team",
      "operations",
    ]),
    changed: z.boolean(),
    change: Copy(360),
    evidence: EvidenceList,
  })
  .strict();
const Flow = z
  .object({
    title: Copy(160),
    steps: z
      .array(
        z
          .object({
            label: Copy(100),
            detail: Copy(260),
            changed: z.boolean(),
          })
          .strict(),
      )
      .min(2)
      .max(8)
      .refine((steps) => steps.filter((step) => step.changed).length <= 1, {
        message: "A flow can mark at most one changed step",
      }),
  })
  .strict();
export const BriefingDocument = z
  .object({
    verdict: Copy(320),
    summary: z
      .array(
        z
          .object({
            kind: z.enum(["behavior", "surface", "scope", "compatibility"]),
            claim: Copy(500),
            evidence: EvidenceList.min(1).max(4),
          })
          .strict(),
      )
      .min(3)
      .max(6),
    behavior: z
      .object({
        before: Copy(1200),
        beforeEvidence: EvidenceList.min(1).max(4),
        after: Copy(1200),
        afterEvidence: EvidenceList.min(1).max(4),
      })
      .strict(),
    impacts: z
      .array(Impact)
      .min(1)
      .max(12)
      .refine((items) => items.filter((item) => item.changed).length <= 1, {
        message: "An impact map can mark at most one changed item",
      }),
    flows: z.array(Flow).max(3),
    boundaries: z
      .object({
        inScope: z.array(Copy(400)).min(1).max(10),
        outOfScope: z.array(Copy(400)).min(1).max(10),
        unchanged: z.array(Copy(400)).min(1).max(10),
      })
      .strict(),
    considerations: z
      .array(
        z
          .object({
            level: z.enum(["note", "watch", "risk"]),
            title: Copy(140),
            detail: Copy(700),
            evidence: EvidenceList,
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export type BriefingDocument = z.infer<typeof BriefingDocument>;

function trimValidatedEvidence(value: unknown, maximum: number) {
  if (!Array.isArray(value)) return value;
  // Validate every model-authored reference before applying the presentation
  // bound so an unsafe path cannot be hidden in a discarded entry.
  return z.array(Evidence).parse(value).slice(0, maximum);
}

function normalizeEvidenceCardinality(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const document = value as Record<string, unknown>;
  const summary = Array.isArray(document.summary)
    ? document.summary.map((item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? {
              ...(item as Record<string, unknown>),
              evidence: trimValidatedEvidence(
                (item as Record<string, unknown>).evidence,
                4,
              ),
            }
          : item,
      )
    : document.summary;
  const behavior =
    document.behavior &&
    typeof document.behavior === "object" &&
    !Array.isArray(document.behavior)
      ? {
          ...(document.behavior as Record<string, unknown>),
          beforeEvidence: trimValidatedEvidence(
            (document.behavior as Record<string, unknown>).beforeEvidence,
            4,
          ),
          afterEvidence: trimValidatedEvidence(
            (document.behavior as Record<string, unknown>).afterEvidence,
            4,
          ),
        }
      : document.behavior;
  const normalizeEight = (items: unknown) =>
    Array.isArray(items)
      ? items.map((item) =>
          item && typeof item === "object" && !Array.isArray(item)
            ? {
                ...(item as Record<string, unknown>),
                evidence: trimValidatedEvidence(
                  (item as Record<string, unknown>).evidence,
                  8,
                ),
              }
            : item,
        )
      : items;
  return {
    ...document,
    summary,
    behavior,
    impacts: normalizeEight(document.impacts),
    considerations: normalizeEight(document.considerations),
  };
}

export function parseBriefingDocument(output: string): BriefingDocument {
  if (Buffer.byteLength(output) > 2 * 1024 * 1024)
    throw Error(
      "Briefing model output exceeds the 2 MiB structured-data limit",
    );
  const unfenced = output
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end < start)
    throw Error("Briefing model did not return a JSON object");
  let value: unknown;
  try {
    value = JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    throw Error("Briefing model returned invalid JSON");
  }
  return BriefingDocument.parse(normalizeEvidenceCardinality(value));
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
const list = (items: string[], className = "") =>
  `<ul${className ? ` class="${className}"` : ""}>${items
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("")}</ul>`;
const evidenceHref = (pr: PullRequest, path: string, line?: number) => {
  const encoded = path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `https://${pr.host}/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/blob/${pr.headSha}/${encoded}${line ? `#L${line}` : ""}`;
};
const evidence = (
  pr: PullRequest,
  items: z.infer<typeof Evidence>[],
  compact = false,
) =>
  items.length
    ? `<ul class="evidence${compact ? " evidence-compact" : ""}">${items
        .map((item) => {
          const location = `${item.path}${item.line ? `:${item.line}` : ""}`;
          return `<li><a href="${evidenceHref(pr, item.path, item.line)}" target="_blank" rel="noreferrer"><code>${escapeHtml(location)}</code></a>${compact ? "" : `<span>${escapeHtml(item.note)}</span>`}</li>`;
        })
        .join("")}</ul>`
    : "";
const shortSha = (sha: string) => sha.slice(0, 12);
const uniqueEvidence = (document: BriefingDocument) => {
  const all = [
    ...document.summary.flatMap((item) => item.evidence),
    ...document.behavior.beforeEvidence,
    ...document.behavior.afterEvidence,
    ...document.impacts.flatMap((item) => item.evidence),
    ...document.considerations.flatMap((item) => item.evidence),
  ];
  const seen = new Set<string>();
  return all.filter((item) => {
    const key = `${item.path}:${item.line ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export function renderBriefingHtml(options: {
  pr: PullRequest;
  generationId: string;
  document: BriefingDocument;
  model: string;
}) {
  const { pr, generationId, document, model } = options;
  const memory = `<div class="memory-label">Remember this</div><h2>What stays stable</h2><p>${escapeHtml(document.boundaries.unchanged[0])}</p>`;
  const impactCards = document.impacts
    .map(
      (
        item,
      ) => `<article class="card impact-card${item.changed ? " changed" : ""}">
${item.changed ? '<span class="change-badge">Changed by this PR</span>' : ""}
<h3>${escapeHtml(item.name)}</h3>
<p title="${escapeHtml(item.change)}">${escapeHtml(item.change)}</p>
${item.changed ? evidence(pr, item.evidence, true) : ""}
</article>`,
    )
    .join("");
  const flows = document.flows.length
    ? document.flows
        .map(
          (flow) =>
            `<div class="flow-group"><h3>${escapeHtml(flow.title)}</h3><div class="flow-wrap"><div class="flow-diagram">${flow.steps
              .map(
                (step, index) =>
                  `${index ? '<div class="flow-arrow" aria-hidden="true">→</div>' : ""}<div class="flow-step${step.changed ? " changed" : ""}">${step.changed ? '<span class="change-badge">Changed by this PR</span>' : ""}<strong>${escapeHtml(step.label)}</strong><span class="flow-detail">${escapeHtml(step.detail)}</span></div>`,
              )
              .join("")}</div></div></div>`,
        )
        .join("")
    : `<div class="empty-flow">No meaningful request or data-flow change in this pull request.</div>`;
  const attention = document.considerations.length
    ? `<ol>${document.considerations
        .map(
          (item) =>
            `<li><strong>${escapeHtml(item.title)}.</strong> ${escapeHtml(item.detail)}</li>`,
        )
        .join("")}</ol>`
    : `<p>No high-level risks or open questions were identified.</p>`;
  const references = uniqueEvidence(document);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="description" content="PR briefing for pull request ${pr.number}">
<title>${escapeHtml(pr.title)} · PR briefing</title>
<style>
:root{color-scheme:light dark;--bg:#f5f6fa;--panel:#fff;--ink:#151a2d;--muted:#596276;--line:#d8deea;--accent:#315f86;--accent-soft:#e8f1f8;--purple:#6f5bd3;--purple-soft:#f0edfc;--brown:#8b5e3c;--brown-soft:#f4ece5;--good:#087b5b;--good-soft:#e3f6ee;--bad:#9f3733;--bad-soft:#fbe9e7;--warn:#925700;--warn-soft:#fff3d7;--shadow:0 9px 28px rgba(25,32,56,.08);--card-shadow:0 2px 7px rgba(25,32,56,.04)}
@media(prefers-color-scheme:dark){:root{--bg:#10131b;--panel:#171c27;--ink:#eef2fb;--muted:#b3bdce;--line:#354054;--accent:#8fbce2;--accent-soft:#1b3042;--purple:#b9adff;--purple-soft:#2d2946;--brown:#d7ad86;--brown-soft:#38291f;--good:#72d9b7;--good-soft:#17372e;--bad:#ffaaa2;--bad-soft:#3b2424;--warn:#ffd078;--warn-soft:#3d2e16;--shadow:0 10px 30px rgba(0,0,0,.25);--card-shadow:0 2px 8px rgba(0,0,0,.18)}}
*{box-sizing:border-box}html{scroll-behavior:smooth;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{margin:0}main{max-width:1120px;margin:auto;padding:28px 22px 64px}a{color:var(--accent);text-underline-offset:3px}h1,h2,h3,p{margin-top:0}h1{font-size:clamp(2rem,4vw,2.8rem);line-height:1.08;letter-spacing:-.035em;margin:0 0 10px}h2{font-size:1.45rem;letter-spacing:-.018em;margin:0 0 14px}h3{font-size:1rem;margin:0 0 7px}.hero{background:linear-gradient(135deg,var(--panel),var(--accent-soft));border:1px solid var(--line);border-radius:22px;padding:clamp(24px,4vw,40px);box-shadow:var(--shadow)}.eyebrow{color:var(--accent)}.memory-label{color:var(--purple)}.eyebrow,.memory-label{font-size:.72rem;font-weight:800;letter-spacing:.11em;text-transform:uppercase}.eyebrow{margin-bottom:9px}.eyebrow a{color:inherit;text-decoration:none}.sub{max-width:820px;color:var(--muted);font-size:1.08rem}.meta{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0 22px}.pill{border:1px solid var(--line);background:var(--panel);border-radius:999px;padding:5px 10px;color:var(--muted);font-size:.78rem}.pill strong{color:var(--ink)}.pill code{background:var(--purple-soft);color:color-mix(in srgb,var(--purple) 90%,var(--ink))}code{background:var(--accent-soft);color:var(--ink);padding:2px 5px;border-radius:5px;font:500 .88em/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.scan{display:grid;grid-template-columns:1.2fr .8fr;gap:24px;align-items:start}.plain-summary{margin:0;padding-left:20px}.plain-summary li{margin:0 0 9px;padding-left:4px}.memory{background:var(--panel);border:1px solid var(--line);border-left:5px solid var(--purple);border-radius:14px;padding:16px 17px}.memory h2{font-size:1rem;font-weight:650;margin:5px 0}.memory p{margin:0;color:var(--muted);font-weight:400}.jump{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}.jump a{text-decoration:none;border:1px solid var(--line);border-radius:9px;background:var(--panel);padding:7px 10px;font-size:.78rem}.jump a:hover{border-color:var(--accent)}section{margin-top:30px}.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:13px}.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px;box-shadow:var(--card-shadow);min-width:0}.comparison{border-top:4px solid var(--bad)}.comparison.after{border-top-color:var(--good)}.tag{display:inline-block;margin-bottom:10px;border-radius:999px;padding:4px 8px;font-size:.7rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.before .tag{background:var(--bad-soft);color:var(--bad)}.after .tag{background:var(--good-soft);color:var(--good)}.comparison>p{margin-bottom:10px}.evidence{display:grid;gap:6px;margin:11px 0 0;padding:0;list-style:none;font-size:.78rem}.evidence li{display:grid;gap:2px}.evidence span{color:var(--muted)}.evidence-compact{margin-top:10px}.impact-card{padding:14px}.impact-card p{display:-webkit-box;margin-bottom:8px;font-size:.86rem;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}.impact-card.changed{outline:2px solid var(--accent);outline-offset:-2px}.change-badge{display:inline-block;margin-bottom:8px;border:1px solid var(--accent);border-radius:999px;padding:2px 7px;background:var(--accent-soft);color:var(--accent);font-size:.63rem;font-weight:800;letter-spacing:.07em;text-transform:uppercase;white-space:nowrap}.owner{font-size:.74rem;text-transform:capitalize}.flow-group+.flow-group{margin-top:18px}.flow-wrap{overflow-x:auto;background:var(--panel);border:1px dashed var(--line);border-radius:18px;padding:18px;box-shadow:var(--card-shadow)}.flow-diagram{display:flex;align-items:stretch;min-width:880px}.flow-step{display:grid;flex:1;align-content:center;min-width:190px;min-height:112px;padding:14px;border:1px solid var(--line);border-radius:13px;background:var(--panel)}.flow-step strong{margin-bottom:6px}.flow-step .flow-detail{color:var(--muted);font-size:.82rem}.flow-step.changed{border:2px solid var(--accent);background:var(--accent-soft)}.flow-step .change-badge{justify-self:start;align-self:start}.flow-arrow{display:grid;place-items:center;width:38px;color:var(--accent);font-size:1.4rem}.empty-flow{padding:18px;border:1px dashed var(--line);border-radius:14px;color:var(--muted)}.checks{list-style:none;margin:0;padding:0}.checks li{position:relative;padding:7px 0 7px 25px;border-bottom:1px solid var(--line)}.checks li:last-child{border-bottom:0}.checks li:before{content:"✓";position:absolute;left:2px;color:var(--accent);font-weight:900}details{margin-top:12px;background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden}summary{cursor:pointer;padding:14px 16px;font-weight:750}details>div{border-top:1px solid var(--line);padding:16px}.attention{background:var(--brown-soft);border:1px solid color-mix(in srgb,var(--brown) 34%,var(--line));border-radius:17px;padding:19px}.attention h2{color:var(--brown)}.attention ol{margin-bottom:0;padding-left:21px}.attention li{margin:8px 0}.refs{font-size:.86rem}.refs .evidence{margin-top:0}.integrity{display:grid;grid-template-columns:130px minmax(0,1fr);gap:7px 12px;margin:0}.integrity dt{color:var(--muted)}.integrity dd{margin:0}footer{margin-top:32px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:.78rem}
@media(max-width:780px){main{padding:16px 13px 42px}.hero{border-radius:16px}.scan,.grid2,.grid3{grid-template-columns:1fr}.flow-wrap{padding:13px}}
@media print{html{background:#fff;color:#151a2d}.hero,.card,.flow-wrap{box-shadow:none}.hero{background:#fff}a{color:#151a2d;text-decoration:none}}
</style>
</head>
<body>
<main>
<article class="hero" id="top">
<div class="eyebrow">Visual briefing · <a href="${escapeHtml(pr.url)}">${escapeHtml(`${pr.owner}/${pr.repo}`)} #${pr.number}</a></div>
<h1>${escapeHtml(pr.title)}</h1>
<p class="sub">${escapeHtml(document.verdict)}</p>
<div class="meta"><span class="pill"><strong>Surfaces</strong> ${document.impacts.length}</span><span class="pill"><strong>Flows</strong> ${document.flows.length || "none"}</span><span class="pill"><strong>Scope</strong> ${document.boundaries.inScope.length} changed · ${document.boundaries.outOfScope.length} out</span><span class="pill"><strong>Head verified</strong> <code>${pr.headSha.slice(0, 7)}</code></span></div>
<div class="scan"><div><h2>In plain language</h2><ul class="plain-summary">${document.summary.map((item) => `<li>${escapeHtml(item.claim)}</li>`).join("")}</ul></div><aside class="memory">${memory}</aside></div>
<nav class="jump" aria-label="Report sections"><a href="#before-after">Before / after</a><a href="#impact">Impact map</a><a href="#flow">Flow</a><a href="#boundaries">Boundaries</a><a href="#attention">Pay attention</a><a href="#evidence">Evidence</a></nav>
</article>
<section id="before-after"><h2>Before and after</h2><div class="grid2"><article class="card comparison before"><span class="tag">Before</span><h3>Previous behavior</h3><p>${escapeHtml(document.behavior.before)}</p>${evidence(pr, document.behavior.beforeEvidence)}</article><article class="card comparison after"><span class="tag">After</span><h3>Reviewed behavior</h3><p>${escapeHtml(document.behavior.after)}</p>${evidence(pr, document.behavior.afterEvidence)}</article></div></section>
<section id="impact"><h2>Compact impact map</h2><div class="grid3">${impactCards}</div></section>
<section id="flow"><h2>Information and interaction flow</h2>${flows}</section>
<section id="boundaries"><h2>Boundaries and compatibility</h2><div class="grid2"><article class="card"><h3>In scope</h3>${list(document.boundaries.inScope, "checks")}</article><article class="card"><h3>Important invariants</h3>${list(document.boundaries.unchanged, "checks")}</article></div><details><summary>What is intentionally unchanged or out of scope</summary><div>${list(document.boundaries.outOfScope)}</div></details></section>
<section id="attention" class="attention"><h2>What to pay attention to</h2>${attention}</section>
<section id="evidence"><h2>Evidence and references</h2><details open><summary>${references.length} verified source reference${references.length === 1 ? "" : "s"}</summary><div class="refs">${evidence(pr, references)}</div></details><details><summary>Diff integrity and generation snapshot</summary><div><dl class="integrity"><dt>Pull request</dt><dd><a href="${escapeHtml(pr.url)}">${escapeHtml(`${pr.owner}/${pr.repo} #${pr.number}`)}</a></dd><dt>Briefed head</dt><dd><code>${pr.headSha}</code></dd><dt>Merge base</dt><dd><code>${pr.baseSha}</code></dd><dt>Generation</dt><dd><code>${escapeHtml(generationId)}</code></dd><dt>Model</dt><dd>${escapeHtml(model)}</dd></dl></div></details></section>
<footer>Generated from immutable pull-request evidence · base <code>${shortSha(pr.baseSha)}</code> → head <code>${shortSha(pr.headSha)}</code></footer>
</main>
</body>
</html>`;
  if (Buffer.byteLength(html) > MAX_BRIEFING_HTML_BYTES)
    throw Error("Rendered briefing HTML exceeds the 5 MiB preview limit");
  return html;
}
