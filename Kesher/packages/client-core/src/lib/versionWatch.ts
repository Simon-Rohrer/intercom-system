import { getGlobalApiBaseUrl } from "../api";

/** Built scripts and styles of a page (e.g. "/assets/index-E5zoNbc9.js"), sorted. */
export function assetSignature(html: string): string {
  const found = new Set<string>();
  for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)) {
    found.add(match[1]);
  }
  return [...found].sort().join("|");
}

/**
 * After an update of the server the open page keeps running the old version until
 * someone reloads it – also the Kesher tiles in JMS Control, which nobody can reload by
 * hand on a kiosk. Every 30 s (and when the tab becomes visible) this compares the
 * built files of the page with the ones of this tab and reloads once they differ.
 * Only for the web UI served by the server itself (not the desktop app, not dev mode).
 */
export function watchForNewVersion(onNewVersion: () => void = () => window.location.reload()): () => void {
  if (typeof window === "undefined" || getGlobalApiBaseUrl() !== "") return () => undefined;
  const current = assetSignature(document.documentElement.outerHTML);
  if (!current) return () => undefined;
  let busy = false;
  let done = false;
  const check = async () => {
    if (busy || done) return;
    busy = true;
    try {
      const res = await fetch(`/?version-check=${Date.now()}`, { cache: "no-store", credentials: "same-origin" });
      if (!res.ok || !res.headers.get("content-type")?.includes("html")) return;
      const next = assetSignature(await res.text());
      if (next && next !== current) {
        done = true;
        onNewVersion();
      }
    } catch {
      // server briefly unreachable (e.g. while it restarts) – try again later
    } finally {
      busy = false;
    }
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") void check();
  };
  document.addEventListener("visibilitychange", onVisible);
  const timer = window.setInterval(() => void check(), 30_000);
  return () => {
    document.removeEventListener("visibilitychange", onVisible);
    window.clearInterval(timer);
  };
}
