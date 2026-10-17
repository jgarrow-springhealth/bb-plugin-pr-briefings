// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const url = "https://github.com/example/project/pull/12";
const pr = {
  key: "github.com/example/project#12",
  url,
  host: "github.com",
  owner: "example",
  repo: "project",
  number: 12,
  title: "Explain the behavior change",
  author: "dev",
  baseBranch: "main",
  baseSha: "a".repeat(40),
  headBranch: "feature",
  headSha: "b".repeat(40),
  updatedAt: "2026-10-09T12:00:00Z",
  draft: false,
  requestKinds: ["direct" as const],
  changedFiles: 3,
  additions: 21,
  deletions: 8,
};
const teamPr = {
  ...pr,
  key: "github.com/another/service#7",
  url: "https://github.com/another/service/pull/7",
  owner: "another",
  repo: "service",
  number: 7,
  title: "Team-owned service migration",
  updatedAt: "2026-10-08T12:00:00Z",
  requestKinds: ["team" as const],
  changedFiles: 12,
};
const record = {
  url,
  title: pr.title,
  subject: "example/project #12",
  author: "dev",
  head: pr.headSha,
  state: "ready" as const,
  file: "/Users/example/.pr-briefings/briefs/report.html",
  hostId: "host-1",
  error: null,
  updatedAt: 42,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("registers discoverable native settings with a reset path", async () => {
  const app = await loadPluginApp(() => import("../app"));
  expect(app.settingsSections[0]).toMatchObject({
    id: "configuration-help",
    title: "Configuration notes",
  });
  expect(app.experimentalSidebarFooterItems[0]).toMatchObject({
    kind: "action",
    id: "settings",
    label: "PR Briefings settings",
  });

  const reset = vi.fn(() => ({
    hostname: "github.com",
    model: "openai/gpt-5",
    thinking: "medium",
    teams: "",
    teammates: "",
  }));
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const view = renderSlot(app.settingsSections[0]!, {}, {
    rpc: { reset_settings: reset },
  });

  fireEvent.click(view.getByRole("button", { name: "Reset all to defaults" }));
  await waitFor(() => expect(reset).toHaveBeenCalledWith(null));
  expect((await view.findByRole("status")).textContent).toContain(
    "Defaults restored",
  );
  view.lifecycle.unmount();
});

test("registers a dedicated page that works without Pair Review", async () => {
  const app = await loadPluginApp(() => import("../app"));
  expect(app.navPanels[0]).toMatchObject({
    id: "briefings",
    title: "PR Briefings",
    path: "briefings",
  });
  const generate = vi.fn(() => ({
    available: true,
    state: "queued",
    head: null,
    file: null,
    hostId: null,
    stale: false,
    error: null,
    updatedAt: 43,
  }));
  const view = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        snapshot: () => ({
          queue: [pr, teamPr],
          briefings: [record],
          preferences: {
            hostname: "github.com",
            model: "openai/gpt-5",
            thinking: "medium",
            teams: "",
            teammates: "dev",
          },
          pairReviewAvailable: false,
          refreshing: false,
          warning: null,
        }),
        refresh: () => ({ accepted: true }),
        briefing_generate: generate,
      },
      openFilePreview: () => true,
    },
  );

  expect(await view.findByText("Explain the behavior change")).toBeTruthy();
  expect(
    view.queryByRole("link", { name: "Pair Review details" }),
  ).toBeNull();
  expect(
    view.getByRole("heading", { name: "PRs needing review" }),
  ).toBeTruthy();
  expect(
    view
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent),
  ).toEqual(["Explain the behavior change", "Team-owned service migration"]);

  fireEvent.click(view.getByRole("button", { name: /Team requests/ }));
  expect(view.queryByText("Explain the behavior change")).toBeNull();
  expect(view.getByText("Team-owned service migration")).toBeTruthy();

  fireEvent.click(view.getByRole("button", { name: /All requests/ }));
  fireEvent.click(view.getByRole("button", { name: /Teammate requests/ }));
  expect(view.getByText("Explain the behavior change")).toBeTruthy();
  expect(view.queryByText("Team-owned service migration")).toBeNull();

  fireEvent.click(view.getByRole("button", { name: /All requests/ }));
  fireEvent.change(view.getByLabelText("Filter by briefing status"), {
    target: { value: "ready" },
  });
  expect(view.getByText("Explain the behavior change")).toBeTruthy();
  expect(view.queryByText("Team-owned service migration")).toBeNull();

  fireEvent.click(view.getByRole("button", { name: "Clear filters" }));
  fireEvent.change(view.getByLabelText("Sort pull requests"), {
    target: { value: "changes-desc" },
  });
  expect(
    view
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent),
  ).toEqual(["Team-owned service migration", "Explain the behavior change"]);

  fireEvent.change(view.getByLabelText("Search pull requests"), {
    target: { value: "behavior" },
  });
  expect(view.getByText("Explain the behavior change")).toBeTruthy();
  expect(view.queryByText("Team-owned service migration")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Clear filters" }));

  fireEvent.click(view.getByRole("button", { name: "Open briefing" }));
  expect(view.inspection.navigateCalls).toContainEqual(
    expect.objectContaining({ method: "toPluginPanel" }),
  );
  const { viewerSubPath, viewerUrl } = await import("../app");
  expect(JSON.stringify(view.inspection.navigateCalls)).toContain(viewerSubPath(url));

  fireEvent.change(view.getByLabelText("GitHub pull request URL"), {
    target: { value: "https://github.com/example/other/pull/9" },
  });
  fireEvent.click(view.getByRole("button", { name: "Generate briefing" }));
  await waitFor(() =>
    expect(generate).toHaveBeenCalledWith({
      url: "https://github.com/example/other/pull/9",
    }),
  );
  view.lifecycle.unmount();
});

test("links each PR to Pair Review details when its page is available", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const view = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        snapshot: () => ({
          queue: [pr],
          briefings: [record],
          preferences: {
            hostname: "github.com",
            model: "openai/gpt-5",
            thinking: "medium",
            teams: "",
            teammates: "",
          },
          pairReviewAvailable: true,
          refreshing: false,
          warning: null,
        }),
        refresh: () => ({ accepted: true }),
        briefing_generate: () => ({
          available: true,
          state: "queued",
          head: null,
          file: null,
          hostId: null,
          stale: false,
          error: null,
          updatedAt: 43,
        }),
      },
    },
  );

  const link = await view.findByRole("link", {
    name: "Pair Review details",
  });
  expect(link.getAttribute("href")).toBe(
    "/plugins/pair-review/reviews/pr/github.com/example/project/12",
  );
  view.lifecycle.unmount();
});

test("offers a Generative UI chat view for ready briefings with a bundle", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const bundle = `/Users/example/.pr-briefings/briefs/${"c".repeat(24)}/${pr.headSha}.genui`;
  const snapshot = (genuiAvailable: boolean) => ({
    queue: [pr],
    briefings: [{ ...record, bundle }],
    preferences: {
      hostname: "github.com",
      model: "openai/gpt-5",
      thinking: "medium",
      teams: "",
      teammates: "",
    },
    pairReviewAvailable: false,
    genuiAvailable,
    refreshing: false,
    warning: null,
  });
  const hidden = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: { snapshot: () => snapshot(false), refresh: () => ({ accepted: true }) },
  });
  expect(await hidden.findByText("Explain the behavior change")).toBeTruthy();
  expect(hidden.queryByRole("button", { name: "Discuss in chat" })).toBeNull();
  hidden.lifecycle.unmount();

  const view = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: { snapshot: () => snapshot(true), refresh: () => ({ accepted: true }) },
  });
  fireEvent.click(await view.findByRole("button", { name: "Discuss in chat" }));
  const call = view.inspection.navigateCalls.find(
    (entry: { method: string }) => entry.method === "toCompose",
  ) as { options: { initialPrompt: string; focusPrompt: boolean } } | undefined;
  expect(call?.options.focusPrompt).toBe(true);
  expect(call?.options.initialPrompt).toContain(
    `cp -R '${bundle}/.' "$BB_THREAD_STORAGE/pr-briefings/${"c".repeat(24)}-${"b".repeat(12)}"/`,
  );
  expect(call?.options.initialPrompt).toContain("example/project #12");
  view.lifecycle.unmount();
});

test("shows a briefing in the page and relays its links to BB's opener", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const checklistGet = vi.fn(() => ({ keys: ["claim-old"] }));
  const checklistSet = vi.fn(() => ({ keys: ["claim-abc1"] }));
  const { withLinkBridge } = await import("../app");
  expect(withLinkBridge("<html><body><p>x</p></body></html>")).toMatch(
    /<p>x<\/p><script>[\s\S]*pr-briefings:open-url[\s\S]*<\/script><\/body>/,
  );
  const view = renderSlot(
    app.navPanels[0]!,
    { subPath: `view/${encodeURIComponent(url)}` }, // an older, percent-encoded link
    {
      rpc: {
        checklist_get: checklistGet,
        checklist_set: checklistSet,
        briefing_html: () => ({
          html: '<html><body><a href="https://github.com/x">x</a></body></html>',
          title: pr.title,
          subject: "example/project #12",
          head: pr.headSha,
        }),
        snapshot: () => ({
          queue: [],
          briefings: [record],
          preferences: { hostname: "github.com", model: "m", thinking: "medium", teams: "", teammates: "" },
          pairReviewAvailable: false,
          genuiAvailable: false,
          refreshing: false,
          warning: null,
        }),
      },
    },
  );
  const frame = (await view.findByTitle(`Briefing: ${pr.title}`)) as HTMLIFrameElement;
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame.getAttribute("srcdoc")).toContain("pr-briefings:open-url");
  // Messages from anything but the frame are ignored.
  window.dispatchEvent(new MessageEvent("message", { data: { type: "pr-briefings:open-url", href: "https://evil.example" } }));
  window.dispatchEvent(new MessageEvent("message", { data: { type: "pr-briefings:open-url", href: "https://github.com/x" }, source: frame.contentWindow }));
  window.dispatchEvent(new MessageEvent("message", { data: { type: "pr-briefings:open-url", href: "javascript:alert(1)" }, source: frame.contentWindow }));
  const opened = view.inspection.navigateCalls.filter((call: { method: string }) => call.method === "openUrl");
  expect(JSON.stringify(opened)).toContain("https://github.com/x");
  expect(JSON.stringify(opened)).not.toContain("evil.example");
  expect(JSON.stringify(opened)).not.toContain("javascript:");
  // Shortcut chords pressed inside the report are replayed on the frame for BB.
  const seen: KeyboardEvent[] = [];
  frame.addEventListener("keydown", (event) => seen.push(event));
  window.dispatchEvent(new MessageEvent("message", { data: { type: "pr-briefings:key", key: "j", code: "KeyJ", metaKey: true, shiftKey: true }, source: frame.contentWindow }));
  window.dispatchEvent(new MessageEvent("message", { data: { type: "pr-briefings:key", key: "j", code: "KeyJ", metaKey: true }, source: window }));
  expect(seen.map((event) => [event.key, event.metaKey, event.shiftKey, event.bubbles])).toEqual([["j", true, true, true]]);
  expect(withLinkBridge("<body></body>")).toContain("pr-briefings:key");
  // A tick inside the report is saved for this PR head.
  await waitFor(() => expect(checklistGet).toHaveBeenCalledWith({ url, head: pr.headSha }));
  window.dispatchEvent(new MessageEvent("message", { data: { type: "pr-briefings:check", key: "claim-abc1", checked: true }, source: frame.contentWindow }));
  window.dispatchEvent(new MessageEvent("message", { data: { type: "pr-briefings:check", key: "<script>", checked: true }, source: frame.contentWindow }));
  await waitFor(() => expect(checklistSet).toHaveBeenCalledTimes(1));
  expect(checklistSet).toHaveBeenCalledWith({ url, head: pr.headSha, key: "claim-abc1", checked: true });
  fireEvent.click(view.getByRole("button", { name: "Pull request" }));
  expect(JSON.stringify(view.inspection.navigateCalls)).toContain(url);
  view.lifecycle.unmount();
});

test("round-trips viewer routes, including ones BB re-encoded", async () => {
  const { viewerSubPath, viewerUrl } = await import("../app");
  const route = viewerSubPath(url);
  expect(route).toMatch(/^view\/[A-Za-z0-9_-]+$/);
  expect(viewerUrl(route)).toBe(url);
  expect(viewerUrl(encodeURI(route))).toBe(url);
  expect(viewerUrl(`view/${encodeURIComponent(url)}`)).toBe(url);
  expect(viewerUrl(`view/${encodeURIComponent(encodeURIComponent(url))}`)).toBe(url);
  expect(viewerUrl("view/not-a-url")).toBeNull();
  expect(viewerUrl("")).toBeNull();
});
