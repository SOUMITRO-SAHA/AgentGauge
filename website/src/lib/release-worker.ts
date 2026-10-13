export interface ReleaseObject {
  readonly body?: ReadableStream<Uint8Array>;
  readonly size: number;
  readonly httpEtag: string;
  readonly range?: {
    readonly offset?: number;
    readonly length?: number;
    readonly suffix?: number;
  };
  writeHttpMetadata(headers: Headers): void;
}

export interface ReleaseBucket {
  get(
    key: string,
    options: { readonly onlyIf: Headers; readonly range?: Headers },
  ): Promise<ReleaseObject | null>;
}

const DOWNLOADS_PREFIX = "/downloads/";

export async function serveReleaseObject(
  request: Request,
  bucket: ReleaseBucket,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }

  const key = getReleaseKey(new URL(request.url).pathname);
  if (key === null) {
    return new Response("Invalid download path", { status: 400 });
  }

  const isGet = request.method === "GET";
  const rangeRequested = isGet && request.headers.has("range");
  const canHonorRange = rangeRequested;
  let object = await bucket.get(key, {
    onlyIf: request.headers,
    ...(canHonorRange ? { range: request.headers } : {}),
  });

  if (object === null) {
    return new Response("Not Found", { status: 404 });
  }

  const ifRange = request.headers.get("if-range");
  const matchesIfRange = !ifRange ||
    (!ifRange.startsWith("W/") && object.httpEtag.startsWith("\"") && ifRange === object.httpEtag);
  if (canHonorRange && !matchesIfRange) {
    await object.body?.cancel();
    object = await bucket.get(key, { onlyIf: new Headers() });
    if (object === null) return new Response("Not Found", { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");

  if (!hasBody(object)) {
    headers.delete("content-length");
    return new Response(null, {
      status: conditionalFailureStatus(request),
      headers,
    });
  }

  const range = canHonorRange && matchesIfRange
    ? resolveReturnedRange(object.range, object.size)
    : null;
  const status = range === null ? 200 : 206;
  headers.set("content-length", String(range?.length ?? object.size));
  if (range !== null) {
    headers.set(
      "content-range",
      `bytes ${range.start}-${range.end}/${object.size}`,
    );
  }

  return new Response(isGet ? object.body ?? null : null, { status, headers });
}

function getReleaseKey(pathname: string): string | null {
  if (!pathname.startsWith(DOWNLOADS_PREFIX)) {
    return null;
  }

  const encodedSegments = pathname.slice(DOWNLOADS_PREFIX.length).split("/");
  if (
    encodedSegments.length === 0 ||
    encodedSegments.some((segment) => segment === "")
  ) {
    return null;
  }

  try {
    const segments = encodedSegments.map((segment) => decodeURIComponent(segment));
    if (
      segments.some(
        (segment) =>
          segment === "." ||
          segment === ".." ||
          segment.includes("/") ||
          segment.includes("\\") ||
          segment.includes("\0"),
      )
    ) {
      return null;
    }
    return segments.join("/");
  } catch {
    return null;
  }
}

function hasBody(object: ReleaseObject): object is ReleaseObject & {
  readonly body: ReadableStream<Uint8Array>;
} {
  return object.body !== undefined;
}

function conditionalFailureStatus(request: Request): 304 | 412 {
  const hasNotModifiedCondition =
    request.headers.has("if-none-match") ||
    request.headers.has("if-modified-since");
  const hasPrecedenceCondition =
    request.headers.has("if-match") ||
    request.headers.has("if-unmodified-since");
  return hasNotModifiedCondition && !hasPrecedenceCondition ? 304 : 412;
}

function resolveReturnedRange(
  range: ReleaseObject["range"],
  size: number,
): {
  readonly start: number;
  readonly end: number;
  readonly length: number;
} | null {
  if (range === undefined) {
    return null;
  }

  const length =
    range.length ??
    (range.suffix === undefined
      ? size - (range.offset ?? 0)
      : Math.min(range.suffix, size));
  const start = range.offset ?? Math.max(size - length, 0);
  if (length <= 0 || start >= size) {
    return null;
  }

  const actualLength = Math.min(length, size - start);
  return {
    start,
    end: start + actualLength - 1,
    length: actualLength,
  };
}
