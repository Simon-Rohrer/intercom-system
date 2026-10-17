/**
 * Shared rules of the JMS services' sidebar (same in JMS Control, Dashboard,
 * Kesher): where "Dashboard" leads, where "Konto wechseln" leads, initials.
 */

type HostLocation = Pick<Location, "hostname">;

/** The JMS dashboard for the address this page was opened on. */
export function dashboardUrl(loc: HostLocation = window.location): string {
  const host = loc.hostname.toLowerCase();
  if (host.endsWith(".local")) return "https://technik.local/";
  if (host.endsWith(".jms.de")) return "https://dashboard.jms.de/";
  return `https://${loc.hostname}:3000/`;
}

/** Central login page to switch account or role, back to `next` afterwards. */
export function switchAccountUrl(next: string): string {
  return `/.jms-auth/login?wechseln=1&next=${encodeURIComponent(next)}`;
}

/** Tauri desktop app (has no dashboard and no central login). */
export function isDesktopApp(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return (
    "__TAURI__" in w ||
    "__TAURI_INTERNALS__" in w ||
    typeof w.__TAURI_PLUGIN__ !== "undefined" ||
    /\bTauri\b/i.test(navigator.userAgent || "")
  );
}

/** Initials like in JMS Control: first letters of the first two words ("Tim FOH" → "TF"). */
export function userInitials(name: string): string {
  return (
    String(name || "?")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => (word[0] ?? "").toUpperCase())
      .join("") || "?"
  );
}
