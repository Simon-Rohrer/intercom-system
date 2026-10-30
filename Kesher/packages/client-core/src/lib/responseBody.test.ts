import { afterEach, describe, expect, it, vi } from "vitest";
import { getStatus } from "../api";
import { fetchCentralIdentity } from "./centralLogin";
import { fetchPiControl } from "./piControl";
import { discardBody } from "./responseBody";

/** A response whose body records whether it was cancelled (= Chromium may free its data pipe). */
function trackedResponse(status: number, contentType: string, body = "{}") {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const res = new Response(stream, { status, headers: { "content-type": contentType } });
  return { res, wasCancelled: () => cancelled };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("discardBody", () => {
  it("cancels an unread body", async () => {
    const { res, wasCancelled } = trackedResponse(401, "application/json");
    discardBody(res);
    await Promise.resolve();
    expect(wasCancelled()).toBe(true);
  });

  it("leaves a read body and a response without body alone", async () => {
    const { res } = trackedResponse(200, "application/json");
    await res.json();
    expect(() => discardBody(res)).not.toThrow();
    expect(() => discardBody(new Response(null, { status: 204 }))).not.toThrow();
  });
});

describe("polls release the body they do not read", () => {
  it("Pi switch poll: 401 from JMS Control (every 15 s on a Raspberry Pi)", async () => {
    const { res, wasCancelled } = trackedResponse(401, "application/json", '{"error":"login required"}');
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));
    expect(await fetchPiControl()).toBeNull();
    await Promise.resolve();
    expect(wasCancelled()).toBe(true);
  });

  it("central identity: HTML instead of JSON (Kesher without JMS Control)", async () => {
    const { res, wasCancelled } = trackedResponse(200, "text/html", "<!doctype html>");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));
    expect(await fetchCentralIdentity()).toBeNull();
    await Promise.resolve();
    expect(wasCancelled()).toBe(true);
  });

  it("status poll: error status", async () => {
    const { res, wasCancelled } = trackedResponse(503, "text/plain", "busy");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));
    await expect(getStatus("token")).rejects.toThrow("Status konnte nicht geladen werden");
    expect(wasCancelled()).toBe(true);
  });
});
