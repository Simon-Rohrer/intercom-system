import React from "react";
import { getRaspberryPiStations, getRealtimeStats } from "../../api";
import type {
  RaspberryPiStationStatus,
  RealtimeStatsResponse,
} from "../../types";
import { RaspberryPiStationsPanel } from "../RaspberryPiStationsPanel";
import { AdminCardHeader } from "./AdminCardHeader";
import { useAdminCardOpenState } from "./adminCardOpen";

type AdminMonitoringCardProps = {
  token: string;
  adminPin: string;
  audioStats: {
    inKbps: number;
    outKbps: number;
    jitterMs: number;
    roundTripMs: number;
    playoutDelayMs: number;
  };
  activeRoutesCount: number;
};
const runtimeStatsPollIntervalMs = 2000;

function formatHitRate(hits: number, misses: number): string {
  const total = hits + misses;
  if (total <= 0) return "n/a";
  return `${Math.round((hits / total) * 100)}%`;
}

export function AdminMonitoringCard({
  token,
  adminPin,
  audioStats,
  activeRoutesCount,
}: AdminMonitoringCardProps) {
  const [isOpen, setIsOpen] = useAdminCardOpenState();
  const [isRaspberryOpen, setIsRaspberryOpen] = React.useState(false);
  const [stats, setStats] = React.useState<RealtimeStatsResponse | null>(null);
  const [raspberryStations, setRaspberryStations] = React.useState<
    RaspberryPiStationStatus[] | null
  >(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    let inFlight = false;

    async function pollStats() {
      if (inFlight) return;
      inFlight = true;
      try {
        const [next, nextRaspberryStations] = await Promise.all([
          getRealtimeStats(token, adminPin),
          getRaspberryPiStations(token, adminPin),
        ]);
        if (cancelled) return;
        setStats(next);
        setRaspberryStations(nextRaspberryStations.stations);
        setError("");
      } catch (pollError) {
        if (cancelled) return;
        setError(
          pollError instanceof Error
            ? pollError.message
            : "failed to load realtime stats",
        );
      } finally {
        inFlight = false;
        if (!cancelled) setLoading(false);
      }
    }

    setLoading(true);
    void pollStats();
    const intervalId = window.setInterval(() => {
      void pollStats();
    }, runtimeStatsPollIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [isOpen, token, adminPin]);

  const droppedByType = stats
    ? Object.entries(stats.hub.droppedMessagesByType).sort(
        (a, b) => b[1] - a[1],
      )
    : [];
  const raspberryOnlineCount =
    raspberryStations?.filter((station) => station.online).length ?? 0;
  const raspberryIntercomCount =
    raspberryStations?.filter((station) => station.intercomConnected).length ??
    0;

  const dash = "—";
  const pair = (a?: number, b?: number, unit = "") =>
    stats && a !== undefined && b !== undefined ? `${a} / ${b}${unit}` : dash;
  const droppedCritical = stats?.hub.droppedCriticalMessages ?? 0;
  // Auf einen Blick: was im Betrieb zählt. Alles Weitere unter „Technische Details“.
  const overview: { label: string; value: string; hint?: string; tone?: "ok" | "warn" }[] = [
    {
      label: "Verbundene Stationen",
      value: stats ? String(stats.hub.connectedClients) : dash,
    },
    {
      label: "Raspberry Pis",
      value: raspberryStations ? `${raspberryOnlineCount} / ${raspberryStations.length}` : dash,
      hint: raspberryStations ? `${raspberryIntercomCount} im Intercom` : undefined,
    },
    { label: "Aktive Routen", value: String(activeRoutesCount) },
    {
      label: "Audio ein / aus",
      value: `${audioStats.inKbps} / ${audioStats.outKbps}`,
      hint: "kbps",
    },
    {
      label: "Jitter / Laufzeit",
      value: `${audioStats.jitterMs} / ${audioStats.roundTripMs}`,
      hint: "ms",
    },
    {
      label: "Verworfene Nachrichten",
      value: stats ? String(droppedCritical) : dash,
      hint: "kritisch",
      tone: stats ? (droppedCritical > 0 ? "warn" : "ok") : undefined,
    },
  ];
  const details: [string, string][] = [
    ["Wiedergabe-Verzögerung", `${audioStats.playoutDelayMs} ms`],
    ["Pi im Intercom", raspberryStations ? `${raspberryIntercomCount} / ${raspberryStations.length}` : dash],
    ["Warteschlange normal (gesamt / max)", pair(stats?.hub.normalQueueDepthTotal, stats?.hub.normalQueueDepthMax)],
    ["Warteschlange Priorität (gesamt / max)", pair(stats?.hub.priorityQueueDepthTotal, stats?.hub.priorityQueueDepthMax)],
    ["Verworfen normal", stats ? String(stats.hub.droppedNormalMessages) : dash],
    ["Presence gesendet / zusammengefasst", pair(stats?.hub.presenceBroadcasts, stats?.hub.presenceBroadcastsMerged)],
    ["Media-Peers / Quellen", pair(stats?.media.peers, stats?.media.sources)],
    ["Routing-Sync Anfragen / Läufe", pair(stats?.media.syncRequests, stats?.media.syncRuns)],
    ["Sync-Anfragen zusammengefasst", stats ? String(stats.media.syncRequestsCoalesced) : dash],
    ["Sync-Lauf Ø / max", pair(stats?.media.syncRunAvgMs, stats?.media.syncRunMaxMs, " ms")],
    ["Sprechzustand bis Sync Ø / max", pair(stats?.media.voiceStateToSyncAvgMs, stats?.media.voiceStateToSyncMaxMs, " ms")],
    ["Neuverhandlungen", stats ? String(stats.media.renegotiations) : dash],
    ["Neuverhandlung Ø / max", pair(stats?.media.renegotiationAvgMs, stats?.media.renegotiationMaxMs, " ms")],
    ["Cache Party-Line-Rechte", stats ? formatHitRate(stats.storePolicyCache.roomPolicyHits, stats.storePolicyCache.roomPolicyMisses) : dash],
    ["Cache Broadcast erlaubt", stats ? formatHitRate(stats.storePolicyCache.broadcastAllowedHits, stats.storePolicyCache.broadcastAllowedMisses) : dash],
    ["Cache Broadcast-Party-Line", stats ? formatHitRate(stats.storePolicyCache.broadcastRoomHits, stats.storePolicyCache.broadcastRoomMisses) : dash],
    ["Cache Pflicht-Hören", stats ? formatHitRate(stats.storePolicyCache.forcedListenHits, stats.storePolicyCache.forcedListenMisses) : dash],
    [
      "Verworfene Nachrichtentypen",
      droppedByType.length > 0
        ? droppedByType.slice(0, 3).map(([msgType, count]) => `${msgType}: ${count}`).join(", ")
        : "keine",
    ],
  ];

  return (
    <div className="admin-card admin-monitoring">
      <AdminCardHeader
        title="Live-Zustand"
        isOpen={isOpen}
        onToggle={() => setIsOpen((v) => !v)}
      />
      {isOpen ? (
        <div className="admin-card-body">
          <div className="admin-overview-grid">
            {overview.map((item) => (
              <div className={`admin-overview-tile ${item.tone ?? ""}`} key={item.label}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
                {item.hint ? <small>{item.hint}</small> : null}
              </div>
            ))}
          </div>
          <p className="admin-monitoring-status">
            {error
              ? `Abfrage fehlgeschlagen: ${error}`
              : loading
                ? "Lade …"
                : `Live · alle 2 s · Stand ${
                    stats ? new Date(stats.timestampUnixMs).toLocaleTimeString() : dash
                  }`}
          </p>

          <div className="admin-monitoring-dropdown">
            <button
              type="button"
              className="admin-monitoring-dropdown-toggle"
              onClick={() => setIsRaspberryOpen((value) => !value)}
              aria-expanded={isRaspberryOpen}
            >
              <span>Raspberry Pis</span>
              <small>
                {raspberryStations
                  ? `${raspberryIntercomCount} verbunden / ${raspberryStations.length} bekannt`
                  : "Lade …"}
              </small>
              <span className={`chev ${isRaspberryOpen ? "open" : ""}`}>▾</span>
            </button>
            {isRaspberryOpen ? <RaspberryPiStationsPanel stations={raspberryStations} /> : null}
          </div>

          <details className="admin-details">
            <summary>Technische Details</summary>
            <dl className="admin-details-list">
              {details.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </details>
        </div>
      ) : null}
    </div>
  );
}
