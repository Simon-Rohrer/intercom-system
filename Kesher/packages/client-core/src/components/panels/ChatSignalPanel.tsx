import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatTarget } from "../../types";
import { useFreshAlerts } from "../../lib/freshAlerts";

type ChatEntry = {
  from: string;
  fromUserId: string;
  body: string;
  at: string;
  room: string;
  self: boolean;
  scope: "direct" | "room" | "broadcast" | "global";
  targetId: string;
  targetType?: "room" | "user" | "role" | "global";
  messageId?: string;
  ackRequired?: boolean;
  acked?: boolean;
  ackedBy?: string;
  ackedAt?: string;
  source?: string;
};

type AutocompleteItem = {
  key: string;
  label: string;
  displayLabel: string;
  insertText: string;
  type: "user" | "role" | "room";
};

type ChatSignalPanelProps = {
  message: string;
  onMessageChange: (value: string) => void;
  onSendChat: (target: ChatTarget, ackRequired?: boolean) => void;
  onAcknowledge: (messageId: string, senderUserId: string) => void;
  showAckOption?: boolean;
  chatMessages: ChatEntry[];
  listenRoomIds: string[];
  rooms: Array<{ id: string; name: string }>;
  roles: Array<{ id: string; name: string }>;
  activeUsers: Array<{
    userId: string;
    username: string;
    roleId: string;
    roleName: string;
    isWebOnline?: boolean;
  }>;
  /** Stream Deck message to flash inside the chat (docked or popped out). */
  /** Changes with every new chat message: the chat border flashes once. */
  attentionKey?: number | null;
};

function autocompleteContext(value: string, caret: number) {
  const left = value.slice(0, caret);
  const match = left.match(/(^|\s)([@#][^\s@#]*)$/);
  if (!match) {
    return null;
  }
  const token = match[2] || "";
  const trigger = token[0] as "@" | "#";
  const query = token.slice(1).toLowerCase();
  const tokenStart = left.length - token.length;
  return {
    trigger,
    query,
    tokenStart,
    tokenEnd: caret,
  };
}

export function ChatSignalPanel({
  message,
  onMessageChange,
  onSendChat,
  onAcknowledge,
  showAckOption = true,
  chatMessages,
  listenRoomIds,
  rooms,
  roles,
  activeUsers,
  attentionKey = null,
}: ChatSignalPanelProps) {
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [caret, setCaret] = useState(message.length);
  const [requiresAck, setRequiresAck] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState("global:global");

  const availableTargetValues = useMemo(
    () =>
      new Set([
        "global:global",
        ...rooms.map((room) => `room:${room.id}`),
        ...activeUsers
          .filter((user) => user.isWebOnline !== false)
          .map((user) => `direct:${user.userId}`),
      ]),
    [activeUsers, rooms],
  );

  useEffect(() => {
    if (!availableTargetValues.has(selectedTarget)) {
      setSelectedTarget("global:global");
    }
  }, [availableTargetValues, selectedTarget]);

  function currentChatTarget(): ChatTarget {
    const separatorIndex = selectedTarget.indexOf(":");
    const scope = selectedTarget.slice(0, separatorIndex);
    const targetId = selectedTarget.slice(separatorIndex + 1);
    if (scope === "room" && targetId) {
      return { scope: "room", targetType: "room", targetId };
    }
    if (scope === "direct" && targetId) {
      return { scope: "direct", targetType: "user", targetId };
    }
    return { scope: "global", targetType: "global", targetId: "global" };
  }

  function submitChat() {
    onSendChat(currentChatTarget(), showAckOption ? requiresAck : false);
    if (message.trim()) {
      setRequiresAck(false);
    }
  }

  const visibleMessages = useMemo(
    () =>
      chatMessages.filter(
        (entry) =>
          entry.self ||
          entry.scope !== "room" ||
          listenRoomIds.includes(entry.targetId),
      ),
    [chatMessages, listenRoomIds],
  );

  const suggestions = useMemo(() => {
    const context = autocompleteContext(message, caret);
    if (!context) {
      return [] as AutocompleteItem[];
    }

    // Keep the initial @ list focused on online users, but allow finding
    // external/telegram users once a specific query is typed.
    const onlineUsers = activeUsers.filter((u) => u.isWebOnline !== false);
    const externalUsers = activeUsers.filter((u) => u.isWebOnline === false);

    if (context.trigger === "@") {
      // Build user suggestions (online users only)
      const userItems = onlineUsers
        .filter((u) => u.username.toLowerCase().includes(context.query))
        .map((u) => ({
          key: `user:${u.userId}`,
          label: `👤 @${u.username} [${u.roleName}]`,
          displayLabel: `@${u.username} [${u.roleName}]`,
          insertText: `@${u.username} `,
          type: "user" as const,
        }));

      const externalUserItems =
        context.query.length > 0
          ? externalUsers
              .filter((u) => u.username.toLowerCase().includes(context.query))
              .map((u) => ({
                key: `external-user:${u.userId}`,
                label: `👤 @${u.username} [${u.roleName}] (Telegram/extern)`,
                displayLabel: `@${u.username} [${u.roleName}] (Telegram/extern)`,
                insertText: `@${u.username} `,
                type: "user" as const,
              }))
          : [];

      // Build role suggestions with current occupant or "Unbesetzt"
      const roleItems = roles
        .filter(
          (r) =>
            r.name.toLowerCase().includes(context.query) ||
            r.id.toLowerCase().includes(context.query),
        )
        .map((r) => {
          const occupant = onlineUsers.find((u) => u.roleId === r.id);
          const occupantText = occupant
            ? `Aktuell: ${occupant.username}`
            : "Unbesetzt";
          return {
            key: `role:${r.id}`,
            label: `🎭 @${r.name} (${occupantText})`,
            displayLabel: `@${r.name} (${occupantText})`,
            insertText: `@${r.name} `,
            type: "role" as const,
          };
        });

      return [...userItems, ...externalUserItems, ...roleItems].slice(0, 8);
    }

    // # trigger: rooms/partylines
    return rooms
      .filter(
        (room) =>
          room.name.toLowerCase().includes(context.query) ||
          room.id.toLowerCase().includes(context.query),
      )
      .map((room) => ({
        key: `room:${room.id}`,
        label: `#${room.name}`,
        displayLabel: `#${room.name}`,
        insertText: `#${room.name} `,
        type: "room" as const,
      }))
      .slice(0, 8);
  }, [activeUsers, caret, message, roles, rooms]);

  function applySuggestion(item: AutocompleteItem) {
    const context = autocompleteContext(message, caret);
    if (!context) {
      return;
    }
    const next =
      message.slice(0, context.tokenStart) +
      item.insertText +
      message.slice(context.tokenEnd);
    onMessageChange(next);
    setCaret(context.tokenStart + item.insertText.length);
    setSelectedSuggestion(0);
  }

  function handleSenderReply(username: string, userId?: string) {
    if (userId && availableTargetValues.has(`direct:${userId}`)) {
      setSelectedTarget(`direct:${userId}`);
    }
    onMessageChange(`@${username} `);
    setCaret(username.length + 2);
    inputRef.current?.focus();
  }

  const feedRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stickToBottomRef = useRef(true);
  // Newest messages arrive first; the feed reads top-to-bottom like a messenger.
  const feedMessages = useMemo(
    () => [...visibleMessages].reverse(),
    [visibleMessages],
  );
  // Beamer-/Stage-Meldungen aus JMS Control: nur 15 s rot, dann wie jede andere Nachricht
  const alertState = useFreshAlerts(
    feedMessages,
    (entry) => entry.messageId || `${entry.at}|${entry.fromUserId}|${entry.body}`,
    (entry) => entry.source === "multiview-alert",
  );
  const awaitingMyAck = showAckOption
    ? visibleMessages.filter(
        (entry) => !entry.self && entry.ackRequired && !entry.acked,
      ).length
    : 0;

  useLayoutEffect(() => {
    const feed = feedRef.current;
    if (feed && stickToBottomRef.current) {
      feed.scrollTop = feed.scrollHeight;
    }
  }, [feedMessages]);

  const scopeTag = (entry: ChatEntry) => {
    if (entry.scope === "direct") {
      return (
        <span className="chat-feed-room chat-tag-direct">
          {entry.self ? "Direkt" : "an dich"}
        </span>
      );
    }
    if (entry.scope === "global") {
      return <span className="chat-feed-room global">Global</span>;
    }
    return (
      <span
        className={`chat-feed-room ${entry.scope === "broadcast" ? "chat-tag-broadcast" : "chat-tag-line"}`}
      >
        {entry.room}
      </span>
    );
  };

  const closeSuggestions = () => {
    setSelectedSuggestion(0);
  };

  return (
    <div className="chat-panel-body">
      {attentionKey !== null ? (
        <div key={attentionKey} className="chat-attention-flash" aria-hidden="true" />
      ) : null}
      {awaitingMyAck > 0 ? (
        <button
          type="button"
          className="chat-awaiting-ack"
          onClick={() =>
            feedRef.current
              ?.querySelector(".chat-feed-ack-required")
              ?.scrollIntoView({ block: "center" })
          }
        >
          <span className="chat-awaiting-ack-dot" aria-hidden="true" />
          <strong>{awaitingMyAck}</strong>
          <span className="chat-awaiting-ack-long">
            {awaitingMyAck === 1
              ? " Nachricht wartet auf deine Bestätigung"
              : " Nachrichten warten auf deine Bestätigung"}
          </span>
        </button>
      ) : null}
      <div
        className="chat-feed"
        aria-live="polite"
        ref={feedRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          stickToBottomRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {feedMessages.length === 0 ? (
          <p className="chat-feed-empty">Noch keine Nachrichten.</p>
        ) : (
          <ul className="chat-feed-list">
            {feedMessages.map((entry, index) => {
              const needsMyAck =
                showAckOption && !entry.self && entry.ackRequired && !entry.acked;
              // The latest received message stands out (larger, highlighted).
              const isNewest = !entry.self && index === feedMessages.length - 1;
              const alert = alertState(entry);
              return (
                <li
                  key={`${entry.at}-${entry.from}-${index}`}
                  className={[
                    entry.scope === "direct" ? "chat-feed-direct" : "",
                    entry.scope === "global" ? "chat-feed-global" : "",
                    alert ? "chat-feed-alert" : "",
                    alert === "pop" ? "chat-feed-alert-pop" : "",
                    entry.self ? "self" : "",
                    needsMyAck ? "chat-feed-ack-required" : "",
                    isNewest ? "chat-feed-newest" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <div className="chat-feed-meta">
                    {entry.self ? null : entry.fromUserId.startsWith("role:") ? (
                      // Stream Deck message without an online station: the
                      // role is the sender and has no user to reply to.
                      <span className="chat-feed-sender">{entry.from}</span>
                    ) : (
                      <button
                        type="button"
                        className="chat-feed-sender"
                        title="Antworten"
                        onClick={() => handleSenderReply(entry.from, entry.fromUserId)}
                      >
                        {entry.from}
                      </button>
                    )}
                    {entry.source === "telegram" ? (
                      <span
                        className="chat-feed-source-icon"
                        title="Nachricht aus Telegram"
                      >
                        Telegram
                      </span>
                    ) : entry.source === "companion" ? (
                      <span
                        className="chat-feed-source-icon"
                        title="Über Stream Deck gesendet"
                      >
                        Stream Deck
                      </span>
                    ) : entry.source === "multiview-alert" ? (
                      <span
                        className={`chat-feed-source-icon${alert ? " chat-feed-alert-tag" : ""}`}
                        title="Wichtige Meldung aus JMS Control"
                      >
                        Wichtig
                      </span>
                    ) : entry.source === "multiview" ? (
                      <span
                        className="chat-feed-source-icon"
                        title="Über JMS Control gesendet"
                      >
                        JMS Control
                      </span>
                    ) : null}
                    {scopeTag(entry)}
                    <time>{entry.at}</time>
                    {needsMyAck ? (
                      <span className="chat-feed-ack-flag">Bestätigung erwartet</span>
                    ) : null}
                  </div>
                  <div className="chat-feed-message-row">
                    <p>{entry.body}</p>
                  </div>
                  {needsMyAck && entry.messageId ? (
                    <button
                      type="button"
                      className="chat-feed-ack-btn"
                      aria-label="Als gelesen markieren"
                      title="Bestätigen, dass du die Nachricht gelesen hast"
                      onClick={() =>
                        onAcknowledge(entry.messageId || "", entry.fromUserId)
                      }
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="m5 12 4 4L19 6" />
                      </svg>
                      <span>Gelesen – bestätigen</span>
                    </button>
                  ) : null}
                  <div className="chat-feed-foot">
                    {showAckOption && entry.self && entry.ackRequired ? (
                      <span
                        className={`chat-feed-ack-status ${entry.acked ? "acked" : "pending"}`}
                      >
                        {entry.acked
                          ? `Gelesen von ${entry.ackedBy || "Empfänger"}`
                          : "Gelesen ausstehend"}
                      </span>
                    ) : null}
                    {showAckOption && !entry.self && entry.ackRequired && entry.acked ? (
                      <span className="chat-feed-ack-status acked">Bestätigt</span>
                    ) : null}
                    {!entry.self && !entry.fromUserId.startsWith("role:") ? (
                      <button
                        type="button"
                        className="chat-feed-reply"
                        onClick={() => handleSenderReply(entry.from, entry.fromUserId)}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M9 14 4 9l5-5" />
                          <path d="M4 9h10a6 6 0 0 1 6 6v5" />
                        </svg>
                        Antworten
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="chat-composer">
        <div className="chat-composer-row">
          <label className="chat-target-control">
            <span>An</span>
            <select
              aria-label="Chat-Empfänger"
              value={selectedTarget}
              onChange={(event) => setSelectedTarget(event.target.value)}
            >
              <option value="global:global">Global (alle)</option>
              {rooms.length > 0 ? (
                <optgroup label="Party Lines">
                  {rooms.map((room) => (
                    <option key={room.id} value={`room:${room.id}`}>
                      {room.name}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {activeUsers.some((user) => user.isWebOnline !== false) ? (
                <optgroup label="Direkt">
                  {activeUsers
                    .filter((user) => user.isWebOnline !== false)
                    .map((user) => (
                      <option key={user.userId} value={`direct:${user.userId}`}>
                        {user.username} ({user.roleName})
                      </option>
                    ))}
                </optgroup>
              ) : null}
            </select>
          </label>
          {showAckOption ? (
            <button
              type="button"
              className={`chat-ack-btn ${requiresAck ? "active" : ""}`}
              aria-pressed={requiresAck}
              onClick={() => setRequiresAck(!requiresAck)}
              title={
                requiresAck
                  ? "Gelesen-Bestätigung aktiv"
                  : "Empfänger muss die Nachricht bestätigen"
              }
              aria-label="Gelesen-Bestätigung anfordern"
            >
              <span className="chat-ack-indicator" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="m5 12 4 4L19 6" />
                </svg>
              </span>
              <span className="chat-ack-label">Bestätigung</span>
            </button>
          ) : null}
        </div>
        <div className="chat">
          <input
            ref={inputRef}
            value={message}
            onChange={(e) => {
              onMessageChange(e.target.value);
              setCaret(e.target.selectionStart || 0);
              setSelectedSuggestion(0);
            }}
            onClick={(e) => setCaret(e.currentTarget.selectionStart || 0)}
            onKeyUp={(e) => setCaret(e.currentTarget.selectionStart || 0)}
            onKeyDown={(e) => {
              if (suggestions.length === 0) {
                if (e.key === "Enter") {
                  stickToBottomRef.current = true;
                  submitChat();
                }
                return;
              }

              if (e.key === "Escape") {
                e.preventDefault();
                closeSuggestions();
                return;
              }

              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelectedSuggestion((prev) =>
                  prev + 1 >= suggestions.length ? 0 : prev + 1,
                );
                return;
              }

              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelectedSuggestion((prev) =>
                  prev - 1 < 0 ? suggestions.length - 1 : prev - 1,
                );
                return;
              }

              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                const selected = suggestions[selectedSuggestion];
                if (selected) {
                  applySuggestion(selected);
                }
                return;
              }
            }}
            placeholder="Nachricht … (@ Person, # Party Line)"
          />
          <button
            type="button"
            className="chat-send"
            aria-label="Senden"
            onClick={() => {
              stickToBottomRef.current = true;
              submitChat();
            }}
          >
            <span className="chat-send-label">Senden</span>
            <svg className="chat-send-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M22 2 11 13" />
              <path d="m22 2-7 20-4-9-9-4z" />
            </svg>
          </button>
          {suggestions.length > 0 ? (
            <ul className="chat-autocomplete" role="listbox" aria-label="chat-autocomplete">
              {suggestions.map((item, idx) => (
                <li key={item.key}>
                  <button
                    className={idx === selectedSuggestion ? "active" : ""}
                    onClick={() => applySuggestion(item)}
                    type="button"
                  >
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  );
}
