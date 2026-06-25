import { describe, expect, it } from "vitest";
import { resolveLowPowerMode, resolveViewModeOverride } from "./runtimeMode";

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
