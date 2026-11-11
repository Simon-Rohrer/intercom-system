import { describe, expect, it } from "vitest";
import {
  centralMirrorFor,
  confirmSessionRejected,
  mirrorReloginDelayMs,
  postEmbedSessionState,
  resolveAutoLoginConfiguration,
  urlRequestsMirror,
} from "./autoLogin";

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

describe("Wiederanmeldung der Kesher-Kachel", () => {
  const unauthorized = Object.assign(new Error("401"), { status: 401 });
  const isUnauthorized = (error: unknown) =>
    (error as { status?: number } | null)?.status === 401;
  const noWait = async () => undefined;

  it("wartet mit wachsendem Abstand, höchstens eine Minute", () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(mirrorReloginDelayMs)).toEqual([
      2_000, 5_000, 10_000, 20_000, 30_000, 60_000, 60_000,
    ]);
    expect(mirrorReloginDelayMs(-1)).toBe(2_000);
  });

  it("behält die Sitzung, wenn nur eine einzelne Anfrage abgelehnt wurde", async () => {
    let calls = 0;
    const rejected = await confirmSessionRejected(
      async () => {
        calls += 1;
        return { ok: true };
      },
      isUnauthorized,
      { sleep: noWait },
    );
    expect(rejected).toBe(false);
    expect(calls).toBe(1);
  });

  it("meldet neu an, wenn die Sitzung bei jedem Versuch abgelehnt wird", async () => {
    const delays: number[] = [];
    const rejected = await confirmSessionRejected(
      async () => {
        throw unauthorized;
      },
      isUnauthorized,
      { sleep: async (ms) => void delays.push(ms) },
    );
    expect(rejected).toBe(true);
    expect(delays).toEqual([1500, 3000]);
  });

  it("wertet einen nicht erreichbaren Server nicht als Abmeldung", async () => {
    const rejected = await confirmSessionRejected(
      async () => {
        throw new TypeError("Failed to fetch");
      },
      isUnauthorized,
      { sleep: noWait },
    );
    expect(rejected).toBe(false);
  });

  it("meldet JMS Control nur angemeldet ja/nein, ohne Namen oder Token", () => {
    const sent: unknown[] = [];
    postEmbedSessionState({ postMessage: (message: unknown) => void sent.push(message) } as Window, false, "offline");
    expect(sent).toEqual([{ type: "kesher:session", signedIn: false, connection: "offline" }]);
    expect(() => postEmbedSessionState(null, true, "connected")).not.toThrow();
  });

  it("erkennt die Kachel als Spiegel (nur dann automatische Wiederanmeldung)", () => {
    expect(urlRequestsMirror("?autoLogin=1&secondary=1&roleId=lighting&username=Multiview")).toBe(true);
    expect(urlRequestsMirror("?autoLogin=1&roleId=lighting&username=Licht")).toBe(false);
  });
});
