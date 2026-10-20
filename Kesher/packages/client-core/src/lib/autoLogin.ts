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
