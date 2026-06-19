import type { Role } from "../types";

export type AutoLoginConfiguration = {
  enabled: boolean;
  username: string;
  roleId: string;
  requestedRole: string;
  allowTakeover: boolean;
};

export function resolveAutoLoginConfiguration(
  search: string,
  roles: Role[],
): AutoLoginConfiguration {
  const params = new URLSearchParams(search);
  const enabled =
    params.get("autoLogin") === "1" || params.get("autoLogin") === "true";
  const username = (params.get("username") || "").trim();
  const requestedRoleId = (params.get("roleId") || "").trim();
  const requestedRoleName = (params.get("roleName") || "").trim();
  const allowTakeover =
    params.get("autoTakeover") === "1" ||
    params.get("autoTakeover") === "true";

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
  };
}
