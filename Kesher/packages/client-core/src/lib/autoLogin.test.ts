import { describe, expect, it } from "vitest";
import { autoLoginRetryDelay, centralMirrorFor, resolveAutoLoginConfiguration, urlRequestsMirror } from "./autoLogin";

// Sitzungsdaten der zentralen Anmeldung – für diese Tests ohne Bedeutung
const SESSION = { sessionId: "s1", version: "v1", expiresAt: Number.MAX_SAFE_INTEGER };

const roles = [
  { id: "audio", name: "Audio" },
  { id: "stage-left", name: "Stage Left" },
];

describe("resolveAutoLoginConfiguration", () => {
  it("resolves the stable role ID used by Raspberry Pi stations", () => {
    expect(
      resolveAutoLoginConfiguration(
        "?autoLogin=1&autoTakeover=1&username=FOH&roleId=audio",
        roles,
      ),
    ).toEqual({
      enabled: true,
      username: "FOH",
      roleId: "audio",
      requestedRole: "audio",
      allowTakeover: true,
      secondary: false,
      central: false,
    });
  });

  it("marks secondary devices (Multiview tile of the logged-in user)", () => {
    const config = resolveAutoLoginConfiguration(
      "?autoLogin=1&username=Lasse&roleId=audio&secondary=1",
      roles,
    );
    expect(config.secondary).toBe(true);
    expect(config.allowTakeover).toBe(false);
  });

  it("keeps role-name links backwards compatible", () => {
    const config = resolveAutoLoginConfiguration(
      "?autoLogin=true&username=Stage&roleName=stage%20left",
      roles,
    );
    expect(config.roleId).toBe("stage-left");
  });

  it("does not resolve an unknown role ID", () => {
    const config = resolveAutoLoginConfiguration(
      "?autoLogin=1&username=FOH&roleId=missing",
      roles,
    );
    expect(config.roleId).toBe("");
    expect(config.requestedRole).toBe("missing");
  });

  it("logs in with the role from the server's central login", () => {
    const config = resolveAutoLoginConfiguration("", roles, {
      name: "Tim",
      roleId: "audio",
      admin: false,
      ...SESSION,
    });
    expect(config).toEqual({
      enabled: true,
      username: "Tim",
      roleId: "audio",
      requestedRole: "audio",
      allowTakeover: false,
      secondary: false,
      central: true,
    });
  });

  it("prefers URL parameters (fixed devices, Multiview tile) over the central login", () => {
    const config = resolveAutoLoginConfiguration(
      "?autoLogin=1&username=FOH&roleId=stage-left",
      roles,
      { name: "Tim", roleId: "audio", admin: false, ...SESSION },
    );
    expect(config.username).toBe("FOH");
    expect(config.central).toBe(false);
  });

  it("ignores the central admin and unknown central roles", () => {
    expect(
      resolveAutoLoginConfiguration("", roles, { name: "Simon", roleId: "admin", admin: true, ...SESSION }).enabled,
    ).toBe(false);
    const unknown = resolveAutoLoginConfiguration("", roles, {
      name: "Tim",
      roleId: "gibts-nicht",
      admin: false,
      ...SESSION,
    });
    expect(unknown.enabled).toBe(true);
    expect(unknown.roleId).toBe("");
  });

  it("skips every auto-login when opened to remote-control a Raspberry Pi", () => {
    const config = resolveAutoLoginConfiguration("?login=raspberry", roles, {
      name: "Tim",
      roleId: "audio",
      admin: false,
      ...SESSION,
    });
    expect(config.enabled).toBe(false);
    expect(config.central).toBe(false);
  });
});

describe("mirror tiles with the central login", () => {
  const central = { name: "Lasse", roleId: "audio", admin: true, sessionId: "s", version: "v", expiresAt: Date.now() + 60_000 };

  it("mirrors the tile's role, not the role of the central login", () => {
    const config = resolveAutoLoginConfiguration(
      "?autoLogin=1&username=Multiview&roleId=stage-left&secondary=1",
      roles,
      central,
    );
    expect(centralMirrorFor(config)).toEqual({ roleId: "stage-left", username: "Multiview" });
    expect(urlRequestsMirror("?autoLogin=1&username=Multiview&roleId=stage-left&secondary=1")).toBe(true);
  });

  it("uses the normal central login without a mirror request", () => {
    expect(centralMirrorFor(resolveAutoLoginConfiguration("", roles, { ...central, admin: false, ...SESSION }))).toBeUndefined();
    expect(centralMirrorFor(resolveAutoLoginConfiguration("?autoLogin=1&username=FOH&roleId=audio", roles, central))).toBeUndefined();
    expect(urlRequestsMirror("?autoLogin=1&username=FOH&roleId=audio")).toBe(false);
  });
});

describe("autoLoginRetryDelay", () => {
  const tile = resolveAutoLoginConfiguration("?autoLogin=1&username=Multiview&roleId=audio&secondary=1", roles);

  it("signs the Multiview tile in again with a growing pause", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map((n) => autoLoginRetryDelay(tile, n))).toEqual([
      5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000,
    ]);
  });

  it("never retries for stations, the central login or without auto-login", () => {
    expect(autoLoginRetryDelay(resolveAutoLoginConfiguration("?autoLogin=1&username=Pi&roleId=audio&autoTakeover=1", roles), 0)).toBeNull();
    expect(autoLoginRetryDelay(resolveAutoLoginConfiguration("", roles, { name: "Tim", roleId: "audio", admin: false, ...SESSION }), 0)).toBeNull();
    expect(autoLoginRetryDelay(resolveAutoLoginConfiguration("", roles), 0)).toBeNull();
  });
});
