import type { ComponentProps } from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StationIntercomView } from "./StationIntercomView";
import type { StreamDeckSettings } from "../types";
const baseProps: ComponentProps<typeof StationIntercomView> = {
  token: "test-token",
  connectionState: "connected",
  lowPowerMode: false,
  appData: {
    self: { id: "u1", username: "tim", roleId: "op" },
    users: [{ id: "u1", username: "tim", roleId: "op" }],
    roles: [{ id: "op", name: "Operator" }],
    rooms: [
      {
        id: "room-1",
        name: "Party Line 1",
        senderRoleIds: ["op"],
        receiverRoleIds: ["op"],
        forcedListenRoleIds: [],
      },
    ],
    broadcastGroups: [],
    ackEnabled: true,
    appVersion: { version: "dev", buildTimestamp: "2026-03-10" },
  },
  doLogout: vi.fn(),
  listenRoomIds: ["room-1"],
  talkRoomIds: ["room-1"],
  canRoleSendToRoom: () => true,
  canRoleReceiveFromRoom: () => true,
  toggleTalkRoom: vi.fn(),
  toggleListenRoom: vi.fn(),
  roomLevelById: {},
  isReceivingRoom: () => false,
  isReceivingBroadcast: () => false,
  isReceivingDirect: () => false,
  broadcastPttPressed: null,
  startBroadcastPtt: vi.fn(),
  stopBroadcastPtt: vi.fn(),
  broadcastGroups: [],
  presence: [],
  roomListenerCounts: {},
  roleNameById: new Map([["op", "Operator"]]),
  lastDirectCallerUserId: null,
  directPttPressedUserId: null,
  startDirectPtt: vi.fn(),
  stopDirectPtt: vi.fn(),
  sendScopedSignal: vi.fn(),
  pttPressed: false,
  startPtt: vi.fn(),
  stopPtt: vi.fn(),
  voiceMode: "ptt",
  setAlwaysOn: vi.fn(),
  chatAndSignalPanel: null,
  raspberryPiStations: null,
  raspberryPiStationsError: "",
  showDebug: false,
  realtimeDebugBlock: null,
  enableDirectPpt: false,
  onEnableDirectPptChange: vi.fn(),
  enableDirectTabs: false,
  onEnableDirectTabsChange: vi.fn(),
  swapPttAndReplyButtons: false,
  onSwapPttAndReplyButtonsChange: vi.fn(),
  enableBackgroundAudioRecovery: true,
  onEnableBackgroundAudioRecoveryChange: vi.fn(),
  keepScreenAwake: false,
  onKeepScreenAwakeChange: vi.fn(),
  showVolumeControls: true,
  onShowVolumeControlsChange: vi.fn(),
  mediaSessionSupported: true,
  wakeLockSupported: true,
  wakeLockActive: false,
  isStandaloneDisplayMode: false,
  onChannelPptStart: vi.fn(),
  onChannelPptStop: vi.fn(),
  pptPressedChannelId: null,
  pinnedRoomIds: [],
  pinnedUserIds: [],
  showPinnedOnly: false,
  onTogglePinnedUser: vi.fn(),
  onShowPinnedOnlyChange: vi.fn(),
  isUserSettingsOpen: false,
  setIsUserSettingsOpen: vi.fn(),
  roomGainById: {},
  directGainByUserId: {},
  onRoomGainChange: vi.fn(),
  onDirectGainChange: vi.fn(),
  keyboardShortcuts: { ptt: null, toggleAlwaysOn: null },
  onKeyboardShortcutsChange: vi.fn(),
  onRecordingShortcutChange: vi.fn(),
  inputDevices: [],
  selectedInputDeviceId: "",
  selectedMicLabel: "Default input",
  setSelectedInputDeviceId: vi.fn(),
  selectedInputChannel: "all" as const,
  inputChannelCount: 2,
  onSelectedInputChannelChange: vi.fn(),
  inputLevelDbFs: -60,
  inputGain: 1,
  inputClipping: false,
  isLocalMonitorActive: false,
  onToggleLocalMonitor: vi.fn(),
  onInputGainChange: vi.fn(),
  channelAudioFeeds: [],
  channelAudioFeedStatuses: [],
  onCreateChannelAudioFeed: vi.fn().mockReturnValue("feed-new"),
  onUpdateChannelAudioFeed: vi.fn(),
  onRemoveChannelAudioFeed: vi.fn(),
  onCreateChannelAudioFeedRoom: vi.fn().mockResolvedValue("audio-feed-room"),
  onUpdateChannelAudioFeedRoom: vi.fn().mockResolvedValue(undefined),
  audioGateEnabled: false,
  onAudioGateEnabledChange: vi.fn(),
  audioGateThresholdDb: -52,
  onAudioGateThresholdDbChange: vi.fn(),
  outputDevices: [],
  selectedOutputDeviceId: "",
  selectedOutputLabel: "Default output",
  outputSelectionSupported: false,
  setSelectedOutputDeviceId: vi.fn(),
  streamDeckSettings: {
    version: 1,
    gridColumns: 5,
    gridRows: 3,
    selectedPage: 0,
    pages: [{ page: 0, buttons: Array.from({ length: 15 }, (_, i) => ({ index: i })) }],
  },
  streamDeckBusy: false,
  streamDeckError: "",
  onStreamDeckSettingsChange: vi.fn(),
  onSaveStreamDeckSettings: vi.fn(),
  onResetStreamDeckSettings: vi.fn(),
  onPublishCompanionProfile: vi.fn().mockResolvedValue({
    roleId: "op",
    username: "tim",
    profileVersion: 1,
    profileStatus: "active",
  }),
  streamDeckWebHidSupported: true,
  streamDeckWebHidActive: false,
  streamDeckWebHidBusy: false,
  onConnectStreamDeckWebHid: vi.fn(),
  onDisconnectStreamDeckWebHid: vi.fn(),
  streamDeckBridgeConnected: false,
  streamDeckBridgeLastEvent: "",
  lastCompanionCommand: null,
  onStreamDeckTestButtonEvent: vi.fn(),
};

describe("StationIntercomView", () => {
  it("renders the incoming level in each party-line meter", () => {
    render(
      <StationIntercomView
        {...baseProps}
        roomLevelById={{ "room-1": 0.72 }}
      />,
    );

    const meter = screen.getByRole("meter", {
      name: "Party Line 1 input level",
    });
    expect(meter).toHaveAttribute("aria-valuenow", "72");
    expect(meter.querySelectorAll(".station-channel-meter-segment.active")).toHaveLength(
      7,
    );
  });

  it("renders the local outgoing level while talking into a selected party line", () => {
    render(
      <StationIntercomView
        {...baseProps}
        pttPressed
        inputLevelDbFs={-30}
      />,
    );

    const meter = screen.getByRole("meter", {
      name: "Party Line 1 input level",
    });
    expect(meter).toHaveAttribute("aria-valuenow", "50");
    expect(
      meter.querySelectorAll(".station-channel-meter-segment.active"),
    ).toHaveLength(5);
  });

  it("does not render a party-line favorite button on the level meter", () => {
    render(<StationIntercomView {...baseProps} />);

    expect(
      screen.queryByRole("button", { name: "Add channel to favorites" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove channel from favorites" }),
    ).not.toBeInTheDocument();
  });

  it("uses route activity without audio analysis in low-power mode", () => {
    render(
      <StationIntercomView
        {...baseProps}
        lowPowerMode
        isReceivingRoom={() => true}
      />,
    );

    expect(
      screen.getByRole("meter", { name: "Party Line 1 input level" }),
    ).toHaveAttribute("aria-valuenow", "42");
  });

  it("adds a safe wrap opportunity to slash-separated party-line names", () => {
    const { container } = render(
      <StationIntercomView
        {...baseProps}
        appData={{
          ...baseProps.appData,
          rooms: [
            {
              ...baseProps.appData.rooms[0],
              name: "Licht/ProPresenter",
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("Licht/ProPresenter")).toBeVisible();
    expect(container.querySelector(".station-room-card strong wbr")).not.toBeNull();
  });

  it("shows the low-power indicator only when the mode is active", () => {
    const { rerender } = render(<StationIntercomView {...baseProps} />);
    expect(
      screen.queryByRole("status", { name: "Low power mode active" }),
    ).not.toBeInTheDocument();

    rerender(<StationIntercomView {...baseProps} lowPowerMode />);
    expect(
      screen.getByRole("status", { name: "Low power mode active" }),
    ).toBeVisible();
  });

  it("toggles always-on from the switch control", async () => {
    const user = userEvent.setup();
    const setAlwaysOn = vi.fn();

    render(<StationIntercomView {...baseProps} setAlwaysOn={setAlwaysOn} />);

    const alwaysOnSwitch = screen.getByRole("switch", { name: "Always on" });
    expect(alwaysOnSwitch).toHaveAttribute("aria-checked", "false");

    await user.click(alwaysOnSwitch);

    expect(setAlwaysOn).toHaveBeenCalledWith(true);
    expect(setAlwaysOn).toHaveBeenCalledTimes(1);
  });

  it("turns always-on off from the same switch without double-toggling", async () => {
    const user = userEvent.setup();
    const setAlwaysOn = vi.fn();

    render(
      <StationIntercomView
        {...baseProps}
        voiceMode="always_on"
        setAlwaysOn={setAlwaysOn}
      />,
    );

    const alwaysOnSwitch = screen.getByRole("switch", { name: "Always on" });
    expect(alwaysOnSwitch).toHaveAttribute("aria-checked", "true");

    await user.click(alwaysOnSwitch);

    expect(setAlwaysOn).toHaveBeenCalledWith(false);
    expect(setAlwaysOn).toHaveBeenCalledTimes(1);
  });

  it("renders hold to talk before reply when swapping is enabled", () => {
    const { container } = render(
      <StationIntercomView {...baseProps} swapPttAndReplyButtons />,
    );

    const controls = container.querySelector(".station-controls");
    expect(controls).not.toBeNull();

    const buttonTexts = Array.from(
      controls!.querySelectorAll("button"),
      (button) => button.textContent ?? "",
    );

    expect(buttonTexts[0]).toContain("Hold to talk");
    expect(buttonTexts[1]).toContain("Reply to caller");
  });

  it("renders reply before hold to talk by default", () => {
    const { container } = render(<StationIntercomView {...baseProps} />);

    const controls = container.querySelector(".station-controls");
    expect(controls).not.toBeNull();

    const buttonTexts = Array.from(
      controls!.querySelectorAll("button"),
      (button) => button.textContent ?? "",
    );

    expect(buttonTexts[0]).toContain("Reply to caller");
    expect(buttonTexts[1]).toContain("Hold to talk");
  });

  it("renders the action controls inside the top header", () => {
    const { container } = render(<StationIntercomView {...baseProps} />);

    const header = container.querySelector(".station-header");
    const controls = container.querySelector(".station-controls");
    const contentGrid = container.querySelector(".station-content-grid");

    expect(header).not.toBeNull();
    expect(controls).not.toBeNull();
    expect(contentGrid).not.toBeNull();
    expect(header!.contains(controls!)).toBe(true);
    expect(
      header!.compareDocumentPosition(contentGrid!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
  it("updates the swap setting from the user settings modal", async () => {
    const user = userEvent.setup();
    const onSwapPttAndReplyButtonsChange = vi.fn();

    render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        onSwapPttAndReplyButtonsChange={onSwapPttAndReplyButtonsChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Interaction" }));
    await user.click(
      screen.getByRole("checkbox", { name: "Swap PTT and reply buttons" }),
    );

    expect(onSwapPttAndReplyButtonsChange).toHaveBeenCalledWith(true);
  });

  it("renders chat content in a dedicated secondary column when provided", () => {
    const { container } = render(
      <StationIntercomView
        {...baseProps}
        chatAndSignalPanel={<div>Chat content</div>}
      />,
    );

    const secondaryColumn = container.querySelector(
      ".station-secondary-column",
    );

    expect(secondaryColumn).not.toBeNull();
    expect(secondaryColumn).toHaveTextContent("Chat");
    expect(secondaryColumn).toHaveTextContent("Chat content");
  });

  it("keeps hold-to-talk active when the pointer moves away before release", () => {
    const startPtt = vi.fn();
    const stopPtt = vi.fn();

    render(
      <StationIntercomView
        {...baseProps}
        startPtt={startPtt}
        stopPtt={stopPtt}
      />,
    );

    const holdButton = screen.getByRole("button", { name: "Hold to talk" });
    let capturedPointerId: number | null = null;

    Object.defineProperties(holdButton, {
      setPointerCapture: {
        configurable: true,
        value: (pointerId: number) => {
          capturedPointerId = pointerId;
        },
      },
      hasPointerCapture: {
        configurable: true,
        value: (pointerId: number) => capturedPointerId === pointerId,
      },
      releasePointerCapture: {
        configurable: true,
        value: (pointerId: number) => {
          if (capturedPointerId === pointerId) {
            capturedPointerId = null;
          }
        },
      },
    });

    fireEvent.pointerDown(holdButton, {
      button: 0,
      pointerId: 12,
      pointerType: "touch",
    });
    fireEvent.pointerLeave(holdButton, { pointerId: 12, pointerType: "touch" });

    expect(startPtt).toHaveBeenCalledTimes(1);
    expect(stopPtt).not.toHaveBeenCalled();

    fireEvent.pointerUp(holdButton, { pointerId: 12, pointerType: "touch" });

    expect(stopPtt).toHaveBeenCalledTimes(1);
  });

  it("allows assigning reply-to-caller in stream deck settings", async () => {
    const user = userEvent.setup();
    const onStreamDeckSettingsChange = vi.fn();
    render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        onStreamDeckSettingsChange={onStreamDeckSettingsChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));

    await user.selectOptions(
      screen.getByLabelText("Stream Deck function"),
      "reply_to_caller",
    );

    expect(onStreamDeckSettingsChange).toHaveBeenCalled();
    const calls = onStreamDeckSettingsChange.mock.calls;
    const lastCallArg = calls[calls.length - 1]?.[0];
    expect(lastCallArg?.pages?.[0]?.buttons?.[0]?.action?.type).toBe(
      "reply_to_caller",
    );
  });

  it("allows assigning select+listen channel action in stream deck settings", async () => {
    const user = userEvent.setup();
    const onStreamDeckSettingsChange = vi.fn();
    render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        onStreamDeckSettingsChange={onStreamDeckSettingsChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));

    await user.selectOptions(
      screen.getByLabelText("Stream Deck function"),
      "select_listen_room",
    );

    expect(onStreamDeckSettingsChange).toHaveBeenCalled();
    const calls = onStreamDeckSettingsChange.mock.calls;
    const lastCallArg = calls[calls.length - 1]?.[0];
    expect(lastCallArg?.pages?.[0]?.buttons?.[0]?.action?.type).toBe(
      "select_listen_room",
    );
  });

  it("offers stream deck navigation and folder functions in user settings", async () => {
    const user = userEvent.setup();
    render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
      />,
    );

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));

    expect(
      screen.getByRole("option", { name: "Volume +/-" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Page up" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Page down" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Open page / folder" }),
    ).toBeInTheDocument();
  });

  it("copies and pastes a stream deck button configuration", async () => {
    const user = userEvent.setup();
    const onStreamDeckSettingsChange = vi.fn();
    const streamDeckSettings: StreamDeckSettings = {
      version: 1,
      gridColumns: 5,
      gridRows: 3,
      selectedPage: 0,
      pages: [
        {
          page: 0,
          buttons: Array.from({ length: 15 }, (_, i) =>
            i === 0
              ? { index: 0, action: { type: "reply_to_caller" as const } }
              : { index: i },
          ),
        },
      ],
    };
    render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        streamDeckSettings={streamDeckSettings}
        onStreamDeckSettingsChange={onStreamDeckSettingsChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));
    await user.click(screen.getByRole("button", { name: "Copy" }));
    await user.click(screen.getByRole("button", { name: "Deck key 2" }));
    await user.click(screen.getByRole("button", { name: "Paste" }));

    const calls = onStreamDeckSettingsChange.mock.calls;
    const lastCallArg = calls[calls.length - 1]?.[0];
    expect(lastCallArg?.pages?.[0]?.buttons?.[1]?.action?.type).toBe(
      "reply_to_caller",
    );
  });

  it("undoes the last stream deck button change", async () => {
    const user = userEvent.setup();
    const onStreamDeckSettingsChange = vi.fn();
    const { rerender } = render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        onStreamDeckSettingsChange={onStreamDeckSettingsChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));
    await user.selectOptions(
      screen.getByLabelText("Stream Deck function"),
      "reply_to_caller",
    );

    const changedSettings = onStreamDeckSettingsChange.mock.calls[0]?.[0];
    rerender(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        streamDeckSettings={changedSettings}
        onStreamDeckSettingsChange={onStreamDeckSettingsChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Undo" }));

    const undoCallArg = onStreamDeckSettingsChange.mock.calls[1]?.[0];
    expect(undoCallArg?.pages?.[0]?.buttons?.[0]?.action).toBeUndefined();
  });

  it("swaps stream deck buttons via drag and drop", async () => {
    const user = userEvent.setup();
    const onStreamDeckSettingsChange = vi.fn();
    const streamDeckSettings: StreamDeckSettings = {
      version: 1,
      gridColumns: 5,
      gridRows: 3,
      selectedPage: 0,
      pages: [
        {
          page: 0,
          buttons: Array.from({ length: 15 }, (_, i) => {
            if (i === 0) {
              return { index: 0, action: { type: "reply_to_caller" as const } };
            }
            if (i === 1) {
              return { index: 1, action: { type: "page_up" as const } };
            }
            return { index: i };
          }),
        },
      ],
    };
    render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        streamDeckSettings={streamDeckSettings}
        onStreamDeckSettingsChange={onStreamDeckSettingsChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));

    const keyOne = screen.getByRole("button", { name: "Deck key 1" });
    const keyTwo = screen.getByRole("button", { name: "Deck key 2" });

    fireEvent.dragStart(keyOne, {
      dataTransfer: {
        effectAllowed: "",
        setData: vi.fn(),
        getData: vi.fn(),
      },
    });
    fireEvent.dragOver(keyTwo, {
      dataTransfer: {
        dropEffect: "",
      },
    });
    fireEvent.drop(keyTwo);

    const calls = onStreamDeckSettingsChange.mock.calls;
    const lastCallArg = calls[calls.length - 1]?.[0];
    expect(lastCallArg?.pages?.[0]?.buttons?.[0]?.action?.type).toBe("page_up");
    expect(lastCallArg?.pages?.[0]?.buttons?.[1]?.action?.type).toBe(
      "reply_to_caller",
    );
  });

  it("opens an empty next stream deck page from page navigation", async () => {
    const user = userEvent.setup();
    const onStreamDeckSettingsChange = vi.fn();
    render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        onStreamDeckSettingsChange={onStreamDeckSettingsChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));

    expect(screen.queryByRole("button", { name: "+ Page" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "- Page" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: ">" }));

    const nextPageArg = onStreamDeckSettingsChange.mock.calls[0]?.[0];
    expect(nextPageArg?.pages?.length).toBe(2);
    expect(nextPageArg?.pages?.[1]?.page).toBe(1);
    expect(nextPageArg?.selectedPage).toBe(1);
  });

  it("prunes empty stream deck editor pages before saving", async () => {
    const user = userEvent.setup();
    const onStreamDeckSettingsChange = vi.fn();
    const onSaveStreamDeckSettings = vi.fn();
    const { rerender } = render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        onStreamDeckSettingsChange={onStreamDeckSettingsChange}
        onSaveStreamDeckSettings={onSaveStreamDeckSettings}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));
    await user.click(screen.getByRole("button", { name: ">" }));

    const nextPageArg = onStreamDeckSettingsChange.mock.calls[0]?.[0];
    rerender(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        streamDeckSettings={nextPageArg}
        onStreamDeckSettingsChange={onStreamDeckSettingsChange}
        onSaveStreamDeckSettings={onSaveStreamDeckSettings}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save" }));

    const savedArg = onSaveStreamDeckSettings.mock.calls[0]?.[0];
    expect(savedArg?.pages).toHaveLength(1);
    expect(savedArg?.pages?.[0]?.page).toBe(0);
    expect(savedArg?.selectedPage).toBe(0);
  });

  it("triggers save from stream deck settings header", async () => {
    const user = userEvent.setup();
    const onSaveStreamDeckSettings = vi.fn();
    render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        onSaveStreamDeckSettings={onSaveStreamDeckSettings}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSaveStreamDeckSettings).toHaveBeenCalledTimes(1);
  });

  it("confirms saved stream deck settings", async () => {
    const user = userEvent.setup();
    const onSaveStreamDeckSettings = vi.fn().mockResolvedValue(undefined);
    render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        onSaveStreamDeckSettings={onSaveStreamDeckSettings}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Stream Deck profile saved.",
    );
  });

  it("shows stream deck save failures", async () => {
    const user = userEvent.setup();
    const onSaveStreamDeckSettings = vi
      .fn()
      .mockRejectedValue(new Error("Save endpoint unavailable."));
    render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        onSaveStreamDeckSettings={onSaveStreamDeckSettings}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Save endpoint unavailable.",
    );
  });

  it("confirms published companion stream deck profiles", async () => {
    const user = userEvent.setup();
    const onSaveStreamDeckSettings = vi.fn().mockResolvedValue(undefined);
    const onPublishCompanionProfile = vi.fn().mockResolvedValue({
      profileVersion: 12,
      roleId: "audio",
      username: "tim",
    });
    render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        onSaveStreamDeckSettings={onSaveStreamDeckSettings}
        onPublishCompanionProfile={onPublishCompanionProfile}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));
    await user.click(
      screen.getByRole("button", { name: "Publish to Companion" }),
    );

    const dialog = screen.getByRole("dialog", {
      name: "Publish this Stream Deck profile?",
    });
    expect(dialog).toHaveTextContent("Buttons / Presets / kesher");
    expect(dialog).toHaveTextContent("Kesher / Operator / tim");
    expect(onPublishCompanionProfile).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Save & publish" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Stream Deck profile saved and published as Companion v12 for role audio.",
    );
    expect(onPublishCompanionProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        gridColumns: 5,
        gridRows: 3,
      }),
    );
  });

  it("cancels companion stream deck publishing before the API call", async () => {
    const user = userEvent.setup();
    const onPublishCompanionProfile = vi.fn().mockResolvedValue({
      profileVersion: 12,
      roleId: "audio",
      username: "tim",
    });
    render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        onPublishCompanionProfile={onPublishCompanionProfile}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));
    await user.click(
      screen.getByRole("button", { name: "Publish to Companion" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Publish this Stream Deck profile?",
    });
    await user.click(
      within(dialog).getByRole("button", {
        name: "Cancel",
      }),
    );

    expect(
      screen.queryByRole("dialog", {
        name: "Publish this Stream Deck profile?",
      }),
    ).toBeNull();
    expect(onPublishCompanionProfile).not.toHaveBeenCalled();
  });

  it("exports stream deck settings as a JSON file", async () => {
    const user = userEvent.setup();
    let exportedBlob: Blob | null = null;
    const createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation((blob) => {
        exportedBlob = blob as Blob;
        return "blob:streamdeck-export";
      });
    const revokeObjectURLSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});

    render(<StationIntercomView {...baseProps} isUserSettingsOpen />);

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));
    await user.click(screen.getByRole("button", { name: "Export" }));

    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).toHaveBeenCalledWith("blob:streamdeck-export");
    const exportedText = await exportedBlob?.text();
    const exportedJson = JSON.parse(exportedText || "{}");
    expect(exportedJson.settings.pages).toHaveLength(1);

    createObjectURLSpy.mockRestore();
    revokeObjectURLSpy.mockRestore();
  });

  it("imports stream deck settings from JSON and applies them", async () => {
    const user = userEvent.setup();
    const onStreamDeckSettingsChange = vi.fn();
    const { container } = render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        onStreamDeckSettingsChange={onStreamDeckSettingsChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));

    const input = container.querySelector(
      '[data-testid="streamdeck-import-input"]',
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();

    const importedSettings = {
      meta: {
        format: "kesher-user-streamdeck",
        schemaVersion: 1,
        exportedAt: "2026-03-16T10:00:00Z",
        username: "tim",
      },
      settings: {
        version: 1,
        gridColumns: 5,
        gridRows: 3,
        selectedPage: 0,
        pages: [
          {
            page: 0,
            buttons: Array.from({ length: 15 }, (_, i) =>
              i === 0
                ? { index: 0, action: { type: "reply_to_caller" } }
                : { index: i },
            ),
          },
        ],
      },
    };

    const file = new File([JSON.stringify(importedSettings)], "streamdeck.json", {
      type: "application/json",
    });

    await user.upload(input!, file);

    expect(onStreamDeckSettingsChange).toHaveBeenCalled();
    const streamDeckCalls = onStreamDeckSettingsChange.mock.calls;
    const lastCallArg = streamDeckCalls[streamDeckCalls.length - 1]?.[0];
    expect(lastCallArg?.pages?.[0]?.buttons?.[0]?.action?.type).toBe(
      "reply_to_caller",
    );
  });

  it("opens stream deck settings as a dedicated subpage", async () => {
    const user = userEvent.setup();

    const { container } = render(
      <StationIntercomView {...baseProps} isUserSettingsOpen />,
    );

    expect(
      screen.queryByRole("grid", { name: "Stream Deck 5x3 grid" }),
    ).not.toBeInTheDocument();
    expect(container.querySelector("#settings-streamdeck")).toBeNull();
    expect(container.querySelector("#settings-audio")).toBeNull();
    expect(container.querySelector("#settings-layout")).not.toBeNull();
    expect(container.querySelector("#settings-interaction")).toBeNull();
    expect(container.querySelector("#settings-system")).toBeNull();

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));

    expect(
      screen.getByRole("grid", { name: "Stream Deck 5x3 grid" }),
    ).toBeInTheDocument();
    expect(container.querySelector("#settings-streamdeck")).not.toBeNull();
    expect(container.querySelector("#settings-layout")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Layout" }));

    expect(
      screen.queryByRole("grid", { name: "Stream Deck 5x3 grid" }),
    ).not.toBeInTheDocument();
    expect(container.querySelector("#settings-streamdeck")).toBeNull();
  });

  it("uses the reduced-effects settings backdrop in low-power mode", () => {
    const { container } = render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        lowPowerMode
      />,
    );

    expect(
      container.querySelector(".station-modal-backdrop-low-power"),
    ).not.toBeNull();
    expect(
      container.querySelector(".station-shell.settings-open-low-power"),
    ).not.toBeNull();
  });

  it("emits down and up events in stream deck browser test mode", async () => {
    const user = userEvent.setup();
    const onStreamDeckTestButtonEvent = vi.fn();

    render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        onStreamDeckTestButtonEvent={onStreamDeckTestButtonEvent}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));
    await user.click(screen.getByRole("button", { name: "Test mode off" }));

    const key = screen.getByRole("button", {
      name: "Deck key 1",
    });

    fireEvent.pointerDown(key);
    fireEvent.pointerUp(key);

    expect(onStreamDeckTestButtonEvent).toHaveBeenNthCalledWith(1, {
      page: 0,
      buttonIndex: 0,
      state: "down",
    });
    expect(onStreamDeckTestButtonEvent).toHaveBeenNthCalledWith(2, {
      page: 0,
      buttonIndex: 0,
      state: "up",
    });
  });

  it("renders audio gate controls and dispatches changes", async () => {
    const user = userEvent.setup();
    const onAudioGateEnabledChange = vi.fn();
    const onAudioGateThresholdDbChange = vi.fn();

    render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        audioGateEnabled
        onAudioGateEnabledChange={onAudioGateEnabledChange}
        onAudioGateThresholdDbChange={onAudioGateThresholdDbChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Sound settings/ }));
    await user.click(screen.getByRole("checkbox", { name: "Noise gate" }));
    fireEvent.change(
      screen.getByRole("slider", { name: "Microphone gate threshold" }),
      { target: { value: "-40" } },
    );

    expect(onAudioGateEnabledChange).toHaveBeenCalledWith(false);
    expect(onAudioGateThresholdDbChange).toHaveBeenCalledWith(-40);
  });

  it("pauses sound metering and gate controls in low-power mode", async () => {
    const user = userEvent.setup();

    render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        lowPowerMode
        audioGateEnabled
      />,
    );

    await user.click(screen.getByRole("button", { name: /Sound settings/ }));

    expect(screen.getByText("Low power mode keeps metering off.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Audio test paused" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Noise gate" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Noise gate" })).not.toBeChecked();
    expect(
      screen.getByRole("slider", { name: "Microphone gate threshold" }),
    ).toBeDisabled();
  });

  it("selects a physical USB interface input", async () => {
    const user = userEvent.setup();
    const onSelectedInputChannelChange = vi.fn();

    render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        inputChannelCount={2}
        onSelectedInputChannelChange={onSelectedInputChannelChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Sound settings/ }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Interface input" }),
      "2",
    );

    expect(onSelectedInputChannelChange).toHaveBeenCalledWith(2);
  });

  it("renders nested sound settings and edits a channel audio feed", async () => {
    const user = userEvent.setup();
    const onUpdateChannelAudioFeed = vi.fn();

    render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        inputDevices={[
          {
            deviceId: "scarlett",
            groupId: "g1",
            kind: "audioinput",
            label: "Scarlett 2i2 USB",
            inputChannels: 2,
            toJSON: () => ({}),
          } as MediaDeviceInfo & { inputChannels: number },
        ]}
        channelAudioFeeds={[
          {
            id: "feed-1",
            name: "Music",
            roomId: "room-1",
            inputDeviceId: "scarlett",
            inputChannel: "all",
            gain: 1,
            enabled: false,
            ownerRoleId: "op",
          },
        ]}
        channelAudioFeedStatuses={[
          { id: "feed-1", state: "idle" },
        ]}
        onUpdateChannelAudioFeed={onUpdateChannelAudioFeed}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Sound settings/ }));

    expect(screen.getByRole("button", { name: /My audio/ })).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: /Channel audio feeds/ }),
    );
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Feed bearbeiten" });
    await user.click(within(dialog).getByRole("checkbox", { name: "Send" }));
    await user.selectOptions(
      within(dialog).getByRole("combobox", { name: "Interface input" }),
      "2",
    );
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onUpdateChannelAudioFeed).toHaveBeenCalledWith("feed-1", {
        name: "Music",
        roomId: "room-1",
        inputDeviceId: "scarlett",
        inputChannel: 2,
        gain: 1,
        enabled: true,
        ownerRoleId: "op",
      });
    });
  });

  it("creates an audio feed from the channel audio feed settings", async () => {
    const user = userEvent.setup();
    const onCreateChannelAudioFeedRoom = vi
      .fn()
      .mockResolvedValue("music-feed");
    const onCreateChannelAudioFeed = vi.fn().mockReturnValue("feed-new");

    render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        onCreateChannelAudioFeedRoom={onCreateChannelAudioFeedRoom}
        onCreateChannelAudioFeed={onCreateChannelAudioFeed}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Sound settings/ }));
    await user.click(
      screen.getByRole("button", { name: /Channel audio feeds/ }),
    );
    await user.click(
      screen.getByRole("button", { name: "Neuer Feed" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Neuer Feed" });
    expect(
      within(dialog).queryByLabelText(/Talk channel name/i),
    ).not.toBeInTheDocument();
    const canSendGroup = within(dialog).getByRole("group", {
      name: "Can send",
    });
    const ownSenderRole = within(canSendGroup).getByRole("checkbox", {
      name: "Operator",
    });
    expect(ownSenderRole).toBeChecked();
    expect(ownSenderRole).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Feed name/), "Music feed");
    expect(within(dialog).getByText("Music feed")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onCreateChannelAudioFeedRoom).toHaveBeenCalledWith({
        name: "Music feed",
        priorityLevel: 1,
        senderRoleIds: ["op"],
        receiverRoleIds: ["op"],
        forcedListenRoleIds: [],
      });
      expect(onCreateChannelAudioFeed).toHaveBeenCalledWith({
        ownerRoleId: "op",
        name: "Music feed",
        roomId: "music-feed",
        inputDeviceId: "",
        inputChannel: "all",
        gain: 1,
        enabled: true,
      });
    });
  });
});
