import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/**
 * Der Geräteschlüssel darf nur an JMS Control auf demselben Rechner (Loopback, unverschlüsselt erlaubt,
 * so akzeptiert ihn auch der Server) oder an eine HTTPS-Adresse gehen.
 */
export function trustedBase(host: string, port: number): string {
  const loopback = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/.test(host);
  const url = new URL(`${loopback ? "http" : "https"}://${host}:${port}`);
  if (url.username || url.password) throw new Error("Ungültige Adresse");
  return url.origin;
}

export function readDeviceKey(): string {
  const entrypoint = process.argv[1];
  const filename =
    process.env.JMS_DEVICE_KEY_FILE ||
    (entrypoint && isAbsolute(entrypoint) ? join(dirname(entrypoint), "jms-device.key") : "");
  if (!filename || !isAbsolute(filename)) throw new Error("Geräteschlüssel-Datei nicht gefunden");
  const metadata = lstatSync(filename);
  if (!metadata.isFile() || (metadata.mode & 0o027) !== 0 || metadata.size > 512)
    throw new Error("Geräteschlüssel-Datei hat falsche Rechte");
  const key = readFileSync(filename, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error("Geräteschlüssel ungültig");
  return key;
}

export async function request(base: string, key: string, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = { "X-JMS-Device-Key": key, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  const answer = await response.json().catch(() => null);
  if (!response.ok) {
    const error = answer && typeof answer === "object" && "error" in answer ? String((answer as { error: unknown }).error) : "";
    throw new Error(`${response.status} ${error || response.statusText}`.trim());
  }
  return answer;
}
