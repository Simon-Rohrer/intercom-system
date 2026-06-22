import { describe, expect, it } from "vitest";
import {
  resolveInputDeviceChannelCount,
  resolveTrackInputChannelCount,
} from "./audioDeviceChannels";

describe("audio device channel detection", () => {
  it("uses native device input channel metadata when available", () => {
    expect(
      resolveInputDeviceChannelCount({
        label: "Scarlett 2i2 USB",
        inputChannels: 4,
      }),
    ).toBe(4);
  });

  it("infers common 2 and 4 input USB interfaces from browser labels", () => {
    expect(resolveInputDeviceChannelCount({ label: "Scarlett 2i2 USB" })).toBe(
      2,
    );
    expect(resolveInputDeviceChannelCount({ label: "Scarlett 4i4 USB" })).toBe(
      4,
    );
    expect(resolveInputDeviceChannelCount({ label: "UMC404HD 192k" })).toBe(4);
  });

  it("does not guess for generic built-in microphones", () => {
    expect(
      resolveInputDeviceChannelCount({ label: "MacBook Pro Microphone" }),
    ).toBeNull();
  });

  it("prefers track capabilities over mono settings", () => {
    const track = {
      getSettings: () => ({ channelCount: 1 }),
      getCapabilities: () => ({ channelCount: { min: 1, max: 2 } }),
    } as unknown as MediaStreamTrack;

    expect(resolveTrackInputChannelCount(track, null)).toBe(2);
  });

  it("uses a device hint when the browser reports only mono capture", () => {
    const track = {
      getSettings: () => ({ channelCount: 1 }),
      getCapabilities: () => ({ channelCount: { min: 1, max: 1 } }),
    } as unknown as MediaStreamTrack;

    expect(resolveTrackInputChannelCount(track, 4)).toBe(4);
  });
});
