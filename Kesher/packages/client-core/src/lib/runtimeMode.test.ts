import { describe, expect, it } from "vitest";
import {
  resolveBareMode,
  resolveEmbedMode,
  resolveHideTalkControls,
  resolveLowPowerMode,
  resolveRaspberryRemoteLogin,
  resolveViewModeOverride,
} from "./runtimeMode";

describe("resolveLowPowerMode", () => {
  it("enables low-power mode for supported URL values", () => {
    expect(resolveLowPowerMode("?lowPower=1")).toBe(true);
    expect(resolveLowPowerMode("?lowPower=true")).toBe(true);
  });

  it("keeps the normal runtime for absent or unsupported values", () => {
    expect(resolveLowPowerMode("")).toBe(false);
    expect(resolveLowPowerMode("?lowPower=0")).toBe(false);
    expect(resolveLowPowerMode("?lowPower=True")).toBe(false);
  });
});

describe("resolveViewModeOverride", () => {
  it("accepts supported view mode overrides", () => {
    expect(resolveViewModeOverride("?viewMode=simple")).toBe("simple");
    expect(resolveViewModeOverride("?viewMode=station")).toBe("station");
  });

  it("ignores absent or unsupported view mode values", () => {
    expect(resolveViewModeOverride("")).toBeNull();
    expect(resolveViewModeOverride("?viewMode=Simple")).toBeNull();
    expect(resolveViewModeOverride("?viewMode=compact")).toBeNull();
  });
});

describe("resolveEmbedMode", () => {
  it("enables the embedded layout for supported URL values", () => {
    expect(resolveEmbedMode("?embed=1")).toBe(true);
    expect(resolveEmbedMode("?viewMode=station&embed=true")).toBe(true);
  });

  it("keeps the normal layout otherwise", () => {
    expect(resolveEmbedMode("")).toBe(false);
    expect(resolveEmbedMode("?embed=0")).toBe(false);
  });
});

describe("resolveHideTalkControls", () => {
  it("hides the talk controls only when asked to", () => {
    expect(resolveHideTalkControls("?controls=0")).toBe(true);
    expect(resolveHideTalkControls("?controls=false")).toBe(true);
    expect(resolveHideTalkControls("?controls=1")).toBe(false);
    expect(resolveHideTalkControls("")).toBe(false);
  });
});

describe("resolveBareMode", () => {
  it("keeps kiosk and embedded windows without the sidebar", () => {
    expect(resolveBareMode("?lowPower=1")).toBe(true);
    expect(resolveBareMode("?autoLogin=1&username=Pi&roleName=Ton")).toBe(true);
    expect(resolveBareMode("?viewMode=station")).toBe(true);
    expect(resolveBareMode("?viewMode=chat")).toBe(true);
    expect(resolveBareMode("?embed=1&controls=0")).toBe(true);
  });

  it("uses the sidebar for normal browser and app windows", () => {
    expect(resolveBareMode("")).toBe(false);
    expect(resolveBareMode("?debug=1")).toBe(false);
    expect(resolveBareMode("?login=raspberry")).toBe(false);
    expect(resolveBareMode("?autoLogin=0")).toBe(false);
  });
});

describe("resolveRaspberryRemoteLogin", () => {
  it("opens the Raspberry tab only for login=raspberry", () => {
    expect(resolveRaspberryRemoteLogin("?login=raspberry")).toBe(true);
    expect(resolveRaspberryRemoteLogin("")).toBe(false);
    expect(resolveRaspberryRemoteLogin("?login=admin")).toBe(false);
  });
});
