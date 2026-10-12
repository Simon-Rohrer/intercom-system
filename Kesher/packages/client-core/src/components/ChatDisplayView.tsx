import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BrandLogo } from "./BrandLogo";

type ChatDisplayEntry = {
  from: string;
  fromUserId: string;
  fromRoleId?: string;
  body: string;
  at: string;
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

function shortTime(at: string): string {
  const match = at.match(/^(\d{1,2}):(\d{2})/);
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : at;
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
            const target =
              entry.scope === "global"
                ? "Global"
                : entry.scope === "direct"
                  ? "Direkt"
                  : entry.room;
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
                  ) : null}
                  {needsAck ? (
                    <span className="chat-display-ack">Bestätigung erwartet</span>
                  ) : null}
                  <time>{shortTime(entry.at)}</time>
                </div>
                <p className="chat-display-body">{entry.body}</p>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
