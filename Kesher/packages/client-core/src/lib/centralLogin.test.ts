import { afterEach, describe, expect, it, vi } from "vitest";
import { centralIdentityKey, centralSessionLogin, fetchCentralIdentity } from "./centralLogin";
import { resolveAutoLoginConfiguration } from "./autoLogin";

vi.mock("../api", () => ({ getGlobalApiBaseUrl: () => "" }));

const identity = { name: "Tim", roleId: "lighting", admin: false, sessionId: "session-one", version: "version-one", expiresAt: Date.now() + 60_000 };

afterEach(() => vi.unstubAllGlobals());

describe("central session binding", () => {
  it("distinguishes repeated logins with the same display identity", () => {
    const original = centralIdentityKey(identity);
    expect(centralIdentityKey({ ...identity, sessionId: "session-two" })).not.toBe(original);
    expect(centralIdentityKey({ ...identity, version: "version-two" })).not.toBe(original);
    expect(centralIdentityKey({ ...identity, expiresAt: identity.expiresAt + 1 })).not.toBe(original);
    expect(centralIdentityKey(null)).toBe("");
  });

  it("accepts only complete, unexpired server identities", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const user of [identity, { ...identity, expiresAt: 1 }, { ...identity, sessionId: "" }, { ...identity, version: "" }]) {
      fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ user }), { headers: { "Content-Type": "application/json" } }));
    }
    expect(await fetchCentralIdentity()).toEqual(identity);
    expect(await fetchCentralIdentity()).toBeNull();
    expect(await fetchCentralIdentity()).toBeNull();
    expect(await fetchCentralIdentity()).toBeNull();
  });

  it("uses a signed central ticket for normal users, not the legacy name/role login", async () => {
    const result = { token: "fixture-token", user: { id: "fixture-user", username: "Tim", roleId: "lighting" } };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ticket: "fixture-ticket" })))
      .mockResolvedValueOnce(new Response(JSON.stringify(result)));
    vi.stubGlobal("fetch", fetcher);
    expect(await centralSessionLogin()).toEqual(result);
    expect(fetcher.mock.calls[1][0]).toBe("/api/login/central");
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ ticket: "fixture-ticket" });
  });

  it("keeps a certificate-authenticated Pi on the native station login path", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      access: { enabled: true },
      user: null,
      device: { required: false, approved: true, expiresAt: Date.now() + 60_000 },
    }), { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    const central = await fetchCentralIdentity();
    const configuration = resolveAutoLoginConfiguration(
      "?autoLogin=1&autoTakeover=1&username=Kamera1&roleId=cam1",
      [{ id: "cam1", name: "Kamera 1" }],
      central,
    );
    expect(central).toBeNull();
    expect(configuration).toMatchObject({
      enabled: true,
      username: "Kamera1",
      roleId: "cam1",
      central: false,
      allowTakeover: true,
    });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/.jms-auth/api/me"]);
  });

  it("does not treat device approval or open access as a human session", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const user of [{ ...identity, open: true }, { name: "Kamera1", roleId: "cam1", admin: false }]) {
      fetcher.mockResolvedValueOnce(new Response(JSON.stringify({
        access: { enabled: true }, user, device: { approved: true },
      }), { headers: { "Content-Type": "application/json" } }));
      expect(await fetchCentralIdentity()).toBeNull();
    }
  });
});
