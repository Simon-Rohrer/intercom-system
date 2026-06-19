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
    });
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
});
