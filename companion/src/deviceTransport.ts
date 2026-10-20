import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { WebSocket as UndiciWebSocket, fetch as undiciFetch } from "undici";

const allowedOrigins = new Set([
  "https://192.168.0.21:8443",
  "https://intercom.local",
  "https://kesher.local",
  "https://intercom.jms.de",
  "https://kesher.jms.de",
]);

export function deviceHeaders(address: string): Record<string, string> {
  const url = new URL(address);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol !== "https:" || url.username || url.password || !allowedOrigins.has(url.origin)) {
    throw new Error("Device credentials require an explicitly trusted HTTPS endpoint");
  }
  const entrypoint = process.argv[1];
  const filename = process.env.JMS_DEVICE_KEY_FILE || (entrypoint && isAbsolute(entrypoint) ? join(dirname(entrypoint), "jms-device.key") : "");
  if (!filename || !isAbsolute(filename)) {
    throw new Error("JMS_DEVICE_KEY_FILE must identify the protected service credential file");
  }
  let credential: string;
  try {
    const metadata = lstatSync(filename);
    if (!metadata.isFile() || (metadata.mode & 0o027) !== 0 || metadata.size > 512) {
      throw new Error("invalid credential file");
    }
    credential = readFileSync(filename, "utf8").trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) {
      throw new Error("invalid credential format");
    }
  } catch {
    throw new Error("The protected JMS device credential is missing or invalid");
  }
  return { "X-JMS-Device-Key": credential };
}

export function deviceFetch(address: string) {
  return undiciFetch(address, { headers: deviceHeaders(address), redirect: "error" });
}

export function deviceWebSocket(address: string): WebSocket {
  if (new URL(address).protocol !== "wss:") {
    throw new Error("Device WebSockets require WSS");
  }
  return new UndiciWebSocket(address, { headers: deviceHeaders(address) }) as unknown as WebSocket;
}
