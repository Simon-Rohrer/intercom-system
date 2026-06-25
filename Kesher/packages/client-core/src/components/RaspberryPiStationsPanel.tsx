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

function stationStatusClass(station: RaspberryPiStationStatus): string {
  if (station.intercomConnected) return "admin-status-ok";
  if (station.online) return "admin-status-wait";
  return "admin-status-warn";
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
        stations.map((station) => (
          <div className="admin-pi-station" key={station.deviceId}>
            <div className="admin-pi-station-main">
              <strong>{station.name}</strong>
              <span>{station.roleId}</span>
              <small>{station.ipAddress || station.deviceId}</small>
            </div>
            <div className="admin-pi-station-state">
              <span className={stationStatusClass(station)}>
                {stationStatusLabel(station)}
              </span>
              <small>{stationDetailLabel(station)}</small>
            </div>
            {station.loginError ? (
              <div className="admin-pi-station-error">
                {station.loginError}
              </div>
            ) : null}
          </div>
        ))
      ) : (
        <div className="admin-pi-empty">{emptyText}</div>
      )}
    </div>
  );
}
