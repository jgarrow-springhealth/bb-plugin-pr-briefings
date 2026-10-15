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
  expect(view.inspection.navigateCalls).toContainEqual({
    method: "experimental_openFilePreview",
    options: {
      target: {
        kind: "host",
        hostId: "host-1",
        path: record.file,
      },
      location: null,
    },
  });

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
