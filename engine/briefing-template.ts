import { z } from "zod";

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
    /** Exact text from the cited line, used to verify and re-anchor the citation. */
    quote: Copy(200).optional(),
    note: Copy(300),
  });
export type EvidenceItem = z.infer<typeof Evidence>;
const EvidenceList = z.array(Evidence).max(8);
const ImpactId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const Impact = z
  .object({
    /** Short slug other impacts can reference in `dependsOn`. */
    id: ImpactId.optional(),
    /** Impacts this one is reached through or depends on; draws the impact graph. */
    dependsOn: z.array(ImpactId).max(12).optional(),
    /** Short label for how this impact uses the ones in dependsOn (edge label). */
    relation: Copy(60).optional(),
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
  });
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
          }),
      )
      .min(2)
      .max(8)
      .refine((steps) => steps.filter((step) => step.changed).length <= 1, {
        message: "A flow can mark at most one changed step",
      }),
  });
export const BriefingDocument = z
  .object({
    verdict: Copy(320),
    summary: z
      .array(
        z
          .object({
            kind: z.enum(["behavior", "surface", "scope", "compatibility"]),
            claim: Copy(500),
            // A claim about absence ("no API changes") may have nothing to cite.
            evidence: EvidenceList.max(4),
          }),
      )
      .min(1)
      .max(6),
    behavior: z
      .object({
        before: Copy(1200),
        // Either side may be empty: a PR that only adds files has no "before"
        // code to cite (and one that only deletes has no "after"). The
        // comparison as a whole must still cite something.
        beforeEvidence: EvidenceList.max(4),
        after: Copy(1200),
        afterEvidence: EvidenceList.max(4),
        /** Hunks that best show the change, located in the diff by an exact line. */
        examples: z
          .array(
            z
              .object({
                path: RepositoryPath,
                quote: Copy(200),
                caption: Copy(240),
              }),
          )
          .max(3)
          .optional(),
      })
      .refine(
        (behavior) => behavior.beforeEvidence.length + behavior.afterEvidence.length > 0,
        { message: "The behavior comparison must cite evidence for before or after", path: ["afterEvidence"] },
      ),
    impacts: z
      .array(Impact)
      .max(12)
      .refine((items) => items.filter((item) => item.changed).length <= 1, {
        message: "An impact map can mark at most one changed item",
      }),
    flows: z.array(Flow).max(3),
    boundaries: z
      .object({
        inScope: z.array(Copy(400)).max(10),
        outOfScope: z.array(Copy(400)).max(10),
        unchanged: z.array(Copy(400)).max(10),
      }),
    considerations: z
      .array(
        z
          .object({
            level: z.enum(["note", "watch", "risk"]),
            title: Copy(140),
            detail: Copy(700),
            /** What a reviewer can do to confirm or rule this out. */
            check: Copy(300).optional(),
            evidence: EvidenceList,
          }),
      )
      .max(8),
  });
export type BriefingDocument = z.infer<typeof BriefingDocument>;

// ── Normalizing model output ────────────────────────────────────────────────
// The model's output is validated strictly for safety (paths, control
// characters, types) but leniently for presentation: ordinary variation that a
// legitimate PR or model can produce is normalized here instead of failing the
// whole briefing. See tests/pr-shapes.test.ts for the cases this covers.

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const truncate = (value: unknown, max: number) =>
  typeof value === "string" && value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
const SUMMARY_KINDS = ["behavior", "surface", "scope", "compatibility"] as const;
const IMPACT_KINDS = ["product surface", "service", "package", "data", "team", "operations"] as const;
const LEVELS = ["note", "watch", "risk"] as const;

function summaryKind(value: unknown) {
  const text = String(value ?? "").toLowerCase();
  if ((SUMMARY_KINDS as readonly string[]).includes(text)) return text;
  if (/compat/.test(text)) return "compatibility";
  if (/scope|boundar/.test(text)) return "scope";
  if (/surface|ui|ux|api|screen|page/.test(text)) return "surface";
  return "behavior";
}
function impactKind(value: unknown) {
  const text = String(value ?? "").toLowerCase();
  if ((IMPACT_KINDS as readonly string[]).includes(text)) return text;
  if (/data|database|schema|db|storage|migration|table/.test(text)) return "data";
  if (/service|api|backend|server|endpoint|worker|job/.test(text)) return "service";
  if (/package|library|lib|module|dependency|sdk|component/.test(text)) return "package";
  if (/team|people|owner|docs|documentation/.test(text)) return "team";
  if (/ops|operation|infra|deploy|ci|build|test|monitor/.test(text)) return "operations";
  return "product surface";
}
function level(value: unknown) {
  const text = String(value ?? "").toLowerCase();
  if ((LEVELS as readonly string[]).includes(text)) return text;
  if (/high|critical|major|severe|blocker|danger/.test(text)) return "risk";
  if (/low|minor|info|trivial|nit/.test(text)) return "note";
  return "watch";
}
export function slugId(value: unknown) {
  const slug = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || undefined;
}
function line(value: unknown) {
  const number = typeof value === "string" ? Number.parseInt(value, 10) : value;
  return typeof number === "number" && Number.isInteger(number) && number > 0 && number <= 10_000_000 ? number : undefined;
}
function optionalText(record: Json, key: string, max: number) {
  if (typeof record[key] === "string" && (record[key] as string).trim()) record[key] = truncate(record[key], max);
  else delete record[key];
}
function evidenceItems(items: unknown) {
  if (!Array.isArray(items)) return items;
  return items.map((item) => {
    if (!isRecord(item)) return item;
    const record = { ...item };
    const at = line(record.line);
    if (at === undefined) delete record.line;
    else record.line = at;
    optionalText(record, "quote", 200);
    record.note = typeof record.note === "string" && record.note.trim() ? truncate(record.note, 300) : "Cited by the briefing";
    return record;
  });
}
/** Trims a list to `max`, validating evidence in the discarded entries first. */
function capped(items: unknown[], max: number, evidenceKey?: string): unknown[] {
  if (evidenceKey)
    for (const dropped of items.slice(max))
      if (isRecord(dropped) && Array.isArray(dropped[evidenceKey])) z.array(Evidence).parse(evidenceItems(dropped[evidenceKey]));
  return items.slice(0, max);
}
const textList = (items: unknown, max: number, length: number) =>
  Array.isArray(items) ? items.filter((item) => typeof item === "string" && item.trim()).slice(0, max).map((item) => truncate(item, length)) : items;

export function normalizeModelOutput(value: unknown) {
  if (!isRecord(value)) return value;
  const document: Json = { ...value, verdict: truncate(value.verdict, 320) };
  if (Array.isArray(value.summary))
    document.summary = capped(value.summary, 6, "evidence").map((item) =>
      isRecord(item) ? { ...item, kind: summaryKind(item.kind), claim: truncate(item.claim, 500), evidence: evidenceItems(item.evidence ?? []) } : item,
    );
  if (isRecord(value.behavior)) {
    const behavior: Json = {
      ...value.behavior,
      before: truncate(value.behavior.before, 1200),
      after: truncate(value.behavior.after, 1200),
      beforeEvidence: evidenceItems(value.behavior.beforeEvidence ?? []),
      afterEvidence: evidenceItems(value.behavior.afterEvidence ?? []),
    };
    if (Array.isArray(value.behavior.examples))
      behavior.examples = value.behavior.examples
        .filter((example) => isRecord(example) && typeof example.path === "string" && typeof example.quote === "string" && example.quote.trim() && typeof example.caption === "string" && example.caption.trim())
        .slice(0, 3)
        .map((example) => ({ ...(example as Json), quote: truncate((example as Json).quote, 200), caption: truncate((example as Json).caption, 240) }));
    else delete behavior.examples;
    document.behavior = behavior;
  }
  if (Array.isArray(value.impacts))
    document.impacts = capped(value.impacts, 12, "evidence").map((item) => {
      if (!isRecord(item)) return item;
      const record: Json = { ...item, kind: impactKind(item.kind), name: truncate(item.name, 120), evidence: evidenceItems(item.evidence ?? []) };
      const id = slugId(item.id);
      if (id) record.id = id;
      else delete record.id;
      if (Array.isArray(item.dependsOn)) {
        const deps = [...new Set(item.dependsOn.map(slugId).filter((dep): dep is string => !!dep && dep !== id))].slice(0, 12);
        record.dependsOn = deps;
      } else delete record.dependsOn;
      optionalText(record, "relation", 60);
      if (typeof record.change === "string") record.change = truncate(record.change, 360);
      return record;
    });
  if (Array.isArray(value.flows))
    document.flows = value.flows
      .filter((flow) => isRecord(flow) && Array.isArray(flow.steps) && flow.steps.length >= 2)
      .slice(0, 3)
      .map((flow) => {
        const record = flow as Json;
        return {
          ...record,
          title: truncate(record.title, 160),
          steps: (record.steps as unknown[]).slice(0, 8).map((step) =>
            isRecord(step) ? { ...step, label: truncate(step.label, 100), detail: truncate(step.detail, 260), changed: step.changed === true } : step,
          ),
        };
      });
  if (isRecord(value.boundaries))
    document.boundaries = {
      ...value.boundaries,
      inScope: textList(value.boundaries.inScope ?? [], 10, 400),
      outOfScope: textList(value.boundaries.outOfScope ?? [], 10, 400),
      unchanged: textList(value.boundaries.unchanged ?? [], 10, 400),
    };
  if (Array.isArray(value.considerations))
    document.considerations = capped(value.considerations, 8, "evidence").map((item) => {
      if (!isRecord(item)) return item;
      const record: Json = { ...item, level: level(item.level), title: truncate(item.title, 140), detail: truncate(item.detail, 700), evidence: evidenceItems(item.evidence ?? []) };
      optionalText(record, "check", 300);
      return record;
    });
  return document;
}

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
    impacts: singleChanged(normalizeEight(completeImpacts(document.impacts))),
    flows: Array.isArray(document.flows)
      ? document.flows.map((flow) =>
          flow && typeof flow === "object" && !Array.isArray(flow)
            ? {
                ...(flow as Record<string, unknown>),
                steps: singleChanged((flow as Record<string, unknown>).steps),
              }
            : flow,
        )
      : document.flows,
    considerations: normalizeEight(document.considerations),
  };
}

/**
 * Models sometimes leave "changed"/"change" off impacts they don't consider the
 * change itself, or name the description differently. Fill those in instead of
 * failing the whole briefing; anything else still has to validate.
 */
function completeImpacts(items: unknown) {
  if (!Array.isArray(items)) return items;
  return items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const record = { ...(item as Record<string, unknown>) };
    if (record.changed === undefined) record.changed = false;
    if (record.change === undefined) {
      const alternate = ["description", "detail", "summary", "effect", "impact"].find((key) => typeof record[key] === "string" && (record[key] as string).trim());
      if (alternate) record.change = record[alternate];
      else if (typeof record.relation === "string" && record.relation.trim()) record.change = record.relation;
    }
    for (const key of ["description", "detail", "summary", "effect", "impact"]) delete record[key];
    return record;
  });
}

/**
 * Presentation rule: an impact map (or a flow) highlights one changed item.
 * Models sometimes mark several; keep the first instead of failing the briefing.
 */
function singleChanged(items: unknown) {
  if (!Array.isArray(items)) return items;
  let seen = false;
  return items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    if (record.changed !== true) return item;
    if (!seen) {
      seen = true;
      return item;
    }
    return { ...record, changed: false };
  });
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
  return BriefingDocument.parse(normalizeEvidenceCardinality(normalizeModelOutput(value)));
}

export { renderBriefingHtml } from "./briefing-render.ts";
