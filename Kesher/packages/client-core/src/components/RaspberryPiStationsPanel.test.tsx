import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RaspberryPiStationsPanel } from "./RaspberryPiStationsPanel";
import type { RaspberryPiStationStatus } from "../types";

const baseStation: RaspberryPiStationStatus = {
  deviceId: "kamera-1-pi",
  name: "Kamera-1",
  ipAddress: "192.168.0.61",
  roleId: "cam1",
  lowPowerMode: true,
  launcherVersion: "kesher-pi-launcher/1",
  browserStatus: "running",
  loginStatus: "waiting_for_intercom",
  lastSeenUnixMs: 1,
  updatedAtUnixMs: 1,
  cpuPercent: 37.4,
  memoryPercent: 61.2,
  temperatureC: 54.8,
  online: true,
  intercomConnected: false,
  effectiveStatus: "waiting_for_intercom",
  secondsSinceSeen: 12,
};

describe("RaspberryPiStationsPanel", () => {
  it("shows a connected Raspberry with a missing intercom login separately", () => {
    render(<RaspberryPiStationsPanel stations={[baseStation]} />);

    expect(screen.getByText("Intercom not connected")).toBeInTheDocument();
    expect(screen.getByText("Kamera-1")).toBeInTheDocument();
    expect(screen.getByText("192.168.0.61")).toBeInTheDocument();
    expect(screen.getByText("Low power")).toBeInTheDocument();
    expect(screen.getByText("Browser")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText("CPU")).toBeInTheDocument();
    expect(screen.getByText("37%")).toBeInTheDocument();
    expect(screen.getByText("RAM")).toBeInTheDocument();
    expect(screen.getByText("61%")).toBeInTheDocument();
    expect(screen.getByText("Temp")).toBeInTheDocument();
    expect(screen.getByText("55 C")).toBeInTheDocument();
    expect(screen.getByText("Seen 12s ago")).toBeInTheDocument();
  });

  it("shows when the Raspberry itself is not connected", () => {
    render(
      <RaspberryPiStationsPanel
        stations={[
          {
            ...baseStation,
            online: false,
            browserStatus: "unknown",
            loginStatus: "unknown",
            effectiveStatus: "offline",
            secondsSinceSeen: 61,
          },
        ]}
      />,
    );

    expect(screen.getByText("Raspberry not connected")).toBeInTheDocument();
    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(screen.getByText("Seen 1m ago")).toBeInTheDocument();
  });
});
