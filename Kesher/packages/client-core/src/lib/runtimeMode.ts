export function resolveLowPowerMode(search: string): boolean {
  const value = new URLSearchParams(search).get("lowPower");
  return value === "1" || value === "true";
}

export function resolveViewModeOverride(
  search: string,
): "simple" | "station" | null {
  const value = new URLSearchParams(search).get("viewMode");
  if (value === "simple" || value === "station") return value;
  return null;
}
