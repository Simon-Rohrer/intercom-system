import type { PiPowerControl } from "../hooks/usePiControl";
import type { RaspberryPiStationStatus } from "../types";

type RaspberryPiStationsPanelProps = {
  stations: RaspberryPiStationStatus[] | null;
  title?: string;
  emptyText?: string;
  loadingText?: string;
  className?: string;
  /** Rollennamen statt IDs („Rolle: Bühne“) */
  roleNames?: ReadonlyMap<string, string>;
  /** Ein/Aus und Neu starten (nur mit dem Recht dazu, siehe usePiControl) */
  power?: PiPowerControl | null;
};

function formatSecondsSinceSeen(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "–";
  if (seconds < 1) return "gerade eben";
  if (seconds < 60) return `vor ${Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `vor ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `vor ${hours} h`;
}

function formatMachineStatus(value: string): string {
  return value
    .trim()
    .replace(/_/g, " ")
    .replace(/\s+/g, " ");
}

const STATUS_LABELS: Record<string, string> = {
  browser_exited: "Browser beendet",
  diagnostic: "Diagnose",
  exited: "Browser beendet",
  intercom_connected: "Intercom verbunden",
  launcher_online: "Launcher online",
  login_error: "Anmeldefehler",
  login_pending: "Meldet sich an",
  login_attempting: "Meldet sich an",
  logging_in: "Meldet sich an",
  not_started: "Nicht gestartet",
  offline: "Offline",
  running: "Läuft",
  starting: "Startet",
  starting_browser: "Browser startet",
  unknown: "unbekannt",
  waiting_for_audio: "Wartet auf Ton",
  waiting_for_intercom: "Wartet auf Intercom",
  waiting_for_server: "Verbindet mit Server",
};

function normalizedStatus(value: string): string {
  return value.trim().toLowerCase();
}

function statusValue(value: string): string {
  const normalized = normalizedStatus(value);
  return STATUS_LABELS[normalized] ?? (formatMachineStatus(value) || "unbekannt");
}

function isFailureStatus(value: string): boolean {
  const normalized = normalizedStatus(value);
  return (
    normalized === "login_error" ||
    normalized === "browser_exited" ||
    normalized === "exited"
  );
}

function stationStatusLabel(station: RaspberryPiStationStatus): string {
  if (!station.online) return "Raspberry nicht verbunden";
  if (station.intercomConnected) return "Intercom verbunden";
  const effectiveStatus = normalizedStatus(station.effectiveStatus);
  if (effectiveStatus && effectiveStatus !== "unknown") {
    if (effectiveStatus === "running") return "Wartet auf Intercom";
    if (effectiveStatus !== "launcher_online") {
      return statusValue(station.effectiveStatus);
    }
  }
  if (normalizedStatus(station.browserStatus) === "running") {
    return "Wartet auf Intercom";
  }
  return statusValue(station.effectiveStatus) || "Raspberry verbunden";
}

function stationDetailLabel(station: RaspberryPiStationStatus): string {
  const details = [
    station.online ? "Raspberry verbunden" : "Raspberry nicht verbunden",
  ];
  const browserStatus = formatMachineStatus(station.browserStatus);
  if (browserStatus && browserStatus !== "unknown") {
    details.push(`Browser ${browserStatus}`);
  }
  const loginStatus = formatMachineStatus(station.loginStatus);
  if (loginStatus && loginStatus !== "unknown") {
    details.push(loginStatus);
  }
  details.push(`zuletzt gesehen ${formatSecondsSinceSeen(station.secondsSinceSeen)}`);
  return details.join(" | ");
}

function launcherVersionLabel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const normalized = trimmed
    .replace(/^kesher-pi-launcher\//i, "v")
    .replace(/^v?(\d+)$/i, "v$1");
  return `Launcher ${normalized}`;
}

type StatusTone = "ok" | "wait" | "warn" | "off";

function stationStatusTone(station: RaspberryPiStationStatus): StatusTone {
  if (station.intercomConnected) return "ok";
  if (!station.online) return "warn";
  if (isFailureStatus(station.effectiveStatus)) return "warn";
  return "wait";
}

function statusToneClass(tone: StatusTone): string {
  return `admin-pi-status-${tone}`;
}

function browserStatusTone(station: RaspberryPiStationStatus): StatusTone {
  if (!station.online) return "warn";
  if (normalizedStatus(station.browserStatus) === "running") return "ok";
  if (isFailureStatus(station.browserStatus)) return "warn";
  if (
    normalizedStatus(station.browserStatus) === "starting" ||
    normalizedStatus(station.browserStatus) === "not_started"
  ) {
    return "wait";
  }
  return "warn";
}

function intercomStatusTone(station: RaspberryPiStationStatus): StatusTone {
  if (station.intercomConnected) return "ok";
  if (isFailureStatus(station.effectiveStatus)) return "warn";
  if (station.online) return "wait";
  return "warn";
}

function hasMetricValue(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function formatPercent(value: number | undefined): string {
  return hasMetricValue(value) ? `${Math.round(value)}%` : "–";
}

function formatTemperature(value: number | undefined): string {
  return hasMetricValue(value) ? `${Math.round(value)} °C` : "–";
}

function metricTone(
  value: number | undefined,
  warningThreshold: number,
  waitThreshold: number,
): StatusTone {
  if (!hasMetricValue(value)) return "wait";
  if (value >= warningThreshold) return "warn";
  if (value >= waitThreshold) return "wait";
  return "ok";
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
  title = "Raspberry-Stationen",
  emptyText = "Noch kein Lebenszeichen von einem Raspberry.",
  loadingText = "Lädt",
  className = "",
  roleNames,
  power,
}: RaspberryPiStationsPanelProps) {
  const countLabel = stations ? `${stations.length} bekannt` : loadingText;

  return (
    <div
      className={`admin-pi-stations ${className}`.trim()}
      aria-label="Raspberry-Pi-Stationen"
    >
      <div className="admin-pi-stations-header">
        <span>{title}</span>
        <small>{countLabel}</small>
      </div>
      {power?.error ? <p className="admin-pi-error">{power.error}</p> : null}
      {stations && stations.length > 0 ? (
        stations.map((station) => {
          const standby = power?.standbyFor(station.deviceId);
          const tone = standby ? "off" : stationStatusTone(station);
          const statusLabel = standby ? "Ruhemodus" : stationStatusLabel(station);
          const launcherLabel = launcherVersionLabel(station.launcherVersion);
          const roleLabel = station.roleId
            ? `Rolle: ${roleNames?.get(station.roleId) || station.roleId}`
            : "";
          const busy = power?.busyDeviceId === station.deviceId;
          return (
            <article
              className={`admin-pi-station ${statusToneClass(tone)}`}
              key={station.deviceId}
              aria-label={`${station.name}: ${statusLabel}; ${stationDetailLabel(station)}`}
            >
              <div className="admin-pi-station-head">
                <StatusDot tone={tone} />
                <div className="admin-pi-station-main">
                  <strong>{station.name}</strong>
                  {roleLabel ? <span>{roleLabel}</span> : null}
                </div>
                <span className="admin-pi-status-pill">{statusLabel}</span>
              </div>
              <div className="admin-pi-station-meta">
                <span>
                  <DetailIcon />
                  {station.ipAddress || station.deviceId}
                </span>
                {station.lowPowerMode ? <span>Stromsparen</span> : null}
                {launcherLabel ? <span>{launcherLabel}</span> : null}
                <span>
                  Zuletzt gesehen {formatSecondsSinceSeen(station.secondsSinceSeen)}
                </span>
              </div>
              {standby ? (
                <p className="admin-pi-standby-hint">
                  Kein Intercom, Bildschirm aus. Der Pi bleibt im Netz und ist nach dem
                  Einschalten in etwa 15 Sekunden wieder da.
                </p>
              ) : (
                <>
                  <div className="admin-pi-station-checks">
                    <span className={statusToneClass(station.online ? "ok" : "warn")}>
                      <small>Pi</small>
                      <strong>{station.online ? "Verbunden" : "Offline"}</strong>
                    </span>
                    <span className={statusToneClass(browserStatusTone(station))}>
                      <small>Browser</small>
                      <strong>{statusValue(station.browserStatus)}</strong>
                    </span>
                    <span className={statusToneClass(intercomStatusTone(station))}>
                      <small>Intercom</small>
                      <strong>
                        {station.intercomConnected
                          ? station.intercomUsername || "Verbunden"
                          : statusValue(station.loginStatus)}
                      </strong>
                    </span>
                  </div>
                  <div className="admin-pi-station-metrics">
                    <span className={statusToneClass(metricTone(station.cpuPercent, 85, 70))}>
                      <small>CPU</small>
                      <strong>{formatPercent(station.cpuPercent)}</strong>
                    </span>
                    {hasMetricValue(station.gpuPercent) ? (
                      <span className={statusToneClass(metricTone(station.gpuPercent, 85, 70))}>
                        <small>GPU</small>
                        <strong>{formatPercent(station.gpuPercent)}</strong>
                      </span>
                    ) : null}
                    <span className={statusToneClass(metricTone(station.memoryPercent, 90, 75))}>
                      <small>RAM</small>
                      <strong>{formatPercent(station.memoryPercent)}</strong>
                    </span>
                    <span className={statusToneClass(metricTone(station.temperatureC, 80, 70))}>
                      <small>Temp</small>
                      <strong>{formatTemperature(station.temperatureC)}</strong>
                    </span>
                  </div>
                </>
              )}
              {power && standby !== undefined ? (
                <div className="admin-pi-power">
                  <span className="admin-pi-power-copy">
                    <strong>{standby ? "Ausgeschaltet" : "Eingeschaltet"}</strong>
                    <small>{standby ? "Einschalten weckt den Pi" : "Aus = Ruhemodus"}</small>
                  </span>
                  <button
                    type="button"
                    className="admin-pi-reboot"
                    disabled={busy}
                    onClick={() => power.onPower(station, "reboot")}
                  >
                    Neu starten
                  </button>
                  <button
                    type="button"
                    role="switch"
                    className="admin-pi-switch"
                    aria-checked={!standby}
                    aria-label={`${station.name} eingeschaltet`}
                    disabled={busy}
                    onClick={() => power.onPower(station, standby ? "on" : "off")}
                  />
                </div>
              ) : null}
            </article>
          );
        })
      ) : (
        <div className="admin-pi-empty">{emptyText}</div>
      )}
    </div>
  );
}
