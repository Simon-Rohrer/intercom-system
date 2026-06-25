import type { RaspberryPiStationStatus } from "../types";

type RaspberryPiStationsPanelProps = {
  stations: RaspberryPiStationStatus[] | null;
  title?: string;
  emptyText?: string;
  loadingText?: string;
  className?: string;
};

function formatSecondsSinceSeen(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "n/a";
  if (seconds < 5) return "now";
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatMachineStatus(value: string): string {
  return value
    .trim()
    .replace(/_/g, " ")
    .replace(/\s+/g, " ");
}

function stationStatusLabel(station: RaspberryPiStationStatus): string {
  if (!station.online) return "Raspberry not connected";
  if (station.intercomConnected) return "Intercom connected";
  if (station.effectiveStatus === "login_error") return "Login error";
  if (station.effectiveStatus === "waiting_for_intercom") {
    return "Intercom not connected";
  }
  if (station.browserStatus === "running") return "Intercom not connected";
  return formatMachineStatus(station.effectiveStatus) || "Raspberry connected";
}

function stationDetailLabel(station: RaspberryPiStationStatus): string {
  const details = [
    station.online ? "Raspberry connected" : "Raspberry not connected",
  ];
  const browserStatus = formatMachineStatus(station.browserStatus);
  if (browserStatus && browserStatus !== "unknown") {
    details.push(`browser ${browserStatus}`);
  }
  const loginStatus = formatMachineStatus(station.loginStatus);
  if (loginStatus && loginStatus !== "unknown") {
    details.push(loginStatus);
  }
  details.push(`seen ${formatSecondsSinceSeen(station.secondsSinceSeen)}`);
  return details.join(" | ");
}

type StatusTone = "ok" | "wait" | "warn";

function stationStatusTone(station: RaspberryPiStationStatus): StatusTone {
  if (station.intercomConnected) return "ok";
  if (station.online) return "wait";
  return "warn";
}

function stationStatusClass(station: RaspberryPiStationStatus): string {
  if (station.intercomConnected) return "admin-status-ok";
  if (station.online) return "admin-status-wait";
  return "admin-status-warn";
}

function statusToneClass(tone: StatusTone): string {
  return `admin-pi-status-${tone}`;
}

function browserStatusTone(station: RaspberryPiStationStatus): StatusTone {
  if (!station.online) return "warn";
  if (station.browserStatus === "running") return "ok";
  if (
    station.browserStatus === "starting" ||
    station.browserStatus === "not_started"
  ) {
    return "wait";
  }
  return "warn";
}

function intercomStatusTone(station: RaspberryPiStationStatus): StatusTone {
  if (station.intercomConnected) return "ok";
  if (station.effectiveStatus === "login_error") return "warn";
  if (station.online) return "wait";
  return "warn";
}

function statusValue(value: string): string {
  return formatMachineStatus(value) || "unknown";
}

function StatusDot({ tone }: { tone: StatusTone }) {
  return (
    <svg
      className={`admin-pi-status-dot ${statusToneClass(tone)}`}
      viewBox="0 0 12 12"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="6" cy="6" r="4" />
    </svg>
  );
}

function DetailIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3 4.75A1.75 1.75 0 0 1 4.75 3h6.5A1.75 1.75 0 0 1 13 4.75v5.5A1.75 1.75 0 0 1 11.25 12h-6.5A1.75 1.75 0 0 1 3 10.25v-5.5Z" />
      <path d="M6 13h4" />
    </svg>
  );
}

export function RaspberryPiStationsPanel({
  stations,
  title = "Raspberry stations",
  emptyText = "No Raspberry heartbeat received.",
  loadingText = "Loading",
  className = "",
}: RaspberryPiStationsPanelProps) {
  const countLabel = stations ? `${stations.length} known` : loadingText;

  return (
    <div
      className={`admin-pi-stations ${className}`.trim()}
      aria-label="Raspberry Pi stations"
    >
      <div className="admin-pi-stations-header">
        <span>{title}</span>
        <small>{countLabel}</small>
      </div>
      {stations && stations.length > 0 ? (
        stations.map((station) => {
          const tone = stationStatusTone(station);
          return (
            <div
              className={`admin-pi-station ${statusToneClass(tone)}`}
              key={station.deviceId}
              aria-label={`${station.name}: ${stationStatusLabel(station)}; ${stationDetailLabel(station)}`}
            >
              <div className="admin-pi-station-head">
                <div className="admin-pi-station-title">
                  <StatusDot tone={tone} />
                  <div className="admin-pi-station-main">
                    <strong>{station.name}</strong>
                    <span>{station.roleId}</span>
                  </div>
                </div>
                <span
                  className={`admin-pi-status-pill ${stationStatusClass(station)}`}
                >
                  {stationStatusLabel(station)}
                </span>
              </div>
              <div className="admin-pi-station-meta">
                <span>
                  <DetailIcon />
                  {station.ipAddress || station.deviceId}
                </span>
                {station.lowPowerMode ? <span>Low power</span> : null}
                <span>
                  Seen {formatSecondsSinceSeen(station.secondsSinceSeen)}
                </span>
              </div>
              <div className="admin-pi-station-checks">
                <span
                  className={statusToneClass(station.online ? "ok" : "warn")}
                >
                  <small>Pi</small>
                  <strong>{station.online ? "Connected" : "Offline"}</strong>
                </span>
                <span className={statusToneClass(browserStatusTone(station))}>
                  <small>Browser</small>
                  <strong>{statusValue(station.browserStatus)}</strong>
                </span>
                <span className={statusToneClass(intercomStatusTone(station))}>
                  <small>Intercom</small>
                  <strong>
                    {station.intercomConnected
                      ? station.intercomUsername || "Connected"
                      : statusValue(station.loginStatus)}
                  </strong>
                </span>
              </div>
              {station.loginError ? (
                <div className="admin-pi-station-error">
                  {station.loginError}
                </div>
              ) : null}
            </div>
          );
        })
      ) : (
        <div className="admin-pi-empty">{emptyText}</div>
      )}
    </div>
  );
}
