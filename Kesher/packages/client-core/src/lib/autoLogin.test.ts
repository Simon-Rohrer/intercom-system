import { describe, expect, it } from "vitest";
import { resolveAutoLoginConfiguration } from "./autoLogin";

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
      { name: "Tim", roleId: "audio", admin: false },
    );
    expect(config.username).toBe("FOH");
    expect(config.central).toBe(false);
  });

  it("ignores the central admin and unknown central roles", () => {
    expect(
      resolveAutoLoginConfiguration("", roles, { name: "Simon", roleId: "admin", admin: true }).enabled,
    ).toBe(false);
    const unknown = resolveAutoLoginConfiguration("", roles, {
      name: "Tim",
      roleId: "gibts-nicht",
      admin: false,
    });
    expect(unknown.enabled).toBe(true);
    expect(unknown.roleId).toBe("");
  });
});
