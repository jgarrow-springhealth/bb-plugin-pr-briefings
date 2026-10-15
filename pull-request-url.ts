import { z } from "zod";

const Coordinate = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+$/)
  .max(100);

export function parsePullRequestUrl(raw: string, hostname = "github.com") {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.hostname !== hostname ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    raw.includes("%")
  )
    throw Error(`Expected an HTTPS pull-request URL on ${hostname}`);
  const match = url.pathname.match(
    /^\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)\/?$/,
  );
  if (!match) throw Error("Invalid GitHub pull-request URL");
  const owner = Coordinate.parse(match[1]);
  const repo = Coordinate.parse(match[2]);
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number)) throw Error("Invalid pull-request number");
  return { host: hostname, owner, repo, number };
}
