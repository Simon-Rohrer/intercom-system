import type { RaspberryPiStationStatus } from "../types";

export const fallbackRaspberryPiOfflineAfterMs = 12_000;

function finitePositiveNumber(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function stationAgeMs(station: RaspberryPiStationStatus, nowUnixMs: number): number {
  if (Number.isFinite(station.lastSeenUnixMs) && station.lastSeenUnixMs > 0) {
    return Math.max(0, nowUnixMs - station.lastSeenUnixMs);
  }
  return Math.max(0, Math.round(station.secondsSinceSeen * 1000));
}

export function normalizeRaspberryPiOfflineAfterMs(value: number): number {
  return finitePositiveNumber(value, fallbackRaspberryPiOfflineAfterMs);
}

export function refreshRaspberryPiStationAges(
  stations: RaspberryPiStationStatus[],
  nowUnixMs: number,
  offlineAfterMs: number,
): RaspberryPiStationStatus[] {
  const normalizedOfflineAfterMs =
    normalizeRaspberryPiOfflineAfterMs(offlineAfterMs);

  return stations.map((station) => {
    const ageMs = stationAgeMs(station, nowUnixMs);
    const secondsSinceSeen = Math.floor(ageMs / 1000);
    const online = ageMs <= normalizedOfflineAfterMs;

    if (online) {
      if (station.online && station.secondsSinceSeen === secondsSinceSeen) {
        return station;
      }
      return {
        ...station,
        online: true,
        secondsSinceSeen,
      };
    }

    if (
      !station.online &&
      !station.intercomConnected &&
      station.effectiveStatus === "offline" &&
      station.secondsSinceSeen === secondsSinceSeen
    ) {
      return station;
    }

    return {
      ...station,
      online: false,
      intercomConnected: false,
      effectiveStatus: "offline",
      intercomUserId: undefined,
      intercomUsername: undefined,
      intercomRoleId: undefined,
      secondsSinceSeen,
    };
  });
}
