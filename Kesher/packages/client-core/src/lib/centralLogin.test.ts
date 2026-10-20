import { afterEach, describe, expect, it, vi } from "vitest";
import { centralIdentityKey, centralSessionLogin, fetchCentralIdentity, redirectToCentralLoginOnUnauthorized, resolveStoredTokenRestore } from "./centralLogin";
import { ApiError, getGlobalApiBaseUrl } from "../api";
import { resolveAutoLoginConfiguration } from "./autoLogin";

vi.mock("../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../api")>(),
  getGlobalApiBaseUrl: vi.fn(() => ""),
}));

const identity = { name: "Tim", roleId: "lighting", admin: false, sessionId: "session-one", version: "version-one", expiresAt: Date.now() + 60_000 };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(getGlobalApiBaseUrl).mockReturnValue("");
});

describe("expired gateway login", () => {
  it("redirects a 401 to login on the current origin and preserves the page query", () => {
    const replace = vi.fn();
    vi.stubGlobal("window", { location: { pathname: "/login", search: "?login=raspberry", replace } });
    expect(redirectToCentralLoginOnUnauthorized(new ApiError(401, "", "start data failed"))).toBe(true);
    expect(replace).toHaveBeenCalledWith("/.jms-auth/login?next=%2Flogin%3Flogin%3Draspberry");
  });

  it("does not turn outages or denied permissions into login loops", () => {
    const replace = vi.fn();
    vi.stubGlobal("window", { location: { pathname: "/", search: "", replace } });
    for (const error of [new Error("offline"), new ApiError(403, "", "forbidden"), new ApiError(503, "", "unavailable")]) {
      expect(redirectToCentralLoginOnUnauthorized(error)).toBe(false);
    }
    expect(replace).not.toHaveBeenCalled();
  });

  it("keeps configured desktop servers on their existing authentication flow", () => {
    vi.mocked(getGlobalApiBaseUrl).mockReturnValue("https://intercom.internal");
    const replace = vi.fn();
    vi.stubGlobal("window", { location: { pathname: "/", search: "", replace } });
    expect(redirectToCentralLoginOnUnauthorized(new ApiError(401, "", "unauthorized"))).toBe(false);
    expect(replace).not.toHaveBeenCalled();
  });
});

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

  it("asks for a signed mirror ticket for a Kesher tile and never sends the own role", async () => {
    const result = { token: "fixture-token", user: { id: "fixture-user", username: "Multiview", roleId: "lighting" } };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ticket: "fixture-ticket" })))
      .mockResolvedValueOnce(new Response(JSON.stringify(result)));
    vi.stubGlobal("fetch", fetcher);
    expect(await centralSessionLogin({ roleId: "lighting", username: "Multiview" })).toEqual(result);
    expect(fetcher.mock.calls[0][0]).toBe("/.jms-auth/api/ticket?aud=kesher&mirror=lighting");
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ ticket: "fixture-ticket", secondary: true, username: "Multiview" });
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

const tim = { ...identity, roleId: "ton" };

describe("resolveStoredTokenRestore", () => {
  it("keeps the tab's session for the same central identity", () => {
    expect(
      resolveStoredTokenRestore({
        storedToken: "t1",
        storedIdentityKey: centralIdentityKey(tim),
        identity: tim,
        raspberryRemoteLogin: false,
      }),
    ).toBe("keep");
  });

  it("drops the session when someone else is signed in centrally", () => {
    expect(
      resolveStoredTokenRestore({
        storedToken: "t1",
        storedIdentityKey: centralIdentityKey(tim),
        identity: { ...identity, name: "Anna", roleId: "licht" },
        raspberryRemoteLogin: false,
      }),
    ).toBe("discard");
  });

  it("never restores the own session when opened with login=raspberry", () => {
    expect(
      resolveStoredTokenRestore({
        storedToken: "t1",
        storedIdentityKey: centralIdentityKey(tim),
        identity: tim,
        raspberryRemoteLogin: true,
      }),
    ).toBe("discard");
  });

  it("has nothing to do without a stored token", () => {
    expect(
      resolveStoredTokenRestore({
        storedToken: null,
        storedIdentityKey: "",
        identity: tim,
        raspberryRemoteLogin: true,
      }),
    ).toBe("none");
  });
});
