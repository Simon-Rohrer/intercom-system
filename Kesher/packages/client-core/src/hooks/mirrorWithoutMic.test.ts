import { afterEach, describe, expect, it } from "vitest";
import { mirrorWithoutMic } from "./useIntercomSession";

describe("mirrorWithoutMic", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("asks for no microphone in a mirror session (Kesher tile in JMS Control)", () => {
    window.history.replaceState(null, "", "/?secondary=1&embed=1");
    expect(mirrorWithoutMic({ secondary: true })).toBe(true);
  });

  it("still captures when the tile was given a microphone explicitly", () => {
    window.history.replaceState(null, "", "/?secondary=1&audioInputMatch=Headset");
    expect(mirrorWithoutMic({ secondary: true })).toBe(false);
  });

  it("never affects normal sessions", () => {
    expect(mirrorWithoutMic({ secondary: false })).toBe(false);
    expect(mirrorWithoutMic(null)).toBe(false);
  });
});
