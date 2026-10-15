import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract.ts";
import { discoverPullRequests, generateBriefing } from "./engine/generate.ts";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async discover(input, context) {
      return {
        prs: await discoverPullRequests(
          input.hostname,
          input.teams,
          context.signal,
        ),
      };
    },
    async generate(input, context) {
      const result = await generateBriefing({
        ...input,
        signal: context.signal,
      });
      return result;
    },
  },
});
