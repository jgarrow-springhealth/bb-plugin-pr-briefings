import { describe, expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { DEFAULT_PREFERENCES } from "../contract";

function createHarness() {
  const host = createFakePluginHost({
    pluginId: "pr-briefings",
    sdk: {
      system: { config: async () => ({ primaryHostId: "host-1" }) as never },
      plugins: { list: async () => ({ plugins: [] }) as never },
    },
    experimental_callHostRpc: async ({ method }) => {
      if (method === "discover") return { prs: [] };
      throw Error(`Unexpected host method ${method}`);
    },
  });
  plugin(host.bb);
  return host.harness;
}

describe("PR Briefings settings", () => {
  test("registers documented defaults and help in BB's native settings UI", async () => {
    const harness = createHarness();
    const descriptors = harness.inspection.registrations.settingsDescriptors;

    expect(Object.keys(descriptors)).toEqual(Object.keys(DEFAULT_PREFERENCES));
    for (const [key, value] of Object.entries(DEFAULT_PREFERENCES)) {
      expect(descriptors[key]?.default).toBe(value);
      expect(descriptors[key]?.description).toBeTruthy();
    }
    await expect(harness.behavior.callRpc("snapshot", null)).resolves.toMatchObject(
      { preferences: DEFAULT_PREFERENCES },
    );

    await harness.lifecycle.dispose();
  });

  test.each([
    ["hostname", "https://github.com"],
    ["hostname", "GitHub.com"],
    ["provider", "other"],
    ["model", "bad model"],
    ["thinking", "extreme"],
    ["teams", "missing-a-slash"],
    [
      "teams",
      Array.from({ length: 21 }, (_, index) => `example/team-${index}`).join(","),
    ],
    ["teammates", "invalid!handle"],
    [
      "teammates",
      Array.from({ length: 101 }, (_, index) => `person-${index}`).join(","),
    ],
  ])("rejects invalid %s values at the settings boundary", async (key, value) => {
    const harness = createHarness();

    await expect(
      harness.behavior.setSettings({ [key]: value }),
    ).rejects.toThrow();

    await harness.lifecycle.dispose();
  });

  test("persists valid settings and applies them to discovery", async () => {
    const harness = createHarness();
    const configured = {
      hostname: "github.example.com",
      provider: "claude",
      model: "opus",
      thinking: "high",
      teams: "example/platform, example/security",
      teammates: "octocat, hubot",
    } as const;

    await harness.behavior.setSettings(configured);
    await expect(harness.behavior.callRpc("snapshot", null)).resolves.toMatchObject(
      { preferences: configured },
    );

    await harness.behavior.callRpc("refresh", null);
    await expect
      .poll(() =>
        harness.inspection.experimental_hostRpcCalls.find(
          (call) => call.method === "discover",
        ),
      )
      .toMatchObject({
        hostId: "host-1",
        input: {
          hostname: configured.hostname,
          teams: ["example/platform", "example/security"],
        },
      });

    await harness.lifecycle.dispose();
  });

  test("resets every stored value to its documented default", async () => {
    const harness = createHarness();
    await harness.behavior.setSettings({
      hostname: "github.example.com",
      provider: "codex",
      model: "gpt-5.6-sol-high",
      thinking: "high",
      teams: "example/platform",
      teammates: "octocat",
    });

    await expect(
      harness.behavior.callRpc("reset_settings", null),
    ).resolves.toEqual(DEFAULT_PREFERENCES);
    await expect(harness.behavior.callRpc("snapshot", null)).resolves.toMatchObject(
      { preferences: DEFAULT_PREFERENCES },
    );
    expect(harness.inspection.realtimeSignals).toContainEqual({
      channel: "changed",
      payload: {},
    });

    await harness.lifecycle.dispose();
  });
});
