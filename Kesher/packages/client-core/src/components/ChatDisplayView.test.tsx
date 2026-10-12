import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatDisplayView } from "./ChatDisplayView";
import { resolveViewModeOverride } from "../lib/runtimeMode";

const roles = [
  { id: "lighting", name: "Licht 1" },
  { id: "sound1", name: "Ton 1" },
  { id: "chat-monitor", name: "Chat-Monitor" },
];

const baseEntry = {
  fromUserId: "u1",
  self: false,
  targetId: "global",
  room: "Global",
};

describe("ChatDisplayView", () => {
  it("is selected with ?viewMode=chat", () => {
    expect(resolveViewModeOverride("?viewMode=chat")).toBe("chat");
  });

  it("shows newest message last, with sender role, and hides unheard party lines", () => {
    render(
      <ChatDisplayView
        connectionState="connected"
        listenRoomIds={["ton"]}
        roles={roles}
        stationName="Chat-Monitor"
        chatMessages={[
          // newest first, as the session delivers them
          {
            ...baseEntry,
            from: "simon",
            fromRoleId: "lighting",
            body: "Bitte leiser",
            at: "19:02:10",
            scope: "global",
            messageId: "m3",
          },
          {
            ...baseEntry,
            from: "tim",
            fromRoleId: "sound1",
            body: "Ton-Leitung",
            at: "19:01:00",
            scope: "room",
            targetId: "ton",
            room: "Ton",
            messageId: "m2",
          },
          {
            ...baseEntry,
            from: "anna",
            body: "nicht gehört",
            at: "19:00:00",
            scope: "room",
            targetId: "kamera",
            room: "Kamera",
            messageId: "m1",
          },
        ]}
      />,
    );

    const bodies = screen
      .getAllByRole("listitem")
      .map((item) => item.querySelector(".chat-display-body")?.textContent);
    expect(bodies).toEqual(["Ton-Leitung", "Bitte leiser"]);
    expect(screen.queryByText("nicht gehört")).toBeNull();
    expect(screen.getByText("Licht 1")).toBeInTheDocument();
    expect(screen.getByText("19:02")).toBeInTheDocument();
  });

  it("marks messages that still wait for a read confirmation", () => {
    render(
      <ChatDisplayView
        connectionState="connected"
        listenRoomIds={[]}
        roles={roles}
        stationName="Chat-Monitor"
        chatMessages={[
          {
            ...baseEntry,
            from: "lea",
            body: "Bitte bestätigen",
            at: "19:05:00",
            scope: "global",
            ackRequired: true,
            messageId: "m9",
          },
        ]}
      />,
    );
    expect(screen.getByText("Bestätigung erwartet")).toBeInTheDocument();
  });

  it("flashes like a call for a new Stream Deck message, but not for history or typed messages", () => {
    const now = Date.now();
    render(
      <ChatDisplayView
        connectionState="connected"
        listenRoomIds={[]}
        roles={roles}
        stationName="Chat-Monitor"
        chatMessages={[
          {
            ...baseEntry,
            from: "simon",
            fromRoleId: "lighting",
            body: "Bitte leiser",
            at: "19:05:00",
            timestamp: now,
            scope: "global",
            messageId: "sd-new",
            source: "companion",
          },
          {
            ...baseEntry,
            from: "simon",
            fromRoleId: "lighting",
            body: "Alte Taste",
            at: "18:00:00",
            timestamp: now - 60 * 60 * 1000,
            scope: "global",
            messageId: "sd-old",
            source: "companion",
          },
          {
            ...baseEntry,
            from: "anna",
            fromRoleId: "sound1",
            body: "Getippt",
            at: "19:05:01",
            timestamp: now,
            scope: "global",
            messageId: "typed",
            source: "web",
          },
        ]}
      />,
    );

    const flash = screen.getByRole("status");
    expect(flash).toHaveClass("attention-flash-call");
    expect(flash).toHaveTextContent("Stream Deck · Global");
    expect(flash).toHaveTextContent("simon · Licht 1: Bitte leiser");
    expect(flash).not.toHaveTextContent("Alte Taste");
  });

  it("does not flash when only older Stream Deck messages are loaded", () => {
    render(
      <ChatDisplayView
        connectionState="connected"
        listenRoomIds={[]}
        roles={roles}
        stationName="Chat-Monitor"
        chatMessages={[
          {
            ...baseEntry,
            from: "simon",
            fromRoleId: "lighting",
            body: "Alte Taste",
            at: "18:00:00",
            timestamp: Date.now() - 60 * 60 * 1000,
            scope: "global",
            messageId: "sd-old",
            source: "companion",
          },
        ]}
      />,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
