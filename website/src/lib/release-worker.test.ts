import { expect, it } from "bun:test";

import worker, { type WorkerEnv } from "../worker";
import type { ReleaseBucket, ReleaseObject } from "./release-worker";

function makeObject(
  body: string,
  options: {
    readonly size?: number;
    readonly range?: ReleaseObject["range"];
  } = {},
): ReleaseObject {
  return {
    body: new Response(body).body ?? undefined,
    size: options.size ?? body.length,
    range: options.range,
    httpEtag: '"release-etag"',
    writeHttpMetadata(headers) {
      headers.set("cache-control", "public, max-age=60");
      headers.set("content-type", "application/octet-stream");
    },
  };
}

function makeEnv(result: ReleaseObject | null) {
  const keys: string[] = [];
  const getOptions: Array<{
    readonly onlyIf: Headers;
    readonly range?: Headers;
  }> = [];
  const bucket: ReleaseBucket = {
    async get(key, options) {
      keys.push(key);
      getOptions.push(options);
      return result;
    },
  };
  const assetRequests: Request[] = [];
  const env: WorkerEnv = {
    RELEASES: bucket,
    ASSETS: {
      async fetch(request) {
        assetRequests.push(request);
        return new Response("website asset");
      },
    },
  };
  return { env, keys, getOptions, assetRequests };
}

it("serves release objects from the private bucket path", async () => {
  const { env, keys } = makeEnv(makeObject("artifact"));

  const response = await worker.fetch(
    new Request(
      "https://agentgauge.soumitrasaha.com/downloads/latest/AgentGauge.dmg",
    ),
    env,
  );

  expect(keys).toEqual(["latest/AgentGauge.dmg"]);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("public, max-age=60");
  expect(response.headers.get("content-type")).toBe("application/octet-stream");
  expect(response.headers.get("etag")).toBe('"release-etag"');
  expect(await response.text()).toBe("artifact");
});

it("supports byte-range reads for resumable downloads", async () => {
  const { env, getOptions } = makeEnv(
    makeObject("234", { size: 10, range: { offset: 2, length: 3 } }),
  );

  const response = await worker.fetch(
    new Request("https://agentgauge.soumitrasaha.com/downloads/v1/app.dmg", {
      headers: { range: "bytes=2-4" },
    }),
    env,
  );

  expect(response.status).toBe(206);
  expect(response.headers.get("accept-ranges")).toBe("bytes");
  expect(response.headers.get("content-range")).toBe("bytes 2-4/10");
  expect(response.headers.get("content-length")).toBe("3");
  expect(await response.text()).toBe("234");
  expect(getOptions[0]?.range?.get("range")).toBe("bytes=2-4");
});

it("honors matching If-Range etags and restarts with the full body for stale etags", async () => {
  const calls: Array<boolean> = [];
  const { env: base } = makeEnv(null);
  const env: WorkerEnv = {
    ...base,
    RELEASES: {
      async get(_key, options) {
        calls.push(Boolean(options.range));
        return options.range
          ? makeObject("234", { size: 10, range: { offset: 2, length: 3 } })
          : makeObject("0123456789");
      },
    },
  };
  const url = "https://agentgauge.soumitrasaha.com/downloads/v0.2.0/app.dmg";
  const headers = { range: "bytes=2-4", "if-range": '"release-etag"' };
  const matching = await worker.fetch(new Request(url, { headers }), env);
  expect(matching.status).toBe(206);
  expect(await matching.text()).toBe("234");

  const stale = await worker.fetch(new Request(url, {
    headers: { ...headers, "if-range": '"older-etag"' },
  }), env);
  expect(stale.status).toBe(200);
  expect(stale.headers.get("content-range")).toBeNull();
  expect(await stale.text()).toBe("0123456789");
  expect(calls).toEqual([true, true, false]);
});

it("returns metadata without a response body to HEAD requests", async () => {
  const { env } = makeEnv(makeObject("artifact"));

  const response = await worker.fetch(
    new Request("https://agentgauge.soumitrasaha.com/downloads/latest.json", {
      method: "HEAD",
    }),
    env,
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("content-length")).toBe("8");
  expect(await response.text()).toBe("");
});

it("returns 404 for missing artifacts and forwards non-downloads to assets", async () => {
  const { env, assetRequests } = makeEnv(null);

  const missing = await worker.fetch(
    new Request("https://agentgauge.soumitrasaha.com/downloads/missing.dmg"),
    env,
  );
  const asset = await worker.fetch(
    new Request("https://agentgauge.soumitrasaha.com/"),
    env,
  );

  expect(missing.status).toBe(404);
  expect(asset.status).toBe(200);
  expect(assetRequests).toHaveLength(1);
});

it("rejects unsupported methods and encoded path separators", async () => {
  const { env, keys } = makeEnv(makeObject("artifact"));

  const method = await worker.fetch(
    new Request("https://agentgauge.soumitrasaha.com/downloads/app.dmg", {
      method: "POST",
    }),
    env,
  );
  const path = await worker.fetch(
    new Request("https://agentgauge.soumitrasaha.com/downloads/a%2Fb.dmg"),
    env,
  );

  expect(method.status).toBe(405);
  expect(method.headers.get("allow")).toBe("GET, HEAD");
  expect(path.status).toBe(400);
  expect(keys).toEqual([]);
});

it("caches immutable artifacts and the short-lived first-download alias, but not manifests", async () => {
  const { env: baseEnv, keys } = makeEnv(null);
  const env: WorkerEnv = {
    ...baseEnv,
    RELEASES: {
      async get(key) {
        keys.push(key);
        return makeObject("artifact", { size: 8 });
      },
    },
  };
  const stored = new Map<string, Response>();
  const cache = {
    async match(key: Request) { return stored.get(key.url); },
    async put(key: Request, value: Response) { stored.set(key.url, value); },
  };
  const ctx = { waitUntil(promise: Promise<unknown>) { return promise; } };
  const url = "https://agentgauge.soumitrasaha.com/downloads/v0.2.0/AgentGauge-0.2.0-universal.dmg";
  await worker.fetch(new Request(url), env, ctx, cache);
  const hit = await worker.fetch(new Request(url), env, ctx, cache);
  expect(await hit.text()).toBe("artifact");
  expect(keys).toEqual(["v0.2.0/AgentGauge-0.2.0-universal.dmg"]);

  const latestDmg = "https://agentgauge.soumitrasaha.com/downloads/latest/AgentGauge-universal.dmg";
  await worker.fetch(new Request(latestDmg), env, ctx, cache);
  expect((await worker.fetch(new Request(latestDmg), env, ctx, cache)).status).toBe(200);
  expect(keys).toEqual([
    "v0.2.0/AgentGauge-0.2.0-universal.dmg",
    "latest/AgentGauge-universal.dmg",
  ]);

  await worker.fetch(new Request("https://agentgauge.soumitrasaha.com/downloads/latest.json"), env, ctx, cache);
  await worker.fetch(new Request("https://agentgauge.soumitrasaha.com/downloads/latest.json"), env, ctx, cache);
  expect(keys).toHaveLength(4);

  await worker.fetch(new Request(url, { headers: { range: "bytes=0-3" } }), env, ctx, cache);
  expect(keys).toHaveLength(5);
});
