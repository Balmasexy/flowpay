import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createStoryblokPreviewHandler } from "../src/storyblok-preview.js";

function makeRequest(url: string, method = "GET") {
  return Object.assign(Readable.from([]), { url, method, headers: {} }) as IncomingMessage;
}

function makeResponse() {
  let status = 0;
  let body = "";
  const response = {
    writeHead(code: number) { status = code; return response; },
    end(value?: string) { body = value ?? ""; return response; },
  } as unknown as ServerResponse;
  return {
    response,
    get status() { return status; },
    get body() { return body ? JSON.parse(body) as Record<string, unknown> : null; },
  };
}

function signedUrl(options: { spaceId?: string; timestamp?: number; signatureToken?: string; slug?: string } = {}) {
  const spaceId = options.spaceId ?? "12345";
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const token = options.signatureToken ?? "server-only-preview-secret";
  const signature = createHash("sha1").update(`${spaceId}:${token}:${timestamp}`).digest("hex");
  const params = new URLSearchParams({
    slug: options.slug ?? "home",
    _storyblok: "998877",
    "_storyblok_tk[space_id]": spaceId,
    "_storyblok_tk[timestamp]": String(timestamp),
    "_storyblok_tk[token]": signature,
  });
  return "/storyblok/preview?" + params.toString();
}

const config = { spaceId: "12345", previewToken: "server-only-preview-secret", region: "us" };

test("serves draft story content only after validating Storyblok's signed preview URL", async () => {
  let requestedUrl = "";
  const handler = createStoryblokPreviewHandler(config, async input => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ story: { id: 998877, content: { component: "page" } } }), { status: 200 });
  });
  const res = makeResponse();

  assert.equal(await handler(makeRequest(signedUrl()), res.response), true);
  assert.equal(res.status, 200);
  assert.equal((res.body?.story as Record<string, unknown>).id, 998877);
  assert.match(requestedUrl, /^https:\/\/api-us\.storyblok\.com\/v2\/cdn\/stories\/home\?/);
  assert.equal(new URL(requestedUrl).searchParams.get("version"), "draft");
  assert.equal(new URL(requestedUrl).searchParams.get("token"), "server-only-preview-secret");
});

test("rejects an invalid signature without calling Storyblok", async () => {
  let called = false;
  const handler = createStoryblokPreviewHandler(config, async () => {
    called = true;
    return new Response("{}", { status: 200 });
  });
  const res = makeResponse();
  const invalid = signedUrl().replace(/_storyblok_tk%5Btoken%5D=[^&]+/, "_storyblok_tk%5Btoken%5D=0000000000000000000000000000000000000000");

  await handler(makeRequest(invalid), res.response);
  assert.equal(res.status, 403);
  assert.equal(res.body?.error, "INVALID_STORYBLOK_PREVIEW_SIGNATURE");
  assert.equal(called, false);
});

test("rejects expired preview URLs", async () => {
  const handler = createStoryblokPreviewHandler(config, async () => new Response("{}", { status: 200 }));
  const res = makeResponse();
  await handler(makeRequest(signedUrl({ timestamp: Math.floor(Date.now() / 1000) - 3601 })), res.response);
  assert.equal(res.status, 403);
  assert.equal(res.body?.error, "STORYBLOK_PREVIEW_LINK_EXPIRED");
});

test("rejects a preview URL for another Storyblok space", async () => {
  const handler = createStoryblokPreviewHandler(config, async () => new Response("{}", { status: 200 }));
  const res = makeResponse();
  await handler(makeRequest(signedUrl({ spaceId: "99999" })), res.response);
  assert.equal(res.status, 403);
  assert.equal(res.body?.error, "STORYBLOK_PREVIEW_SPACE_MISMATCH");
});

test("rejects unsafe story paths and unconfigured preview secrets", async () => {
  const handler = createStoryblokPreviewHandler(config, async () => new Response("{}", { status: 200 }));
  const unsafe = makeResponse();
  await handler(makeRequest(signedUrl({ slug: "../admin" })), unsafe.response);
  assert.equal(unsafe.status, 400);

  const unconfigured = makeResponse();
  const disabledHandler = createStoryblokPreviewHandler({ spaceId: "12345" }, async () => new Response("{}", { status: 200 }));
  await disabledHandler(makeRequest(signedUrl()), unconfigured.response);
  assert.equal(unconfigured.status, 503);
});
