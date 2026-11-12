import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export type StoryblokRegion = "eu" | "us" | "ap" | "ca" | "cn";

export type StoryblokPreviewConfig = {
  spaceId?: string;
  previewToken?: string;
  region?: string;
};

const REGION_BASE_URLS: Record<StoryblokRegion, string> = {
  eu: "https://api.storyblok.com/v2/cdn",
  us: "https://api-us.storyblok.com/v2/cdn",
  ap: "https://api-ap.storyblok.com/v2/cdn",
  ca: "https://api-ca.storyblok.com/v2/cdn",
  cn: "https://app.storyblokchina.cn/v2/cdn",
};

function respond(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function isRegion(value: string): value is StoryblokRegion {
  return Object.prototype.hasOwnProperty.call(REGION_BASE_URLS, value);
}

function isValidSlug(slug: string): boolean {
  if (!slug || slug.length > 200 || slug.startsWith("/") || slug.endsWith("/")) return false;
  const segments = slug.split("/");
  return segments.every(segment =>
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    /^[a-zA-Z0-9_-]+$/.test(segment)
  );
}

function sameDigest(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{40}$/i.test(actual) || !/^[a-f0-9]{40}$/i.test(expected)) return false;
  const actualBytes = Buffer.from(actual, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

/**
 * Secure draft-content proxy for Storyblok's Visual Editor.
 * The Preview token stays on the API server and is never placed in Vite's
 * public browser bundle. Storyblok's signed preview URL is verified here.
 */
export function createStoryblokPreviewHandler(
  config: StoryblokPreviewConfig,
  fetcher: typeof fetch = fetch
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/storyblok/preview") return false;

    if (req.method !== "GET") {
      respond(res, 405, { error: "METHOD_NOT_ALLOWED" });
      return true;
    }

    const spaceId = config.spaceId?.trim() ?? "";
    const previewToken = config.previewToken?.trim() ?? "";
    const region = (config.region?.trim() || "eu").toLowerCase();

    if (!spaceId || !/^\d+$/.test(spaceId) || !previewToken || !isRegion(region)) {
      respond(res, 503, { error: "STORYBLOK_PREVIEW_NOT_CONFIGURED" });
      return true;
    }

    const slug = url.searchParams.get("slug") ?? "";
    const storyId = url.searchParams.get("_storyblok") ?? "";
    const signedSpaceId = url.searchParams.get("_storyblok_tk[space_id]") ?? "";
    const timestampText = url.searchParams.get("_storyblok_tk[timestamp]") ?? "";
    const signature = url.searchParams.get("_storyblok_tk[token]") ?? "";

    if (!isValidSlug(slug) || !/^\d+$/.test(storyId) || !/^\d+$/.test(timestampText) ||
        !signedSpaceId || !signature) {
      respond(res, 400, { error: "INVALID_STORYBLOK_PREVIEW_REQUEST" });
      return true;
    }

    if (signedSpaceId !== spaceId) {
      respond(res, 403, { error: "STORYBLOK_PREVIEW_SPACE_MISMATCH" });
      return true;
    }

    const timestamp = Number(timestampText);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(timestamp) || timestamp < now - 3600 || timestamp > now + 60) {
      respond(res, 403, { error: "STORYBLOK_PREVIEW_LINK_EXPIRED" });
      return true;
    }

    const expectedSignature = createHash("sha1")
      .update(`${spaceId}:${previewToken}:${timestampText}`)
      .digest("hex");

    if (!sameDigest(signature, expectedSignature)) {
      respond(res, 403, { error: "INVALID_STORYBLOK_PREVIEW_SIGNATURE" });
      return true;
    }

    const baseUrl = REGION_BASE_URLS[region];
    const storyPath = slug.split("/").map(encodeURIComponent).join("/");
    const upstreamUrl = new URL(`${baseUrl}/stories/${storyPath}`);
    upstreamUrl.searchParams.set("token", previewToken);
    upstreamUrl.searchParams.set("version", "draft");

    try {
      const upstream = await fetcher(upstreamUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      });

      if (!upstream.ok) {
        respond(res, upstream.status === 404 ? 404 : 502, {
          error: upstream.status === 404 ? "STORYBLOK_STORY_NOT_FOUND" : "STORYBLOK_UPSTREAM_UNAVAILABLE",
        });
        return true;
      }

      const payload: unknown = await upstream.json();
      respond(res, 200, payload);
    } catch {
      respond(res, 502, { error: "STORYBLOK_UPSTREAM_UNAVAILABLE" });
    }
    return true;
  };
}
