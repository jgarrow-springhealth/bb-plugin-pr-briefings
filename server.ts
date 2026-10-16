import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  BriefingStatus,
  DEFAULT_PREFERENCES,
  Preferences,
  PullRequest,
  PullRequestUrl,
  hostContract,
  parseReviewTeams,
  rpcContract,
  type BriefingRecord,
} from "./contract.ts";
import { parsePullRequestUrl } from "./pull-request-url.ts";
export { rpcContract } from "./contract.ts";

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    hostname: {
      type: "string",
      label: "GitHub hostname",
      description:
        "Lowercase hostname used for GitHub CLI reads, cloning, and accepted PR URLs, without https://.",
      experimental_schema: Preferences.shape.hostname,
      default: DEFAULT_PREFERENCES.hostname,
    },
    provider: {
      type: "select",
      label: "Briefing provider",
      description:
        "Agent used to generate briefings: Pi SDK, Claude Code CLI, or Codex CLI. The selected provider must be installed and authenticated on the BB server machine.",
      options: ["pi", "claude", "codex"],
      experimental_schema: Preferences.shape.provider,
      default: DEFAULT_PREFERENCES.provider,
    },
    model: {
      type: "string",
      label: "Briefing model",
      description:
        "Model identifier understood by the selected provider, such as openai/gpt-5 for Pi, opus for Claude, or a Codex model ID.",
      experimental_schema: Preferences.shape.model,
      default: DEFAULT_PREFERENCES.model,
    },
    thinking: {
      type: "select",
      label: "Briefing reasoning",
      description: "Reasoning level requested from the selected provider.",
      options: ["off", "minimal", "low", "medium", "high", "xhigh"],
      experimental_schema: Preferences.shape.thinking,
      default: DEFAULT_PREFERENCES.thinking,
    },
    teams: {
      type: "string",
      label: "Review teams",
      description:
        "Comma-separated OWNER/TEAM values included in team-review-request discovery (maximum 20).",
      experimental_schema: Preferences.shape.teams,
      default: DEFAULT_PREFERENCES.teams,
    },
    teammates: {
      type: "string",
      label: "Teammate GitHub handles",
      description:
        "Comma-separated handles used only to classify direct requests as Teammate or Other (maximum 100).",
      experimental_schema: Preferences.shape.teammates,
      default: DEFAULT_PREFERENCES.teammates,
    },
  });
  settings.onChange(() => bb.realtime.publish("changed", {}));
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE briefings (url TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '', head TEXT, state TEXT NOT NULL, file TEXT, hostId TEXT, error TEXT, updatedAt INTEGER NOT NULL)`,
    `CREATE TABLE cache (key TEXT PRIMARY KEY, data TEXT NOT NULL)`,
    `ALTER TABLE briefings ADD COLUMN bundle TEXT`,
  ]);
  db.prepare(
    "UPDATE briefings SET state='queued' WHERE state='generating'",
  ).run();

  const host = bb.hosts.experimental_client({ contract: hostContract });
  let refreshing = false;
  let warning: string | null = null;
  let pluginCache = { pairReview: false, genui: false, checkedAt: 0 };
  const changed = () => bb.realtime.publish("changed", {});
  const preferences = async () => Preferences.parse(await settings.get());
  /** Optional companion plugins: Pair Review links and Generative UI chat views. */
  const companions = async () => {
    const now = Date.now();
    if (now - pluginCache.checkedAt < 15_000) return pluginCache;
    let pairReview = false;
    let genui = false;
    try {
      const { plugins } = await bb.sdk.plugins.list();
      const enabledApp = (id: string) =>
        plugins.some(
          (candidate) =>
            candidate.id === id && candidate.enabled && candidate.app.hasApp,
        );
      pairReview = enabledApp("pair-review");
      genui = enabledApp("genui");
    } catch {
      // Keep PR Briefings independent when plugin discovery is unavailable.
    }
    pluginCache = { pairReview, genui, checkedAt: now };
    return pluginCache;
  };
  const primaryHost = async () => {
    const hostId = (await bb.sdk.system.config()).primaryHostId;
    if (!hostId)
      throw Error("Enroll the BB server machine to use PR Briefings");
    return hostId;
  };
  const cachedQueue = () => {
    const row = db.prepare("SELECT data FROM cache WHERE key='queue'").get() as
      { data: string } | undefined;
    if (!row) return [];
    try {
      return z.array(PullRequest).max(500).parse(JSON.parse(row.data));
    } catch {
      return [];
    }
  };
  const records = () =>
    db
      .prepare(
        "SELECT url,title,subject,author,head,state,file,bundle,hostId,error,updatedAt FROM briefings ORDER BY updatedAt DESC LIMIT 500",
      )
      .all() as BriefingRecord[];
  const statusFor = (url: string, requestedHead?: string) => {
    const record = db
      .prepare("SELECT * FROM briefings WHERE url=?")
      .get(url) as BriefingRecord | undefined;
    return BriefingStatus.parse(
      record
        ? {
            available: true,
            state: record.state,
            head: record.head,
            file: record.state === "ready" ? record.file : null,
            hostId: record.state === "ready" ? record.hostId : null,
            stale:
              !!requestedHead && !!record.head && requestedHead !== record.head,
            error: record.error,
            updatedAt: record.updatedAt,
          }
        : {
            available: true,
            state: "missing",
            head: null,
            file: null,
            hostId: null,
            stale: false,
            error: null,
            updatedAt: null,
          },
    );
  };
  const enqueue = async (inputUrl: string) => {
    const url = PullRequestUrl.parse(inputUrl);
    const { hostname } = await preferences();
    parsePullRequestUrl(url, hostname);
    const now = Date.now();
    db.prepare(
      `INSERT INTO briefings (url,state,updatedAt) VALUES (?, 'queued', ?)
       ON CONFLICT(url) DO UPDATE SET state='queued', error=NULL, updatedAt=excluded.updatedAt`,
    ).run(url, now);
    changed();
    return statusFor(url);
  };
  const refreshQueue = async () => {
    if (refreshing) return;
    refreshing = true;
    warning = null;
    changed();
    try {
      const prefs = await preferences();
      const hostId = await primaryHost();
      const { prs } = await host.call(
        "discover",
        { hostname: prefs.hostname, teams: parseReviewTeams(prefs.teams) },
        { hostId, timeoutMs: 10 * 60_000 },
      );
      db.prepare(
        "INSERT INTO cache (key,data) VALUES ('queue',?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      ).run(JSON.stringify(prs));
    } catch (error) {
      warning = String(error);
      bb.log.warn(`PR discovery failed: ${warning}`);
    } finally {
      refreshing = false;
      changed();
    }
  };

  bb.background.service("generator", {
    async start(signal) {
      while (!signal.aborted) {
        const job = db
          .prepare(
            "SELECT url FROM briefings WHERE state='queued' ORDER BY updatedAt LIMIT 1",
          )
          .get() as { url: string } | undefined;
        if (!job) {
          await sleep(750, signal);
          continue;
        }
        db.prepare(
          "UPDATE briefings SET state='generating', error=NULL, updatedAt=? WHERE url=?",
        ).run(Date.now(), job.url);
        changed();
        try {
          const prefs = await preferences();
          const hostId = await primaryHost();
          const result = await host.call(
            "generate",
            {
              url: job.url,
              hostname: prefs.hostname,
              provider: prefs.provider,
              model: prefs.model,
              thinking: prefs.thinking,
            },
            { hostId, timeoutMs: 95 * 60_000, signal },
          );
          const pr = result.pr;
          db.prepare(
            `UPDATE briefings SET title=?,subject=?,author=?,head=?,state='ready',file=?,bundle=?,hostId=?,error=NULL,updatedAt=? WHERE url=?`,
          ).run(
            pr.title,
            `${pr.owner}/${pr.repo} #${pr.number}`,
            pr.author,
            pr.headSha,
            result.file,
            result.bundle,
            hostId,
            result.generatedAt,
            job.url,
          );
        } catch (error) {
          if (signal.aborted) {
            db.prepare(
              "UPDATE briefings SET state='queued', updatedAt=? WHERE url=?",
            ).run(Date.now(), job.url);
          } else {
            db.prepare(
              "UPDATE briefings SET state='failed', error=?, updatedAt=? WHERE url=?",
            ).run(String(error), Date.now(), job.url);
            bb.log.error(`Briefing generation failed: ${String(error)}`);
          }
        }
        changed();
      }
    },
  });

  bb.rpc.register(rpcContract, {
    snapshot: async () => ({
      queue: cachedQueue(),
      briefings: records(),
      preferences: await preferences(),
      pairReviewAvailable: (await companions()).pairReview,
      genuiAvailable: (await companions()).genui,
      refreshing,
      warning,
    }),
    refresh: async () => {
      void refreshQueue();
      return { accepted: true as const };
    },
    briefing_get: ({ url, head }) => statusFor(url, head),
    briefing_generate: ({ url }) => enqueue(url),
    reset_settings: async () =>
      Preferences.parse(
        await settings.experimental_set({
          hostname: null,
          provider: null,
          model: null,
          thinking: null,
          teams: null,
          teammates: null,
        }),
      ),
  });

  bb.cli.register({
    name: "pr-briefings",
    summary: "Generate and inspect pull-request briefings",
    commands: [
      {
        name: "generate",
        summary: "Queue a PR briefing",
        usage: "bb pr-briefings generate <pull-request-url>",
      },
      {
        name: "status",
        summary: "List briefing status",
        usage: "bb pr-briefings status",
      },
    ],
    run: async (argv) => {
      if (argv[0] === "generate" && argv[1] && argv.length === 2) {
        try {
          return {
            exitCode: 0,
            stdout: JSON.stringify(await enqueue(argv[1])),
          };
        } catch (error) {
          return {
            exitCode: 1,
            stderr: error instanceof Error ? error.message : String(error),
          };
        }
      }
      if ((!argv.length || argv[0] === "status") && argv.length <= 1) {
        return { exitCode: 0, stdout: JSON.stringify(records()) };
      }
      return {
        exitCode: 1,
        stderr: "Usage: bb pr-briefings <generate URL|status>",
      };
    },
  });
}
