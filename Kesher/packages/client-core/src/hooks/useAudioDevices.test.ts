import { describe, expect, it } from "vitest";
import {
  normalizeAudioDeviceMatch,
  resolveAudioDeviceSelection,
} from "./useAudioDevices";

function device(
  deviceId: string,
  label: string,
  kind: MediaDeviceInfo["kind"] = "audioinput",
): MediaDeviceInfo {
  return {
    deviceId,
    groupId: "",
    kind,
    label,
    toJSON: () => ({ deviceId, groupId: "", kind, label }),
  } as MediaDeviceInfo;
}

describe("normalizeAudioDeviceMatch", () => {
  it("trims and lowercases configured headset names", () => {
    expect(normalizeAudioDeviceMatch("  USB Headset  ")).toBe("usb headset");
  });
});

describe("resolveAudioDeviceSelection", () => {
  const inputs = [
    device("default-input", "Built-in Microphone"),
    device("headset-input", "Jabra USB Headset"),
  ];

  it("selects the configured headset by case-insensitive label fragment", () => {
    expect(
      resolveAudioDeviceSelection(inputs, "usb headset", "", "default-input"),
    ).toBe("headset-input");
  });

  it("keeps the previous valid device when the configured headset is not connected", () => {
    expect(
      resolveAudioDeviceSelection(
        inputs,
        "wrong headset name",
        "headset-input",
        "default-input",
      ),
    ).toBe("headset-input");
  });

  it("falls back to the normal input default when the configured headset does not exist", () => {
    expect(
      resolveAudioDeviceSelection(
        inputs,
        "wrong headset name",
        "missing-device",
        "default-input",
      ),
    ).toBe("default-input");
  });

  it("falls back to browser output default when the configured output does not exist", () => {
    const outputs = [
      device("speaker", "Built-in Speakers", "audiooutput"),
      device("headset-output", "Jabra USB Headset", "audiooutput"),
    ];

    expect(
      resolveAudioDeviceSelection(
        outputs,
        "wrong headset name",
        "missing-output",
        "",
      ),
    ).toBe("");
  });
});
