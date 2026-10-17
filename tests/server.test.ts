import { expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

const url = "https://github.com/example/project/pull/12";
const invalidUrls = [
  "http://github.example.com/example/project/pull/12",
  "https://github.com/example/project/pull/12",
  "https://github.example.com/example/project/issues/12",
  "https://github.example.com/example/project/pull/12?diff=split",
  "https://github.example.com/example/project/pull/12#files",
  "https://github.example.com/example/project/%70ull/12",
];

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
  requestKinds: [],
  changedFiles: 3,
  additions: 21,
  deletions: 8,
};

async function createBoundaryHost() {
  const host = createFakePluginHost({
    pluginId: "pr-briefings",
    settings: {
      hostname: "github.example.com",
      model: "openai/gpt-5",
      thinking: "medium",
      teams: "",
      teammates: "",
    },
    sdk: {
      plugins: { list: async () => ({ plugins: [] }) as never },
    },
    experimental_callHostRpc: async ({ method }) => {
      throw Error(`Unexpected host method ${method}`);
    },
  });
  await plugin(host.bb);
  return host;
}

test("rejects non-canonical RPC URLs before queue insertion", async () => {
  const host = await createBoundaryHost();
  try {
    for (const invalidUrl of invalidUrls) {
      await expect(
        host.harness.behavior.callRpc("briefing_generate", {
          url: invalidUrl,
        }),
      ).rejects.toThrow();
    }

    await expect(
      host.harness.behavior.callRpc("snapshot", null),
    ).resolves.toMatchObject({ briefings: [] });
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("rejects non-canonical CLI URLs without queueing a record", async () => {
  const host = await createBoundaryHost();
  try {
    for (const invalidUrl of invalidUrls) {
      await expect(
        host.harness.behavior.runCli(["generate", invalidUrl]),
      ).resolves.toMatchObject({ exitCode: 1 });
    }

    await expect(
      host.harness.behavior.callRpc("snapshot", null),
    ).resolves.toMatchObject({ briefings: [] });

    await expect(
      host.harness.behavior.runCli([
        "generate",
        "https://github.example.com/example/project/pull/12",
      ]),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      host.harness.behavior.callRpc("snapshot", null),
    ).resolves.toMatchObject({
      briefings: [
        {
          url: "https://github.example.com/example/project/pull/12",
          state: "queued",
        },
      ],
    });
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("queues and completes a briefing independently of Pair Review", async () => {
  const host = createFakePluginHost({
    pluginId: "pr-briefings",
    settings: {
      hostname: "github.com",
      model: "openai/gpt-5",
      thinking: "medium",
      teams: "",
      teammates: "",
    },
    sdk: {
      system: { config: async () => ({ primaryHostId: "host-1" }) as never },
      plugins: {
        list: async () =>
          ({
            plugins: [
              {
                id: "pair-review",
                enabled: true,
                app: { hasApp: true },
              },
              { id: "genui", enabled: true, app: { hasApp: true } },
            ],
          }) as never,
      },
    },
    experimental_callHostRpc: async ({ method }) => {
      if (method === "generate")
        return {
          pr,
          file: "/Users/example/.pr-briefings/briefs/report.html",
          bundle: "/Users/example/.pr-briefings/briefs/report.genui",
          generatedAt: 42,
        };
      if (method === "discover") return { prs: [pr] };
      throw Error(`Unexpected host method ${method}`);
    },
  });
  await plugin(host.bb);
  try {
    await expect(host.harness.behavior.callRpc("snapshot", null)).resolves.toMatchObject({
      pairReviewAvailable: true,
      genuiAvailable: true,
    });

    const queued = await host.harness.behavior.callRpc("briefing_generate", {
      url,
    });
    expect(queued).toMatchObject({ available: true, state: "queued" });

    const service = host.harness.behavior.runService("generator");
    await expect
      .poll(async () => {
        const status = (await host.harness.behavior.callRpc("briefing_get", {
          url,
          head: pr.headSha,
        })) as { state: string };
        return status.state;
      })
      .toBe("ready");
    service.controller.abort();
    await service.done;

    expect(
      await host.harness.behavior.callRpc("briefing_get", {
        url,
        head: "c".repeat(40),
      }),
    ).toMatchObject({ state: "ready", stale: true, hostId: "host-1" });
    expect(
      ((await host.harness.behavior.callRpc("snapshot", null)) as any).briefings[0],
    ).toMatchObject({ bundle: "/Users/example/.pr-briefings/briefs/report.genui" });
    expect(
      host.harness.inspection.experimental_hostRpcCalls.find(
        (call) => call.method === "generate",
      ),
    ).toMatchObject({
      hostId: "host-1",
      input: {
        url,
        hostname: "github.com",
        provider: "pi",
        model: "openai/gpt-5",
        thinking: "medium",
      },
    });
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("saves review checklist ticks per PR head and drops older heads", async () => {
  const host = await createBoundaryHost();
  try {
    const call = (method: string, input: unknown) => host.harness.behavior.callRpc(method as never, input as never);
    const head = "b".repeat(40);
    await expect(call("checklist_set", { url, head, key: "claim-abc1", checked: true })).resolves.toEqual({ keys: ["claim-abc1"] });
    await call("checklist_set", { url, head, key: "claim-zz9", checked: true });
    await call("checklist_set", { url, head, key: "claim-abc1", checked: false });
    await expect(call("checklist_get", { url, head })).resolves.toEqual({ keys: ["claim-zz9"] });
    // A new head starts fresh, and ticks for the old head are cleared.
    const next = "c".repeat(40);
    await call("checklist_set", { url, head: next, key: "need-1", checked: true });
    await expect(call("checklist_get", { url, head })).resolves.toEqual({ keys: [] });
    await expect(call("checklist_set", { url, head, key: "Bad Key!", checked: true })).rejects.toThrow();
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
