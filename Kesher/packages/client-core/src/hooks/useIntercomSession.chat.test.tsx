import { StrictMode, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bootstrap } from "../types";
import {
  useIntercomSession,
  type UseIntercomSessionOptions,
} from "./useIntercomSession";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
}

class FakePeerConnection {
  connectionState = "new";
  iceConnectionState = "new";
  signalingState = "stable";
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onicecandidate: (() => void) | null = null;
  ontrack: (() => void) | null = null;
  addTransceiver() {}
  addTrack() {}
  getSenders() {
    return [];
  }
  getReceivers() {
    return [];
  }
  getTransceivers() {
    return [];
  }
  close() {}
}

const appData: Bootstrap = {
  roles: [
    { id: "lighting", name: "Lighting" },
    { id: "monitor", name: "Chat-Monitor" },
  ] as Bootstrap["roles"],
  rooms: [],
  broadcastGroups: [],
  activeRoleIds: [],
  ackEnabled: true,
  appVersion: {} as Bootstrap["appVersion"],
  self: { id: "u-monitor", username: "Chat-Monitor", roleId: "monitor" },
  users: [],
};

function options(): UseIntercomSessionOptions {
  const ref = <T,>(current: T) => ({ current });
  return {
    token: "token-monitor",
    appData,
    authMode: "operator",
    showDebug: false,
    lowPowerMode: true,
    viewModeOverride: "chat",
    selectedInputDeviceId: "",
    selectedInputDeviceIdRef: ref(""),
    selectedInputChannel: "mono" as UseIntercomSessionOptions["selectedInputChannel"],
    selectedOutputDeviceId: "",
    selectedOutputDeviceIdRef: ref(""),
    inputGainByDeviceId: {},
    inputGainByDeviceIdRef: ref({}),
    roomGainById: {},
    roomGainByIdRef: ref({}),
    directGainByUserId: {},
    directGainByUserIdRef: ref({}),
    enableDirectPpt: false,
    enableBackgroundAudioRecovery: false,
    keepScreenAwake: false,
    isUserSettingsOpen: false,
    isUserSettingsOpenRef: ref(false),
    audioGateEnabled: false,
    audioGateThresholdDb: -60,
    selectedInputGainFor: () => 1,
    onInputGainChange: () => {},
    channelAudioFeeds: [],
    inputDevices: [],
    outputDevices: [],
    initialListenRoomIds: [],
    initialTalkRoomIds: [],
    hadStoredSessionSettings: false,
    onUpdateAppData: () => {},
    onUpdatePublicData: () => {},
    onRefreshAudioDevices: async () => {},
    onSelectInputDevice: () => {},
    onSelectOutputDevice: async () => {},
    onSelectedInputChannelChange: () => {},
    onSessionTokenRejected: () => {},
    onSessionRevoked: () => {},
  };
}

function chatEvent(messageId: string, body: string) {
  return {
    type: "chat",
    data: {
      scope: "global",
      targetType: "global",
      targetId: "global",
      body,
      messageId,
      timestamp: Date.UTC(2026, 9, 12, 14, 48),
      fromUser: { id: "u-light", username: "Licht", roleId: "lighting" },
    },
  };
}

describe("useIntercomSession chat", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Regression: under React StrictMode (Vite dev server) the chat state
  // updater runs twice; deduplication inside it dropped every message, so
  // the chat display stayed on "Noch keine Nachrichten".
  it("keeps received chat messages under StrictMode", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>{children}</StrictMode>
    );
    const { result } = renderHook(() => useIntercomSession(options()), {
      wrapper,
    });

    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

    act(() => {
      ws.receive(chatEvent("m-1", "Historie"));
      ws.receive(chatEvent("m-2", "Live"));
      // History replay after a reconnect must not duplicate entries.
      ws.receive(chatEvent("m-1", "Historie"));
    });

    expect(result.current.chatMessages.map((entry) => entry.body)).toEqual([
      "Live",
      "Historie",
    ]);
    expect(result.current.chatMessages[0]).toMatchObject({
      fromRoleId: "lighting",
      timestamp: Date.UTC(2026, 9, 12, 14, 48),
    });
  });
});
