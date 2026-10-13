import { serveReleaseObject, type ReleaseBucket } from "./lib/release-worker";

export interface WorkerEnv {
  readonly ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  readonly RELEASES: ReleaseBucket;
}

interface ResponseCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

interface WorkerContext {
  waitUntil(promise: Promise<unknown>): unknown;
}

export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    context?: WorkerContext,
    cache?: ResponseCache,
  ): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/downloads" || pathname.startsWith("/downloads/")) {
      const edgeCache = cache ?? (globalThis as unknown as { caches?: { default: ResponseCache } }).caches?.default;
      const cacheable = request.method === "GET" &&
        (/^\/downloads\/v\d+\.\d+\.\d+\//.test(pathname) ||
          pathname === "/downloads/latest/AgentGauge-universal.dmg") &&
        !new URL(request.url).search &&
        !["range", "if-range", "if-none-match", "if-modified-since", "if-match", "if-unmodified-since"].some(
          (header) => request.headers.has(header),
        );
      const cacheKey = new Request(request.url);
      if (cacheable && edgeCache) {
        const hit = await edgeCache.match(cacheKey);
        if (hit) return hit;
      }
      const response = await serveReleaseObject(request, env.RELEASES);
      const size = Number(response.headers.get("content-length"));
      if (cacheable && edgeCache && context && response.status === 200 &&
        size > 0 && size <= 512 * 1024 * 1024) {
        context.waitUntil(edgeCache.put(cacheKey, response.clone()).catch(() => undefined));
      }
      return response;
    }
    return env.ASSETS.fetch(request);
  },
};
