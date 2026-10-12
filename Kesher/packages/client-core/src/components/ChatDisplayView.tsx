import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BrandLogo } from "./BrandLogo";

type ChatDisplayEntry = {
  from: string;
  fromUserId: string;
  fromRoleId?: string;
  body: string;
  at: string;
  timestamp?: number;
  room: string;
  self: boolean;
  scope: "direct" | "room" | "broadcast" | "global";
  targetId: string;
  messageId?: string;
  ackRequired?: boolean;
  acked?: boolean;
  source?: string;
};

type ChatDisplayViewProps = {
  connectionState: "connecting" | "connected" | "reconnecting" | "offline";
  chatMessages: ChatDisplayEntry[];
  listenRoomIds: string[];
  roles: Array<{ id: string; name: string }>;
  stationName: string;
};

/** Messages older than this stay in the feed but are dimmed. */
const RECENT_MS = 5 * 60 * 1000;
/** Only Stream Deck messages this fresh flash; history after a reload does not. */
const FLASH_MAX_AGE_MS = 15 * 1000;
/** Matches the attention-call-multi-flash animation of the station call flash. */
const FLASH_DURATION_MS = 3800;

type DisplayFlash = { key: string; title: string; detail: string };

function shortTime(entry: Pick<ChatDisplayEntry, "at" | "timestamp">): string {
  // `at` is formatted in the browser locale (e.g. "4:48:12 PM" in a kiosk
  // without German locale); prefer the server timestamp for a 24h clock.
  if (entry.timestamp) {
    return new Date(entry.timestamp).toLocaleTimeString("de-DE", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  const match = entry.at.match(/^(\d{1,2}):(\d{2})/);
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : entry.at;
}

function targetLabel(entry: Pick<ChatDisplayEntry, "scope" | "room">): string {
  return entry.scope === "global"
    ? "Global"
    : entry.scope === "direct"
      ? "Direkt"
      : entry.room;
}

function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Read-only, full-screen chat feed for a monitor (e.g. the server's HDMI
 * output). Opened with `?viewMode=chat`; never asks for a microphone.
 */
export function ChatDisplayView({
  connectionState,
  chatMessages,
  listenRoomIds,
  roles,
  stationName,
}: ChatDisplayViewProps) {
  const clock = useClock();
  const feedRef = useRef<HTMLOListElement>(null);
  const firstSeenRef = useRef(new Map<string, number>());
  const flashedKeysRef = useRef(new Set<string>());
  const [flash, setFlash] = useState<DisplayFlash | null>(null);
  const roleNameById = useMemo(
    () => new Map(roles.map((role) => [role.id, role.name])),
    [roles],
  );

  // Same visibility rule as the station chat; newest messages arrive first.
  const feed = useMemo(
    () =>
      chatMessages
        .filter(
          (entry) =>
            entry.self ||
            entry.scope !== "room" ||
            listenRoomIds.includes(entry.targetId),
        )
        .slice(0, 60)
        .reverse(),
    [chatMessages, listenRoomIds],
  );

  const now = Date.now();
  const keyFor = (entry: ChatDisplayEntry) =>
    entry.messageId || `${entry.at}|${entry.fromUserId}|${entry.scope}|${entry.body}`;
  for (const entry of feed) {
    const key = keyFor(entry);
    if (!firstSeenRef.current.has(key)) firstSeenRef.current.set(key, now);
  }

  useLayoutEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [feed]);

  // A message sent from a Stream Deck flashes the screen like a call.
  useEffect(() => {
    const now = Date.now();
    let newest: ChatDisplayEntry | undefined;
    for (const entry of feed) {
      if (entry.source !== "companion" || !entry.timestamp) continue;
      if (now - entry.timestamp > FLASH_MAX_AGE_MS) continue;
      const key = keyFor(entry);
      if (flashedKeysRef.current.has(key)) continue;
      flashedKeysRef.current.add(key);
      newest = entry;
    }
    if (!newest) return;
    const roleName = newest.fromRoleId
      ? roleNameById.get(newest.fromRoleId) || newest.fromRoleId
      : "";
    const sender =
      roleName && roleName !== newest.from ? `${newest.from} · ${roleName}` : newest.from;
    setFlash({
      key: keyFor(newest),
      title: `Stream Deck · ${targetLabel(newest)}`,
      detail: `${sender}: ${newest.body}`,
    });
  }, [feed, roleNameById]);

  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), FLASH_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const live = connectionState === "connected";

  return (
    <div className="root chat-display-shell">
      <header className="chat-display-header">
        <BrandLogo className="chat-display-logo" />
        <span className="chat-display-sep" aria-hidden="true" />
        <div className="chat-display-title">
          <strong>Intercom-Chat</strong>
          <span>{stationName}</span>
        </div>
        <span className={`chat-display-live ${live ? "connected" : "disconnected"}`}>
          <span className="chat-display-live-dot" />
          {live
            ? "Live"
            : connectionState === "offline"
              ? "Offline"
              : "Verbinde …"}
        </span>
        <time className="chat-display-clock">{clock}</time>
      </header>

      {feed.length === 0 ? (
        <p className="chat-display-empty">Noch keine Nachrichten.</p>
      ) : (
        <ol className="chat-display-feed" ref={feedRef} aria-live="polite">
          {feed.map((entry, index) => {
            const key = keyFor(entry);
            const seenAt = firstSeenRef.current.get(key) ?? now;
            const isNewest = index === feed.length - 1;
            const isOld = now - seenAt > RECENT_MS && !isNewest;
            const roleName = entry.fromRoleId
              ? roleNameById.get(entry.fromRoleId) || entry.fromRoleId
              : "";
            const needsAck = entry.ackRequired && !entry.acked;
            const target = targetLabel(entry);
            return (
              <li
                key={key}
                className={[
                  "chat-display-message",
                  `scope-${entry.scope}`,
                  isNewest ? "is-newest" : "",
                  isOld ? "is-old" : "",
                  needsAck ? "needs-ack" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <div className="chat-display-meta">
                  <strong>{entry.from}</strong>
                  {roleName && roleName !== entry.from ? (
                    <span className="chat-display-role">{roleName}</span>
                  ) : null}
                  <span className="chat-display-target">{target}</span>
                  {entry.source === "telegram" ? (
                    <span className="chat-display-target is-telegram">Telegram</span>
                  ) : entry.source === "companion" ? (
                    <span className="chat-display-target">Stream Deck</span>
                  ) : null}
                  {needsAck ? (
                    <span className="chat-display-ack">Bestätigung erwartet</span>
                  ) : null}
                  <time>{shortTime(entry)}</time>
                </div>
                <p className="chat-display-body">{entry.body}</p>
              </li>
            );
          })}
        </ol>
      )}

      {flash ? (
        <div
          key={flash.key}
          className="attention-flash attention-flash-call chat-display-flash"
          role="status"
          aria-live="assertive"
        >
          <div className="attention-flash-card">
            <strong>{flash.title}</strong>
            <span>{flash.detail}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
