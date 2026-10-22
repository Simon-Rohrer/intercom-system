import { centralLoginAvailable } from "./centralLogin";

/**
 * Ein/Aus (Ruhemodus) und Neu starten der Raspberry Pis aus dem Intercom. Das schaltet
 * JMS Control (Multiview, Einstellung „standby“ der Station) – Kesher fragt dort über
 * /.jms-auth auf der eigenen Adresse nach. Erlaubt nur dem Admin und Rollen mit dem
 * Recht „Raspberry Pis“ (JMS Control → Benutzer & Rechte).
 */
export type PiPowerAction = "on" | "off" | "reboot";

export type PiControlState = {
  allowed: boolean;
  /** Ruhemodus je Geräte-ID; fehlt ein Pi, kennt JMS Control ihn nicht (kein Schalter). */
  standbyByDeviceId: Record<string, boolean>;
};

const CONTROL_URL = "/.jms-auth/api/raspberry-pis/control";

export async function fetchPiControl(signal?: AbortSignal): Promise<PiControlState | null> {
  if (!centralLoginAvailable()) return null;
  try {
    const res = await fetch(CONTROL_URL, { cache: "no-store", credentials: "same-origin", signal });
    if (!res.ok || !res.headers.get("content-type")?.includes("json")) return null;
    const data = (await res.json()) as {
      allowed?: boolean;
      pis?: { deviceId?: unknown; standby?: unknown }[];
    };
    const standbyByDeviceId: Record<string, boolean> = {};
    for (const pi of Array.isArray(data.pis) ? data.pis : []) {
      if (typeof pi.deviceId === "string" && pi.deviceId) {
        standbyByDeviceId[pi.deviceId] = pi.standby === true;
      }
    }
    return { allowed: data.allowed === true, standbyByDeviceId };
  } catch {
    return null;
  }
}

export async function sendPiControl(
  deviceId: string,
  action: PiPowerAction,
): Promise<{ standby: boolean }> {
  const res = await fetch(CONTROL_URL, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId, action }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; standby?: boolean; error?: string };
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return { standby: data.standby === true };
}
