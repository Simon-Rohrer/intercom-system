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
  online: true,
  intercomConnected: false,
  effectiveStatus: "waiting_for_intercom",
  secondsSinceSeen: 12,
};

describe("RaspberryPiStationsPanel", () => {
  it("shows a connected Raspberry with a missing intercom login separately", () => {
    render(<RaspberryPiStationsPanel stations={[baseStation]} />);

    expect(screen.getByText("Intercom not connected")).toBeInTheDocument();
    expect(
      screen.getByText(/Raspberry connected \| browser running/),
    ).toBeInTheDocument();
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
    expect(screen.getByText(/seen 1m ago/)).toBeInTheDocument();
  });
});
