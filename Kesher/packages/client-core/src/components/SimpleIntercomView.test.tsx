import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SimpleIntercomView } from "./SimpleIntercomView";

function audioDevice(
  kind: "audioinput" | "audiooutput",
  deviceId: string,
  label: string,
): MediaDeviceInfo {
  return {
    deviceId,
    groupId: "group-1",
    kind,
    label,
    toJSON: () => ({ deviceId, groupId: "group-1", kind, label }),
  };
}

const baseProps: ComponentProps<typeof SimpleIntercomView> = {
  connectionState: "connected",
  lowPowerMode: true,
  pttPressed: false,
  onStartPpt: vi.fn(),
  onStopPpt: vi.fn(),
  replyTarget: null,
  selectedInputDeviceId: "mic-1",
  onSelectedInputDeviceIdChange: vi.fn(),
  inputDevices: [audioDevice("audioinput", "mic-1", "USB Audio")],
  selectedInputChannel: "all",
  inputChannelCount: 1,
  onSelectedInputChannelChange: vi.fn(),
  selectedOutputDeviceId: "",
  onSelectedOutputDeviceIdChange: vi.fn(),
  outputDevices: [audioDevice("audiooutput", "out-1", "USB Audio")],
  outputSelectionSupported: true,
  enableBackgroundAudioRecovery: true,
  onEnableBackgroundAudioRecoveryChange: vi.fn(),
  keepScreenAwake: false,
  onKeepScreenAwakeChange: vi.fn(),
  mediaSessionSupported: true,
  wakeLockSupported: true,
  wakeLockActive: false,
  isStandaloneDisplayMode: false,
  audioError: "",
  webrtcState: "connected",
  hasVoiceTarget: true,
  hasListenTarget: true,
  simplePptTargetLabel: "Livestream",
  doLogout: vi.fn(),
};

describe("SimpleIntercomView audio status", () => {
  it("shows the selected party line and ready audio state", () => {
    render(<SimpleIntercomView {...baseProps} />);

    const audioStatus = screen.getByRole("status", {
      name: "Audio runtime status",
    });
    expect(audioStatus).toHaveTextContent("Audio ready");
    expect(audioStatus).toHaveTextContent(
      "Party line: Livestream",
    );
    expect(screen.getByRole("button", { name: /Hold to talk/ })).toBeEnabled();
  });

  it("disables PTT and explains a missing party line", () => {
    render(
      <SimpleIntercomView
        {...baseProps}
        hasVoiceTarget={false}
        simplePptTargetLabel="No party line selected"
      />,
    );

    expect(
      screen.getByRole("status", { name: "Audio runtime status" }),
    ).toHaveTextContent(
      "No party line is assigned",
    );
    expect(screen.getByRole("button", { name: /Hold to talk/ })).toBeDisabled();
  });

  it("stays ready in receive-only mode without a microphone", () => {
    render(
      <SimpleIntercomView
        {...baseProps}
        inputDevices={[]}
      />,
    );

    const audioStatus = screen.getByRole("status", {
      name: "Audio runtime status",
    });
    expect(audioStatus).toHaveTextContent("Receive-only ready");
    expect(audioStatus).toHaveTextContent("Listening stays active");
    expect(screen.getByRole("button", { name: /Hold to talk/ })).toBeDisabled();
  });

  it("shows browser microphone permission errors", () => {
    render(
      <SimpleIntercomView
        {...baseProps}
        inputDevices={[]}
        audioError="Failed to access microphone: Permission denied"
      />,
    );

    const audioStatus = screen.getByRole("status", {
      name: "Audio runtime status",
    });
    expect(audioStatus).toHaveTextContent("Audio not ready");
    expect(audioStatus).toHaveTextContent("Permission denied");
  });
});
