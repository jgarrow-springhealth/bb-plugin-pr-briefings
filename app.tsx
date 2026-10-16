import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  UrlLink,
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import type { rpcContract } from "./server";
import type { BriefingRecord, PullRequest, Preferences } from "./contract";
import { genuiChatPrompt } from "./genui-chat";
import "./app.css";

type Snapshot = {
  queue: PullRequest[];
  briefings: BriefingRecord[];
  preferences: Preferences;
  pairReviewAvailable: boolean;
  genuiAvailable: boolean;
  refreshing: boolean;
  warning: string | null;
};
type RequestFilter = "all" | "team" | "teammate" | "other-direct";
type StatusFilter = "all" | "missing" | "active" | "ready" | "stale" | "failed";
type QueueSort = "updated-desc" | "updated-asc" | "changes-desc" | "repository";

function briefingStatus(
  pr: PullRequest,
  record?: BriefingRecord,
): Exclude<StatusFilter, "all"> {
  if (!record) return "missing";
  if (record.head && record.head !== pr.headSha) return "stale";
  if (record.state === "queued" || record.state === "generating")
    return "active";
  return record.state === "ready" ? "ready" : "failed";
}

function requestCategory(pr: PullRequest, teammates: Set<string>) {
  if (pr.requestKinds.includes("team")) return "team" as const;
  if (teammates.has(pr.author.toLowerCase())) return "teammate" as const;
  return "other-direct" as const;
}

function repositoryName(pr: PullRequest) {
  return `${pr.owner}/${pr.repo}`;
}

function pairReviewDetailsHref(pr: PullRequest) {
  const coordinate = [pr.host, pr.owner, pr.repo]
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `/plugins/pair-review/reviews/pr/${coordinate}/${pr.number}`;
}

function updatedTime(pr: PullRequest) {
  const value = pr.updatedAt ? Date.parse(pr.updatedAt) : 0;
  return Number.isFinite(value) ? value : 0;
}

function useBriefings() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    rpc.call("snapshot").then(
      (value) => {
        setData(value);
        setError("");
      },
      (cause) => setError(String(cause)),
    );
  }, [rpc]);
  useEffect(() => {
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [load]);
  useRealtime("changed", load);
  return { rpc, data, error, load };
}

function Status({ record }: { record?: BriefingRecord }) {
  if (!record) return <span className="pb-status">Not generated</span>;
  if (record.state === "generating" || record.state === "queued")
    return (
      <span className="pb-status is-running">
        <span className="pb-spinner" aria-hidden="true" />
        {record.state === "queued" ? "Queued" : "Generating"}
      </span>
    );
  if (record.state === "failed")
    return <span className="pb-status is-failed">Failed</span>;
  return <span className="pb-status is-ready">Ready</span>;
}

function ChangeSummary({ pr }: { pr: PullRequest }) {
  if (pr.changedFiles === null) return null;
  return (
    <span className="pb-changes">
      {pr.changedFiles} {pr.changedFiles === 1 ? "file" : "files"}
      {pr.additions !== null && <b className="pb-additions">+{pr.additions}</b>}
      {pr.deletions !== null && <b className="pb-deletions">−{pr.deletions}</b>}
    </span>
  );
}

function BriefingRow({
  pr,
  record,
  busy,
  onGenerate,
  onOpen,
  onChat,
  onPullRequest,
  pairReviewHref,
  requestLabel,
}: {
  pr: PullRequest;
  record?: BriefingRecord;
  busy: boolean;
  requestLabel?: string;
  onGenerate: () => void;
  onOpen: () => void;
  /** Present when the Generative UI plugin can show this briefing in chat. */
  onChat?: () => void;
  onPullRequest: () => void;
  pairReviewHref?: string;
}) {
  const stale = !!record?.head && record.head !== pr.headSha;
  const running = record?.state === "queued" || record?.state === "generating";
  return (
    <article className="pb-row">
      <div className="pb-row-main">
        <div className="pb-row-heading">
          <h3>{pr.title}</h3>
          <Status record={record} />
        </div>
        <p>
          {pr.owner}/{pr.repo} #{pr.number} · {pr.author}
        </p>
        <div className="pb-meta">
          <ChangeSummary pr={pr} />
          {requestLabel && (
            <span className="pb-request-kind">{requestLabel}</span>
          )}
          {pr.draft && <span className="pb-request-kind">Draft</span>}
          {stale && <span className="pb-stale">Briefing is outdated</span>}
          {record?.error && <span className="pb-error">{record.error}</span>}
        </div>
      </div>
      <div className="pb-actions">
        {record?.state === "ready" && !stale && (
          <Button size="sm" onClick={onOpen}>
            <Icon name="FileText" className="size-4" />
            Open briefing
          </Button>
        )}
        {record?.state === "ready" && !stale && onChat && (
          <Button size="sm" variant="outline" onClick={onChat}>
            <Icon name="MessageSquare" className="size-4" />
            Discuss in chat
          </Button>
        )}
        <Button
          size="sm"
          variant={record?.state === "ready" && !stale ? "outline" : "default"}
          disabled={busy || running}
          onClick={onGenerate}
        >
          <Icon name="Sparkles" className="size-4" />
          {running ? "Generating…" : record ? "Regenerate" : "Generate"}
        </Button>
        {pairReviewHref && (
          <Button size="sm" variant="outline" asChild>
            <UrlLink href={pairReviewHref}>
              <Icon name="Search" className="size-4" />
              Pair Review details
            </UrlLink>
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onPullRequest}>
          <Icon name="GitPullRequest" className="size-4" />
          Pull request
        </Button>
      </div>
    </article>
  );
}

function ManualBriefing({
  busy,
  onGenerate,
}: {
  busy: boolean;
  onGenerate: (url: string) => Promise<void>;
}) {
  const [url, setUrl] = useState("");
  return (
    <form
      className="pb-manual"
      onSubmit={(event) => {
        event.preventDefault();
        const value = url.trim();
        if (!value || busy) return;
        void onGenerate(value).then(() => setUrl(""));
      }}
    >
      <div>
        <h2>Brief any pull request</h2>
        <p>Generate a briefing without starting a Pair Review analysis.</p>
      </div>
      <div className="pb-manual-controls">
        <Input
          aria-label="GitHub pull request URL"
          placeholder="https://github.com/owner/repository/pull/123"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <Button disabled={busy || !url.trim()} type="submit">
          <Icon name="Sparkles" className="size-4" />
          Generate briefing
        </Button>
      </div>
    </form>
  );
}

function BriefingsPage(_props: PluginNavPanelProps) {
  const { rpc, data, error, load } = useBriefings();
  const navigate = useBbNavigate();
  const [busyUrl, setBusyUrl] = useState("");
  const [actionError, setActionError] = useState("");
  const [requestFilter, setRequestFilter] = useState<RequestFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [repositoryFilter, setRepositoryFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [queueSort, setQueueSort] = useState<QueueSort>("updated-desc");
  const refreshed = useRef(false);
  useEffect(() => {
    if (refreshed.current) return;
    refreshed.current = true;
    void rpc.call("refresh").catch((cause) => setActionError(String(cause)));
  }, [rpc]);
  const byUrl = useMemo(
    () =>
      new Map((data?.briefings ?? []).map((record) => [record.url, record])),
    [data?.briefings],
  );
  const teammates = useMemo(
    () =>
      new Set(
        (data?.preferences.teammates ?? "")
          .split(/[\s,]+/)
          .filter(Boolean)
          .map((handle) => handle.toLowerCase()),
      ),
    [data?.preferences.teammates],
  );
  const queueUrls = useMemo(
    () => new Set((data?.queue ?? []).map((pr) => pr.url)),
    [data?.queue],
  );
  const manualRecords = (data?.briefings ?? []).filter(
    (record) => !queueUrls.has(record.url),
  );
  const repositories = useMemo(
    () =>
      [...new Set((data?.queue ?? []).map(repositoryName))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [data?.queue],
  );
  const visibleQueue = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = (data?.queue ?? []).filter((pr) => {
      const record = byUrl.get(pr.url);
      return (
        (requestFilter === "all" ||
          requestCategory(pr, teammates) === requestFilter) &&
        (statusFilter === "all" ||
          briefingStatus(pr, record) === statusFilter) &&
        (repositoryFilter === "all" ||
          repositoryName(pr) === repositoryFilter) &&
        (!query ||
          `${pr.title} ${pr.owner}/${pr.repo} ${pr.author} #${pr.number}`
            .toLowerCase()
            .includes(query))
      );
    });
    return filtered.sort((a, b) => {
      if (queueSort === "updated-desc")
        return updatedTime(b) - updatedTime(a) || a.key.localeCompare(b.key);
      if (queueSort === "updated-asc")
        return updatedTime(a) - updatedTime(b) || a.key.localeCompare(b.key);
      if (queueSort === "changes-desc")
        return (
          (b.changedFiles ?? -1) - (a.changedFiles ?? -1) ||
          updatedTime(b) - updatedTime(a)
        );
      return (
        repositoryName(a).localeCompare(repositoryName(b)) ||
        b.number - a.number
      );
    });
  }, [
    byUrl,
    data?.queue,
    queueSort,
    repositoryFilter,
    requestFilter,
    search,
    statusFilter,
    teammates,
  ]);
  const filtersActive =
    requestFilter !== "all" ||
    statusFilter !== "all" ||
    repositoryFilter !== "all" ||
    !!search.trim() ||
    queueSort !== "updated-desc";
  const clearFilters = () => {
    setRequestFilter("all");
    setStatusFilter("all");
    setRepositoryFilter("all");
    setSearch("");
    setQueueSort("updated-desc");
  };
  const generate = async (url: string) => {
    if (busyUrl) return;
    setBusyUrl(url);
    setActionError("");
    try {
      await rpc.call("briefing_generate", { url });
      load();
    } catch (cause) {
      setActionError(String(cause));
      throw cause;
    } finally {
      setBusyUrl("");
    }
  };
  const open = (record: BriefingRecord) => {
    if (!record.file || !record.hostId) return;
    const accepted = navigate.experimental_openFilePreview({
      target: { kind: "host", hostId: record.hostId, path: record.file },
      location: null,
    });
    if (!accepted) setActionError("BB could not open this briefing preview.");
  };
  const chatFor = (record?: BriefingRecord) =>
    data?.genuiAvailable && record?.bundle && record.head
      ? () => {
          try {
            navigate.toCompose({
              initialPrompt: genuiChatPrompt({
                subject: record.subject || record.url,
                head: record.head!,
                bundle: record.bundle!,
              }),
              focusPrompt: true,
            });
          } catch (cause) {
            setActionError(String(cause));
          }
        }
      : undefined;
  return (
    <main className="pb-page">
      <div className="pb-shell">
        <header className="pb-header">
          <div>
            <p className="pb-eyebrow">Review preparation</p>
            <h1>PR Briefings</h1>
            <p>
              Understand behavior, impact, flows, and boundaries before you
              start reviewing code.
            </p>
          </div>
          <Button
            variant="outline"
            disabled={data?.refreshing}
            onClick={() => void rpc.call("refresh").then(load)}
          >
            <Icon
              name="RefreshCw"
              className={data?.refreshing ? "size-4 pb-spin" : "size-4"}
            />
            {data?.refreshing ? "Refreshing…" : "Refresh PRs"}
          </Button>
        </header>

        <ManualBriefing busy={!!busyUrl} onGenerate={generate} />

        {(error || actionError || data?.warning) && (
          <div className="pb-alert" role="alert">
            <Icon name="TriangleAlert" className="size-4" />
            {actionError || error || data?.warning}
          </div>
        )}

        <section className="pb-section">
          <div className="pb-section-heading">
            <div>
              <h2>PRs needing review</h2>
              <p>Direct and team review requests from GitHub.</p>
            </div>
            <span>
              {data && visibleQueue.length !== data.queue.length
                ? `${visibleQueue.length}/${data.queue.length}`
                : (data?.queue.length ?? 0)}
            </span>
          </div>
          {!!data?.queue.length && (
            <div
              className="pb-filters"
              aria-label="Filter and sort pull requests"
            >
              <div className="pb-filter-pills" aria-label="Request type">
                {(
                  [
                    ["all", "All requests"],
                    ["team", "Team requests"],
                    ["teammate", "Teammate requests"],
                    ["other-direct", "Other direct requests"],
                  ] as const
                ).map(([value, title]) => (
                  <Button
                    key={value}
                    size="sm"
                    variant={requestFilter === value ? "default" : "outline"}
                    aria-pressed={requestFilter === value}
                    onClick={() => setRequestFilter(value)}
                  >
                    {title}
                    <span className="pb-filter-count">
                      {value === "all"
                        ? data.queue.length
                        : data.queue.filter(
                            (pr) => requestCategory(pr, teammates) === value,
                          ).length}
                    </span>
                  </Button>
                ))}
              </div>
              <div className="pb-filter-tools">
                <label>
                  Repository
                  <select
                    aria-label="Filter by repository"
                    value={repositoryFilter}
                    onChange={(event) =>
                      setRepositoryFilter(event.target.value)
                    }
                  >
                    <option value="all">All repositories</option>
                    {repositories.map((repository) => (
                      <option key={repository} value={repository}>
                        {repository}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Briefing
                  <select
                    aria-label="Filter by briefing status"
                    value={statusFilter}
                    onChange={(event) =>
                      setStatusFilter(event.target.value as StatusFilter)
                    }
                  >
                    <option value="all">All statuses</option>
                    <option value="missing">Not generated</option>
                    <option value="active">In progress</option>
                    <option value="ready">Ready</option>
                    <option value="stale">Outdated</option>
                    <option value="failed">Failed</option>
                  </select>
                </label>
                <Input
                  aria-label="Search pull requests"
                  placeholder="Search PRs"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <label>
                  Sort
                  <select
                    aria-label="Sort pull requests"
                    value={queueSort}
                    onChange={(event) =>
                      setQueueSort(event.target.value as QueueSort)
                    }
                  >
                    <option value="updated-desc">Recently updated</option>
                    <option value="updated-asc">Oldest updated</option>
                    <option value="changes-desc">Most changed files</option>
                    <option value="repository">Repository A–Z</option>
                  </select>
                </label>
                {filtersActive && (
                  <Button size="sm" variant="ghost" onClick={clearFilters}>
                    Clear filters
                  </Button>
                )}
              </div>
            </div>
          )}
          {!data ? (
            <div className="pb-empty">Loading pull requests…</div>
          ) : !data.queue.length ? (
            <div className="pb-empty">
              {data.refreshing
                ? "Looking for review requests…"
                : "No open review requests found."}
            </div>
          ) : !visibleQueue.length ? (
            <div className="pb-empty">
              No pull requests match the current filters.
              <Button size="sm" variant="outline" onClick={clearFilters}>
                Clear filters
              </Button>
            </div>
          ) : (
            <div className="pb-list">
              {visibleQueue.map((pr) => {
                const record = byUrl.get(pr.url);
                return (
                  <BriefingRow
                    key={pr.key}
                    pr={pr}
                    record={record}
                    busy={busyUrl === pr.url}
                    onGenerate={() => void generate(pr.url)}
                    onOpen={() => record && open(record)}
                    onChat={chatFor(record)}
                    onPullRequest={() => navigate.openUrl(pr.url)}
                    pairReviewHref={
                      data.pairReviewAvailable
                        ? pairReviewDetailsHref(pr)
                        : undefined
                    }
                    requestLabel={
                      requestCategory(pr, teammates) === "team"
                        ? "Team request"
                        : requestCategory(pr, teammates) === "teammate"
                          ? "Teammate request"
                          : "Other direct request"
                    }
                  />
                );
              })}
            </div>
          )}
        </section>

        {!!manualRecords.length && (
          <section className="pb-section">
            <div className="pb-section-heading">
              <div>
                <h2>Other briefings</h2>
                <p>Briefings generated directly or from another plugin.</p>
              </div>
              <span>{manualRecords.length}</span>
            </div>
            <div className="pb-list">
              {manualRecords.map((record) => {
                const coordinate = new URL(record.url).pathname.match(
                  /^\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)/,
                );
                const pr: PullRequest = {
                  key: record.url,
                  url: record.url,
                  host: new URL(record.url).hostname,
                  owner: coordinate?.[1] ?? "unknown",
                  repo: coordinate?.[2] ?? "repository",
                  number: Number(coordinate?.[3] ?? 1),
                  title: record.title || record.url,
                  author: record.author || "unknown",
                  baseBranch: "unknown",
                  baseSha: "0".repeat(40),
                  headBranch: "unknown",
                  headSha: record.head ?? "0".repeat(40),
                  updatedAt: null,
                  draft: false,
                  requestKinds: [],
                  changedFiles: null,
                  additions: null,
                  deletions: null,
                };
                return (
                  <BriefingRow
                    key={record.url}
                    pr={pr}
                    record={record}
                    busy={busyUrl === record.url}
                    onGenerate={() => void generate(record.url)}
                    onOpen={() => open(record)}
                    onChat={chatFor(record)}
                    onPullRequest={() => navigate.openUrl(record.url)}
                    pairReviewHref={
                      data?.pairReviewAvailable
                        ? pairReviewDetailsHref(pr)
                        : undefined
                    }
                  />
                );
              })}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

function SidebarAccessory() {
  const { data } = useBriefings();
  const active = data?.briefings.filter(
    (record) => record.state === "queued" || record.state === "generating",
  ).length;
  return active ? <span className="pb-accessory">{active}</span> : null;
}

function ConfigurationHelp() {
  const rpc = useRpc<typeof rpcContract>();
  const [resetting, setResetting] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <div className="pb-settings-notes">
      <p>
        BB saves valid changes above. GitHub discovery uses the hostname and
        teams on the next refresh; model and reasoning changes apply to the
        next queued briefing. Teammate handles only change request labels.
      </p>
      <p>
        Authenticate GitHub with <code>gh</code> and authenticate the selected
        Pi, Claude Code, or Codex provider on the enrolled BB server machine. PR
        Briefings does not store GitHub or model secrets.
      </p>
      <div>
        <Button
          variant="outline"
          disabled={resetting}
          onClick={async () => {
            if (!window.confirm("Reset every PR Briefings setting to its default?"))
              return;
            setResetting(true);
            setMessage("");
            try {
              await rpc.call("reset_settings");
              setMessage(
                "Defaults restored. Reopen PR Briefings settings if the fields above have not refreshed.",
              );
            } catch (cause) {
              setMessage(`Reset failed: ${String(cause)}`);
            } finally {
              setResetting(false);
            }
          }}
        >
          Reset all to defaults
        </Button>
      </div>
      {message && <p role="status">{message}</p>}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "configuration-help",
    title: "Configuration notes",
    description: "When settings apply and where credentials remain.",
    component: ConfigurationHelp,
  });
  app.experimental_sidebarFooter.register({
    kind: "action",
    id: "settings",
    label: "PR Briefings settings",
    icon: "Settings2",
    onActivate: ({ openPluginDetails }) => openPluginDetails(),
  });
  app.slots.navPanel({
    id: "briefings",
    title: "PR Briefings",
    icon: "FileText",
    path: "briefings",
    component: BriefingsPage,
    experimental_sidebarAccessory: SidebarAccessory,
  });
});
