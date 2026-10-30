import { getGlobalApiBaseUrl, isUnauthorizedError } from "../api";
import { tokenStorageKey } from "../app/settings";
import type { LoginSuccess } from "../types";
import { urlRequestsMirror } from "./autoLogin";
import { discardBody } from "./responseBody";

/**
 * Central login of the JMS server (served by the Multiview, routed by Caddy
 * under /.jms-auth on every service address). Whoever is signed in there with
 * name + role is signed in to Kesher with the same role; the admin is Kesher's
 * admin. Only for the web UI served from the server itself – the desktop app
 * talks to a configured server address and keeps its own login.
 */
export type CentralIdentity = {
  name: string;
  roleId: string;
  admin: boolean;
  sessionId: string;
  version: string;
  expiresAt: number;
};

const BASE = "/.jms-auth";
const sessionIdentityStorageKey = "intercom-central-identity";

/** Compares central identities: name, role and admin. */
export function centralIdentityKey(identity: CentralIdentity | null): string {
  return identity ? `${identity.name}|${identity.roleId}|${identity.admin}|${identity.sessionId}|${identity.version}|${identity.expiresAt}` : "";
}

/**
 * Stores the Kesher token together with the central identity it was opened
 * for. After a reload the tab only keeps its session while the central login
 * is still the same – otherwise it would stay e.g. "Licht 1" after signing in
 * centrally as admin.
 */
export function storeSessionToken(token: string, identity: CentralIdentity | null): void {
  // Kesher-Kacheln in JMS Control teilen sich im Tab dieselbe Ablage (gleiche Adresse): Ein
  // Spiegel merkt sich seine Sitzung nicht – sonst übernähme die nächste Kachel sie (andere
  // Rolle) oder sie gälte beim Neuladen als Admin-Sitzung der angemeldeten Person
  if (urlRequestsMirror(window.location.search)) return;
  sessionStorage.setItem(tokenStorageKey, token);
  sessionStorage.setItem(sessionIdentityStorageKey, centralIdentityKey(identity));
}

/** Central identity the stored token was opened for ("" = none). */
export function storedSessionIdentityKey(): string {
  return sessionStorage.getItem(sessionIdentityStorageKey) ?? "";
}

/**
 * What happens to the Kesher token stored in this tab once the central login
 * is known: kept only for the same central identity, and never when the tab
 * was opened to remote-control a Raspberry Pi (?login=raspberry) – the
 * station selection must show up instead of the own intercom session.
 */
export function resolveStoredTokenRestore(options: {
  storedToken: string | null;
  storedIdentityKey: string;
  identity: CentralIdentity | null;
  raspberryRemoteLogin: boolean;
}): "none" | "keep" | "discard" {
  if (!options.storedToken) return "none";
  if (options.raspberryRemoteLogin) return "discard";
  return options.storedIdentityKey === centralIdentityKey(options.identity)
    ? "keep"
    : "discard";
}

export function centralLoginAvailable(): boolean {
  return getGlobalApiBaseUrl() === "" && typeof window !== "undefined";
}

/** Who is signed in centrally – null without central login (or not signed in). */
export async function fetchCentralIdentity(): Promise<CentralIdentity | null> {
  if (!centralLoginAvailable()) return null;
  try {
    const res = await fetch(`${BASE}/api/me`, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!res.ok || !res.headers.get("content-type")?.includes("json")) {
      discardBody(res);
      return null;
    }
    const data = (await res.json()) as {
      user?: Partial<CentralIdentity> & { open?: boolean } | null;
    };
    const user = data?.user;
    if (!user || user.open || !user.name || !user.roleId || !user.sessionId || !user.version || !user.expiresAt || user.expiresAt <= Date.now()) return null;
    return { name: user.name, roleId: user.roleId, admin: Boolean(user.admin), sessionId: user.sessionId, version: user.version, expiresAt: user.expiresAt };
  } catch {
    return null;
  }
}

/**
 * Mirror of a role (Kesher tile in JMS Control): the tile only shows and controls the device
 * that really uses the role and never occupies it. The Multiview signs the role into the ticket
 * only if the signed-in person may see a tile with that role.
 */
export type CentralMirror = { roleId: string; username: string };

/** Kesher session for whoever is signed in centrally (signed ticket, no PIN) – or a mirror. */
export async function centralSessionLogin(mirror?: CentralMirror): Promise<LoginSuccess> {
  const query = new URLSearchParams({ aud: "kesher" });
  if (mirror) query.set("mirror", mirror.roleId);
  const ticketRes = await fetch(`${BASE}/api/ticket?${query}`, {
    cache: "no-store",
    credentials: "same-origin",
  });
  const ticketData = (await ticketRes.json().catch(() => ({}))) as {
    ticket?: string;
    error?: string;
  };
  if (!ticketRes.ok || !ticketData.ticket) {
    throw new Error(ticketData.error || "Zentrale Anmeldung nicht möglich.");
  }
  const res = await fetch("/api/login/central", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      mirror
        ? { ticket: ticketData.ticket, secondary: true, username: mirror.username }
        : { ticket: ticketData.ticket },
    ),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as LoginSuccess;
}

export function centralLoginUrl(next = "/"): string {
  return `${BASE}/login?next=${encodeURIComponent(next)}`;
}

/** An expired gateway session requires login, not an offline screen or retries. */
export function redirectToCentralLoginOnUnauthorized(error: unknown): boolean {
  if (!centralLoginAvailable() || !isUnauthorizedError(error)) return false;
  window.location.replace(centralLoginUrl(window.location.pathname + window.location.search));
  return true;
}

/**
 * Signs out centrally (name + role on all services) and opens the login page.
 * The server only accepts POST for signing out (no GET link to /logout).
 */
export async function centralLogout(): Promise<void> {
  await fetch(`${BASE}/api/logout`, {
    method: "POST",
    credentials: "same-origin",
  }).catch(() => undefined);
  window.location.assign(`${BASE}/login`);
}
