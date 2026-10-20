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
  gpuPercent: 21.8,
  memoryPercent: 61.2,
  temperatureC: 54.8,
  online: true,
  intercomConnected: false,
  effectiveStatus: "waiting_for_intercom",
  listenRoomIds: [],
  talkRoomIds: [],
  micEnabled: false,
  secondsSinceSeen: 12,
};

describe("RaspberryPiStationsPanel", () => {
  it("shows a connected Raspberry with a missing intercom login separately", () => {
    render(<RaspberryPiStationsPanel stations={[baseStation]} />);

    expect(screen.getAllByText("Wartet auf Intercom").length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText("Kamera-1")).toBeInTheDocument();
    expect(screen.getByText("192.168.0.61")).toBeInTheDocument();
    expect(screen.getByText("Stromsparen")).toBeInTheDocument();
    expect(screen.getByText("Launcher v1")).toBeInTheDocument();
    expect(screen.getByText("Browser")).toBeInTheDocument();
    expect(screen.getByText("Läuft")).toBeInTheDocument();
    expect(screen.getByText("CPU")).toBeInTheDocument();
    expect(screen.getByText("37%")).toBeInTheDocument();
    expect(screen.getByText("GPU")).toBeInTheDocument();
    expect(screen.getByText("22%")).toBeInTheDocument();
    expect(screen.getByText("RAM")).toBeInTheDocument();
    expect(screen.getByText("61%")).toBeInTheDocument();
    expect(screen.getByText("Temp")).toBeInTheDocument();
    expect(screen.getByText("55 °C")).toBeInTheDocument();
    expect(screen.getByText("Zuletzt gesehen vor 12 s")).toBeInTheDocument();
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

    expect(screen.getByText("Raspberry nicht verbunden")).toBeInTheDocument();
    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(screen.getByText("Zuletzt gesehen vor 1 min")).toBeInTheDocument();
  });

  it("shows short heartbeat ages instead of hiding them behind now", () => {
    render(
      <RaspberryPiStationsPanel
        stations={[{ ...baseStation, secondsSinceSeen: 2 }]}
      />,
    );

    expect(screen.getByText("Zuletzt gesehen vor 2 s")).toBeInTheDocument();
  });

  it("hides the GPU metric when the Raspberry does not report a GPU value", () => {
    render(
      <RaspberryPiStationsPanel
        stations={[{ ...baseStation, gpuPercent: undefined }]}
      />,
    );

    expect(screen.queryByText("GPU")).not.toBeInTheDocument();
    expect(screen.queryByText("n/a")).not.toBeInTheDocument();
    expect(screen.getByText("CPU")).toBeInTheDocument();
    expect(screen.getByText("RAM")).toBeInTheDocument();
    expect(screen.getByText("Temp")).toBeInTheDocument();
  });

  it("does not show Raspberry audio diagnostic text below the status cards", () => {
    render(
      <RaspberryPiStationsPanel
        stations={[
          {
            ...baseStation,
            loginError: "pulse+pipewire; soundCards=2; captureSources=0",
          },
        ]}
      />,
    );

    expect(screen.queryByText(/pulse\+pipewire/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/captureSources/i)).not.toBeInTheDocument();
  });

  it("keeps a stale login error from replacing an active progress status", () => {
    render(
      <RaspberryPiStationsPanel
        stations={[
          {
            ...baseStation,
            loginError: "previous browser exited with code 1",
            loginStatus: "waiting_for_intercom",
            effectiveStatus: "waiting_for_intercom",
          },
        ]}
      />,
    );

    expect(screen.getAllByText("Wartet auf Intercom").length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByText("Anmeldefehler")).not.toBeInTheDocument();
  });

  it("shows explicit login failures as errors", () => {
    render(
      <RaspberryPiStationsPanel
        stations={[
          {
            ...baseStation,
            browserStatus: "running",
            loginStatus: "login_error",
            loginError: "invalid login",
            effectiveStatus: "login_error",
          },
        ]}
      />,
    );

    expect(screen.getAllByText("Anmeldefehler").length).toBeGreaterThan(0);
  });

  it("shows browser startup as progress instead of a login error", () => {
    render(
      <RaspberryPiStationsPanel
        stations={[
          {
            ...baseStation,
            browserStatus: "starting",
            loginStatus: "starting_browser",
            effectiveStatus: "starting_browser",
          },
        ]}
      />,
    );

    expect(screen.getAllByText("Browser startet").length).toBeGreaterThan(0);
    expect(screen.getByText("Startet")).toBeInTheDocument();
    expect(screen.queryByText("Anmeldefehler")).not.toBeInTheDocument();
  });
});
