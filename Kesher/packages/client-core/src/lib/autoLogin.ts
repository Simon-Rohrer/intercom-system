import type { Role } from "../types";
import type { CentralIdentity } from "./centralLogin";
import { resolveRaspberryRemoteLogin } from "./runtimeMode";

export type AutoLoginConfiguration = {
  enabled: boolean;
  username: string;
  roleId: string;
  requestedRole: string;
  allowTakeover: boolean;
  /** Additional device that does not occupy the role (e.g. the Multiview tile). */
  secondary: boolean;
  /** Name and role come from the server's central login. */
  central: boolean;
};

/**
 * Auto-login from the URL (fixed devices, the Multiview tile) or – without
 * URL parameters – from the central login. A role taken centrally is never
 * taken over automatically: another device may hold it in Kesher.
 */
export function resolveAutoLoginConfiguration(
  search: string,
  roles: Role[],
  central: CentralIdentity | null = null,
): AutoLoginConfiguration {
  const params = new URLSearchParams(search);
  // Opened to remote-control a Raspberry Pi: stay on the login screen
  if (resolveRaspberryRemoteLogin(search)) {
    return {
      enabled: false,
      username: "",
      roleId: "",
      requestedRole: "",
      allowTakeover: false,
      secondary: false,
      central: false,
    };
  }
  const enabled =
    params.get("autoLogin") === "1" || params.get("autoLogin") === "true";
  if (!enabled && central && !central.admin) {
    return {
      enabled: true,
      username: central.name.trim(),
      roleId: roles.find((role) => role.id === central.roleId)?.id || "",
      requestedRole: central.roleId,
      allowTakeover: false,
      secondary: false,
      central: true,
    };
  }
  const username = (params.get("username") || "").trim();
  const requestedRoleId = (params.get("roleId") || "").trim();
  const requestedRoleName = (params.get("roleName") || "").trim();
  const allowTakeover =
    params.get("autoTakeover") === "1" ||
    params.get("autoTakeover") === "true";

  const secondary =
    params.get("secondary") === "1" || params.get("secondary") === "true";

  let roleId = "";
  if (requestedRoleId) {
    roleId = roles.find((role) => role.id === requestedRoleId)?.id || "";
  } else if (requestedRoleName) {
    roleId =
      roles.find(
        (role) =>
          role.name.toLowerCase() === requestedRoleName.toLowerCase(),
      )?.id || "";
  }

  return {
    enabled,
    username,
    roleId,
    requestedRole: requestedRoleId || requestedRoleName,
    allowTakeover,
    secondary,
    central: false,
  };
}

/** Mirror login for the central login: only for a tile opened as secondary device via the URL. */
export function centralMirrorFor(
  config: AutoLoginConfiguration,
): { roleId: string; username: string } | undefined {
  if (!config.enabled || config.central || !config.secondary || !config.roleId || !config.username) {
    return undefined;
  }
  return { roleId: config.roleId, username: config.username };
}

/** Opened as a mirror via the URL (?autoLogin=1&secondary=1&roleId=…), before the roles are loaded. */
export function urlRequestsMirror(search: string): boolean {
  const params = new URLSearchParams(search);
  const on = (key: string) => params.get(key) === "1" || params.get(key) === "true";
  return on("autoLogin") && on("secondary") && Boolean((params.get("roleId") || params.get("roleName") || "").trim());
}

/**
 * Wartezeit vor dem nächsten automatischen Anmeldeversuch einer Kesher-Kachel
 * (Spiegel), die abgemeldet wurde: 2 s, 5 s, 10 s, 20 s, 30 s, danach jede Minute.
 */
export function mirrorReloginDelayMs(attempt: number): number {
  const steps = [2_000, 5_000, 10_000, 20_000, 30_000];
  if (!Number.isFinite(attempt) || attempt < 0) return steps[0];
  return steps[Math.floor(attempt)] ?? 60_000;
}

/**
 * Lehnt der Server eine Anfrage einmal mit 401 ab, ist die Sitzung nicht unbedingt
 * vorbei: Kesher prüft jede Anfrage eines festen Geräts bei JMS Control nach, und
 * antwortet JMS Control kurz zu langsam (Zeitlimit 750 ms), kommt ein einzelnes 401.
 * Früher meldete sich die Kachel dann sofort neu an – neue Sitzung, Verbindung zu,
 * „Verbinden …“. Erst wenn die Sitzung bei jedem weiteren Versuch abgelehnt wird,
 * gilt sie als beendet (true). Antwortet der Server gar nicht, bleibt sie (false).
 */
export async function confirmSessionRejected(
  check: () => Promise<unknown>,
  isUnauthorized: (error: unknown) => boolean,
  options: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const attempts = Math.max(1, options.attempts ?? 2);
  const delayMs = options.delayMs ?? 1500;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(delayMs * (attempt + 1));
    try {
      await check();
      return false;
    } catch (error) {
      if (!isUnauthorized(error)) return false;
    }
  }
  return true;
}

/** Nachricht einer eingebetteten Kesher-Kachel an JMS Control (Fenster darüber). */
export type EmbedSessionMessage = {
  type: "kesher:session";
  signedIn: boolean;
  connection: string;
};

/** Meldet JMS Control, ob die Kachel angemeldet ist – nur in einem eingebetteten Fenster. */
export function postEmbedSessionState(
  target: Pick<Window, "postMessage"> | null,
  signedIn: boolean,
  connection: string,
): void {
  if (!target) return;
  const message: EmbedSessionMessage = { type: "kesher:session", signedIn, connection };
  try {
    // Nur ein Ja/Nein ohne Namen oder Token – JMS Control läuft auf einem anderen Port
    target.postMessage(message, "*");
  } catch {
    // Fenster darüber schon geschlossen
  }
}
