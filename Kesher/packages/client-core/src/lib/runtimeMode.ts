export function resolveLowPowerMode(search: string): boolean {
  const value = new URLSearchParams(search).get("lowPower");
  return value === "1" || value === "true";
}

export function resolveViewModeOverride(
  search: string,
): "simple" | "station" | "chat" | null {
  const value = new URLSearchParams(search).get("viewMode");
  if (value === "simple" || value === "station" || value === "chat") {
    return value;
  }
  return null;
}

/**
 * Embedded as a window inside another page (e.g. a Multiview tile): the
 * station view then fits everything into the window instead of scrolling.
 */
export function resolveEmbedMode(search: string): boolean {
  const value = new URLSearchParams(search).get("embed");
  return value === "1" || value === "true";
}

/** `controls=0` hides Hold to talk, Reply to caller and Always on. */
export function resolveHideTalkControls(search: string): boolean {
  const value = new URLSearchParams(search).get("controls");
  return value === "0" || value === "false";
}

/**
 * `login=raspberry` opens the login screen on the Raspberry tab (remote
 * control of a Pi station, e.g. from the dashboard) and skips any automatic
 * login, including the central one.
 */
export function resolveRaspberryRemoteLogin(search: string): boolean {
  return new URLSearchParams(search).get("login") === "raspberry";
}
