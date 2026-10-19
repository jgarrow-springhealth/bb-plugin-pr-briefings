// The Generative UI view of a briefing: a data file plus a fixed ```ui spec
// that the Generative UI plugin (bb-plugin-genui) renders inline in a BB chat.
//
// Safety model, same as the HTML report: the model only ever produces the
// validated BriefingDocument. This module writes the spec from a constant
// template, and every model-authored string reaches it as JSON data that the
// spec Loads — the model never writes the UI language, actions, or URLs.
// Strings shown as markdown are escaped so they cannot embed links or
// remote images.
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PullRequest } from "../contract.ts";
import { GENUI_STORAGE_DIR } from "../genui-chat.ts";
import { impactGraph } from "./briefing-render.ts";
import {
  allEvidence,
  checkCounts,
  evidenceCounts,
  type BriefingFacts,
  type ResolvedEvidence,
  type Side,
  type SourceReader,
} from "./facts.ts";

const MAX_COPIED_FILE = 256 * 1024;
const MAX_COPIED_TOTAL = 3 * 1024 * 1024;

/** Escapes markdown so model text renders literally (no links, images, HTML). */
export function escapeMarkdown(value: string) {
  return value.replace(/[\\`*_\[\]<>!|~]/g, (character) => `\\${character}`);
}

/** A Mermaid label that cannot close its node or start a directive. */
export function mermaidLabel(value: string) {
  const clean = value
    .replace(/["`<>{}\[\]()|#;:\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const short =
    clean.length <= 60
      ? clean
      : `${clean.slice(0, 57).replace(/\s+\S*$/, "")}…`;
  return `"${short || "…"}"`;
}

/** "Most new lines land in utils/ (+347); components/ shrinks the most (−227 net)." */
function areaCaption(areas: BriefingFacts["areas"]) {
  if (!areas.labels.length) return null;
  const most = areas.added.indexOf(Math.max(...areas.added));
  const net = areas.added.map((added, index) => added - areas.removed[index]!);
  const shrink = net.indexOf(Math.min(...net));
  const label = (index: number) => `**${escapeMarkdown(areas.labels[index]!)}**`;
  return `Most new lines land in ${label(most)} (+${areas.added[most]})${net[shrink]! < 0 ? `; ${label(shrink)} shrinks the most (${net[shrink]} net)` : ""}.`;
}

const SEVERITY = { risk: "high", watch: "medium", note: "low" } as const;
const KIND_TONE = { behavior: "info", surface: "info", scope: "neutral", compatibility: "good" } as const;
const KIND_ICON = { behavior: "Play", surface: "Layers", scope: "Lock", compatibility: "Check" } as const;

/**
 * The spec is a fixed template. The only generated parts are the Load path and
 * literal Snippet calls (Generative UI reads Snippet files before the UI runs,
 * so their paths must be literals); both are generator-owned paths, quoted with
 * JSON.stringify.
 */
export const GENUI_SPEC = (
  root: string,
  excerpts: ReadonlyArray<{ path: string; from: number; to: number }> = [],
) => `b = Load(${JSON.stringify(`${root}/briefing.json`)})
Card(b.meta.heading, [
  Text(b.meta.byline),
  Text(b.verdict),
  Row(b.metrics.map(m => Metric(m.label, m.value, note: m.note, tone: m.tone))),
  b.remember ? Callout(b.remember, tone: "info", title: "Remember this") : null,
  Tabs(["Overview", "Before / after", "Impact & flow", "Verified", "Risks", "Evidence"], [
    Stack([
      List(b.summary.map(s => ({title: s.title, detail: s.detail, icon: s.icon, value: Badge(s.kind, tone: s.tone)}))),
      b.areas.labels.length > 0 ? Chart("bar", b.areas.labels, {Added: b.areas.added, Removed: b.areas.removed}, unit: "lines") : null,
      b.areaCaption ? Text(b.areaCaption) : null
    ]),
    Stack([
      Row([
        Stack([Badge("Before", tone: "bad"), Text(b.behavior.before)]),
        Stack([Badge("After", tone: "good"), Text(b.behavior.after)])
      ]),
      Stack(b.code.map(c => Stack([Text(c.caption), Diff(c.patch)]))),
      Stack(b.screenshots.map(s => s.after ? Stack([Text(s.caption), Compare([{src: s.before, label: "Before"}, {src: s.after, label: "After"}])]) : Stack([Text(s.caption), Image(s.before, alt: s.label)]))),
      b.screenshotsNote ? Text(b.screenshotsNote, tone: "neutral") : null,
      b.visuals.length > 0 ? Text("**Changed image files** · switch a comparison to *Difference* to see what moved.") : null,
      Stack(b.visuals.map(v => v.before && v.after ? Compare([{src: v.before, label: "Base · " + v.label}, {src: v.after, label: "Head"}]) : Stack([Text(v.caption), Image(v.before ?? v.after, alt: v.label)])))
    ]),
    Stack([
      b.graph ? Diagram(b.graph.mermaid, b.graph.details) : null,
      b.treemap.length > 1 ? Treemap(b.treemap, "lines") : null,
      Stack(b.flows.map(f => Details("Flow: " + f.title, [Steps(f.steps)]))),
      ${excerpts.length ? `Details("Key code", [${excerpts.map((excerpt, index) => `Stack([Text(b.excerpts[${index}].caption), Snippet(${JSON.stringify(excerpt.path)}, ${Math.trunc(excerpt.from)}, ${Math.trunc(excerpt.to)})])`).join(", ")}])` : "null"}
    ]),
    Stack([
      Callout("PR Briefings double-checked some of this briefing itself, against the real code and GitHub. Rows marked *claimed* are only the model's word: confirm them while you review.", tone: "info", title: "What this tab is for"),
      Acceptance(b.acceptance),
      b.checks.length > 0 ? Pipeline(b.checks) : Text(b.checksNote, tone: "neutral")
    ]),
    Stack([
      Callout("The model's list of spots worth a closer look while you review: likely trouble spots and open questions, not confirmed bugs. Each says how to check it.", tone: "info", title: "What this tab is for"),
      b.findings.length > 0 ? Findings(b.findings, title: "What to pay attention to") : Text("The model didn't flag any risks or open questions for this PR.", tone: "neutral")
    ]),
    Stack([
      Text(b.evidenceNote, tone: "neutral"),
      Sources(b.sources),
      Details("Scope boundaries", [Table(["In scope", "Out of scope", "Unchanged"], b.boundaries)]),
      KeyValue(b.integrity)
    ])
  ]),
  FollowUps(["Walk me through the highest-risk item", "Which files should I read first?", "Draft review comments for the open items"]),
  Row([
    Button("Open pull request", OpenUrl(b.meta.url), icon: "GitPullRequest"),
    Button("Copy head SHA", Copy(b.meta.headSha), icon: "Copy")
  ])
])
`;

export interface GenuiBundle {
  name: string;
  files: Array<{ path: string; data: string | Buffer }>;
}

export function buildGenuiBundle(options: {
  pr: PullRequest;
  generationId: string;
  model: string;
  facts: BriefingFacts;
  name: string;
  sources?: SourceReader | null;
}): GenuiBundle {
  const { pr, facts, name } = options;
  const root = `$BB_THREAD_STORAGE/${GENUI_STORAGE_DIR}/${name}`;
  const document = facts.document;
  const files: GenuiBundle["files"] = [];
  let copied = 0;
  const copiedFiles = new Map<string, string | null>();
  /** Copies a cited file into the bundle so Snippet and Findings can show it. */
  const copy = (side: Side, path: string) => {
    const key = `${side}/${path}`;
    if (copiedFiles.has(key)) return copiedFiles.get(key)!;
    const text = options.sources?.read(side, path) ?? null;
    const size = text === null ? 0 : Buffer.byteLength(text);
    const ok = text !== null && size <= MAX_COPIED_FILE && copied + size <= MAX_COPIED_TOTAL;
    const target = ok ? `files/${side}/${path}` : null;
    if (ok) {
      copied += size;
      files.push({ path: target!, data: text! });
    }
    copiedFiles.set(key, target && `${root}/${target}`);
    return copiedFiles.get(key)!;
  };

  const references = allEvidence(document);
  const counts = evidenceCounts(references);
  const checks = checkCounts(facts.checks);
  const added = facts.files.reduce((n, f) => n + f.additions, 0);
  const removed = facts.files.reduce((n, f) => n + f.deletions, 0);

  const graph = impactGraph(document.impacts);
  const nodeOf = new Map(graph?.nodes.map((node, index) => [node.id, `n${index}`]));
  const firstFinding = (items: ResolvedEvidence[]) => items.find((item) => item.status === "resolved" && item.line !== null);

  type Shown = Exclude<NonNullable<BriefingFacts["screenshots"]>[number], { kind: "recording" }>;
  const screenshots = (facts.screenshots ?? []).filter((shot): shot is Shown => shot.kind !== "recording").map((shot, index) => {
    const write = (which: string, image: { ext: string; bytes: Buffer }) => {
      const path = `images/screenshot-${index + 1}-${which}.${image.ext}`;
      files.push({ path, data: image.bytes });
      return `${root}/${path}`;
    };
    const caption = `${shot.label ? `**${escapeMarkdown(shot.label)}** · ` : ""}from the ${escapeMarkdown(shot.source)}`;
    return shot.kind === "pair"
      ? { label: shot.label, caption, before: write("before", shot.before), after: write("after", shot.after) }
      : { label: shot.label || "Screenshot", caption, before: write("image", shot.image), after: null };
  });
  const visuals = facts.visuals.map((pair, index) => {
    const write = (which: "before" | "after", image: typeof pair.before) => {
      if (!image) return null;
      const path = `images/visual-${index + 1}-${which}.${image.ext}`;
      files.push({ path, data: image.bytes });
      return `${root}/${path}`;
    };
    return {
      label: pair.path,
      caption: `\`${escapeMarkdown(pair.label)}\`${pair.before ? " · removed" : " · new"}`,
      before: write("before", pair.before),
      after: write("after", pair.after),
      identical: pair.identical,
    };
  });

  const data = {
    version: 1,
    meta: {
      heading: `PR #${pr.number} · ${pr.title}`,
      byline: `**${escapeMarkdown(`${pr.owner}/${pr.repo}`)}** · by ${escapeMarkdown(pr.author)} · base \`${pr.baseSha.slice(0, 7)}\` → head \`${pr.headSha.slice(0, 7)}\` · ${escapeMarkdown(options.model)}`,
      url: pr.url,
      headSha: pr.headSha,
    },
    verdict: escapeMarkdown(document.verdict),
    remember: document.boundaries.unchanged[0] ? escapeMarkdown(document.boundaries.unchanged[0]) : null,
    metrics: [
      { label: "Files", value: String(facts.files.length || pr.changedFiles || 0), note: "changed", tone: "neutral" },
      { label: "Lines", value: `+${facts.files.length ? added : (pr.additions ?? 0)} −${facts.files.length ? removed : (pr.deletions ?? 0)}`, note: "added / removed", tone: "neutral" },
      !checks || !checks.total
        ? { label: "CI", value: checks ? "none" : "—", note: checks ? "no check runs" : "unavailable", tone: "neutral" }
        : { label: "CI", value: `${checks.passed}/${checks.total}`, note: checks.failed ? `${checks.failed} failing` : checks.pending ? `${checks.pending} pending` : "passing", tone: checks.failed ? "bad" : checks.pending ? "warn" : "good" },
      { label: "Evidence", value: `${counts.resolved}/${counts.total}`, note: "citations matched", tone: counts.unresolved ? "bad" : counts.total && counts.resolved === counts.total ? "good" : "warn" },
    ],
    summary: document.summary.map((item) => ({
      title: item.claim,
      detail: item.evidence.slice(0, 2).map((e) => `${e.path}${e.line ? `:${e.line}` : ""}`).join(" · "),
      kind: item.kind === "compatibility" ? "compat" : item.kind,
      tone: KIND_TONE[item.kind],
      icon: KIND_ICON[item.kind],
    })),
    areas: { labels: facts.areas.labels, added: facts.areas.added, removed: facts.areas.removed },
    areaCaption: areaCaption(facts.areas),
    findings: [...document.considerations]
      .sort((a, b) => ["risk", "watch", "note"].indexOf(a.level) - ["risk", "watch", "note"].indexOf(b.level))
      .map((item) => {
        const at = firstFinding(item.evidence);
        const file = at ? copy(at.side, at.path) : null;
        return { severity: SEVERITY[item.level], title: item.title, detail: item.check ? `${item.detail} How to check: ${item.check}` : item.detail, ...(file && at ? { file, line: at.line } : {}) };
      }),
    acceptance: { title: "Verified vs. claimed", criteria: facts.acceptance.map((row) => ({ name: row.name, status: row.status, by: row.by, ...(row.note ? { note: row.note } : {}), ...(row.needs ? { needs: row.needs } : {}) })) },
    checks: (facts.checks ?? []).map((check) => Object.fromEntries(Object.entries(check).filter(([, value]) => value !== null))),
    checksNote: !facts.checks ? "Check runs could not be read for this head." : "No CI check runs were reported for this head.",
    behavior: { before: escapeMarkdown(document.behavior.before), after: escapeMarkdown(document.behavior.after) },
    code: facts.examples.length
      ? facts.examples.map((example) => ({ caption: `**What to notice:** ${escapeMarkdown(example.caption)}`, patch: example.patch }))
      : facts.keyHunk
        ? [{ caption: `The model didn't point at specific lines, so this is one changed hunk from \`${escapeMarkdown(facts.keyHunk.path)}\`.`, patch: facts.keyHunk.patch }]
        : [],
    screenshots,
    screenshotsNote:
      facts.screenshots === null
        ? "The PR description and comments could not be read for screenshots."
        : facts.screenshots.some((shot) => shot.kind === "recording")
          ? `This PR has ${facts.screenshots.filter((shot) => shot.kind === "recording").length} screen recording(s) in its conversation; open the pull request to watch them.`
          : facts.screenshots.length
          ? null
          : "No screenshots on this PR. Screenshots attached to the PR description or comments show up here, side by side when labeled Before and After.",
    visuals,
    graph:
      graph && {
        mermaid: [
          "flowchart LR",
          ...graph.nodes.map((node, index) => `  n${index}[${mermaidLabel(node.changed ? `${node.name} · changed` : node.name)}]`),
          ...graph.edges.map((edge) => {
            const relation = document.impacts.find((item, index) => (item.id ?? `impact-${index + 1}`) === edge.to)?.relation;
            const label = relation ? mermaidLabel(relation).slice(1, -1).slice(0, 30) : "";
            return `  ${nodeOf.get(edge.from)} -->${label ? `|${label}|` : ""} ${nodeOf.get(edge.to)}`;
          }),
        ].join("\n"),
        details: Object.fromEntries(
          document.impacts.map((item, index) => [
            `n${graph.nodes.findIndex((node) => node.id === (item.id ?? `impact-${index + 1}`))}`,
            `${item.changed ? "**Changed by this PR.** " : ""}${escapeMarkdown(item.change)}`,
          ]),
        ),
      },
    treemap: facts.files.filter((file) => file.additions + file.deletions > 0).map((file) => ({ path: file.path, size: file.additions + file.deletions })),
    flows: document.flows.map((flow) => ({
      title: flow.title,
      steps: flow.steps.map((step) => ({
        title: step.changed ? `${step.label} · changed by this PR` : step.label,
        detail: step.detail,
        ...(step.changed ? { status: "current" } : {}),
      })),
    })),
    excerpts: facts.excerpts
      .map((excerpt) => ({ excerpt, path: copy(excerpt.side, excerpt.path) }))
      .filter((item): item is { excerpt: (typeof facts.excerpts)[number]; path: string } => !!item.path)
      .map(({ excerpt, path }) => ({
        path,
        from: excerpt.from,
        to: excerpt.to,
        caption: `\`${escapeMarkdown(`${excerpt.path}:${excerpt.focus}`)}\` · ${excerpt.side === "base" ? "before" : "after"} · ${escapeMarkdown(excerpt.note)}`,
      })),
    evidenceNote: `${counts.resolved} of ${counts.total} citations matched their quoted code. Before-evidence links to the base commit, after-evidence to the head.`,
    sources: references.map((item) => ({
      url: item.url,
      title: `${item.path.split("/").pop()}${item.line ? `:${item.line}` : ""} · ${item.side === "base" ? "before" : "after"} · ${item.status === "resolved" ? "matched" : item.status === "unverified" ? "unchecked" : "not found"}`,
      note: item.note,
    })),
    boundaries: Array.from(
      { length: Math.max(document.boundaries.inScope.length, document.boundaries.outOfScope.length, document.boundaries.unchanged.length) },
      (_, index) => [document.boundaries.inScope[index] ?? "", document.boundaries.outOfScope[index] ?? "", document.boundaries.unchanged[index] ?? ""].map(escapeMarkdown),
    ),
    integrity: {
      "Briefed head": pr.headSha.slice(0, 12),
      "Merge base": pr.baseSha.slice(0, 12),
      Generation: options.generationId.slice(0, 8),
      Model: options.model,
    },
  };
  files.push({ path: "briefing.json", data: JSON.stringify(data) });
  files.push({ path: "briefing.ui", data: GENUI_SPEC(root, data.excerpts) });
  return { name, files };
}

/** Writes the bundle as a private directory, replacing any previous copy. */
export function writeGenuiBundle(directory: string, bundle: GenuiBundle) {
  const temporary = `${directory}.${process.pid}.${Date.now()}.tmp`;
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  try {
    for (const file of bundle.files) {
      const target = join(temporary, file.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, file.data, { mode: 0o600 });
    }
    rmSync(directory, { recursive: true, force: true });
    renameSync(temporary, directory);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}
