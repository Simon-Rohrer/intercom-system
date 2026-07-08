import { describe, expect, it } from "vitest";
import type { RaspberryPiStationStatus } from "../types";
import {
  fallbackRaspberryPiOfflineAfterMs,
  normalizeRaspberryPiOfflineAfterMs,
  refreshRaspberryPiStationAges,
} from "./raspberryPiMonitoring";

const baseStation: RaspberryPiStationStatus = {
  deviceId: "kamera-1-pi",
  name: "Kamera-1",
  ipAddress: "192.168.1.51",
  roleId: "camera",
  lowPowerMode: true,
  launcherVersion: "3",
  browserStatus: "running",
  loginStatus: "connected",
  lastSeenUnixMs: 10_000,
  updatedAtUnixMs: 10_000,
  online: true,
  intercomConnected: true,
  effectiveStatus: "intercom_connected",
  intercomUserId: "u1",
  intercomUsername: "Kamera-1",
  intercomRoleId: "camera",
  listenRoomIds: [],
  talkRoomIds: [],
  micEnabled: true,
  secondsSinceSeen: 0,
};

describe("raspberryPiMonitoring", () => {
  it("normalizes missing offline thresholds to the server default", () => {
    expect(normalizeRaspberryPiOfflineAfterMs(0)).toBe(
      fallbackRaspberryPiOfflineAfterMs,
    );
    expect(normalizeRaspberryPiOfflineAfterMs(Number.NaN)).toBe(
      fallbackRaspberryPiOfflineAfterMs,
    );
    expect(normalizeRaspberryPiOfflineAfterMs(30_000)).toBe(30_000);
  });

  it("advances seen age locally while the heartbeat is still fresh", () => {
    const [station] = refreshRaspberryPiStationAges(
      [baseStation],
      17_250,
      12_000,
    );

    expect(station?.online).toBe(true);
    expect(station?.intercomConnected).toBe(true);
    expect(station?.effectiveStatus).toBe("intercom_connected");
    expect(station?.secondsSinceSeen).toBe(7);
  });

  it("marks a stale heartbeat offline even if an old intercom client remains", () => {
    const [station] = refreshRaspberryPiStationAges(
      [baseStation],
      23_000,
      12_000,
    );

    expect(station?.online).toBe(false);
    expect(station?.intercomConnected).toBe(false);
    expect(station?.effectiveStatus).toBe("offline");
    expect(station?.intercomUsername).toBeUndefined();
    expect(station?.secondsSinceSeen).toBe(13);
  });

  it("does not create negative ages when the server clock is ahead", () => {
    const [station] = refreshRaspberryPiStationAges(
      [baseStation],
      9_000,
      12_000,
    );

    expect(station?.online).toBe(true);
    expect(station?.secondsSinceSeen).toBe(0);
  });
});
