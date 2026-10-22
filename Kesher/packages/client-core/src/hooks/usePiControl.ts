import { useCallback, useEffect, useState } from "react";
import { fetchPiControl, sendPiControl, type PiControlState, type PiPowerAction } from "../lib/piControl";
import type { RaspberryPiStationStatus } from "../types";

const POLL_MS = 15_000;

const CONFIRM: Record<PiPowerAction, ((name: string) => string) | null> = {
  on: null,
  off: (name) =>
    `${name} ausschalten? Das Intercom auf dem Pi wird beendet und der Bildschirm geht aus. Der Pi bleibt im Netz und lässt sich hier wieder einschalten.`,
  reboot: (name) => `${name} neu starten? Das Intercom auf dem Pi ist dabei etwa eine Minute weg.`,
};

export type PiPowerControl = {
  /** Ruhemodus des Pi – undefined, wenn JMS Control ihn nicht kennt (dann kein Schalter). */
  standbyFor: (deviceId: string) => boolean | undefined;
  busyDeviceId: string;
  error: string;
  onPower: (station: RaspberryPiStationStatus, action: PiPowerAction) => void;
};

/**
 * Schalter der Raspberry-Karten: fragt JMS Control, ob die angemeldete Person schalten darf,
 * und hält den Ruhemodus aktuell. null = kein Schalter (kein Recht oder keine zentrale Anmeldung).
 */
export function usePiControl(enabled: boolean): PiPowerControl | null {
  const [state, setState] = useState<PiControlState | null>(null);
  const [busyDeviceId, setBusyDeviceId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!enabled) {
      setState(null);
      return;
    }
    const controller = new AbortController();
    const load = () =>
      void fetchPiControl(controller.signal).then((next) => {
        if (!controller.signal.aborted) setState(next);
      });
    load();
    const id = window.setInterval(load, POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(id);
    };
  }, [enabled]);

  const onPower = useCallback((station: RaspberryPiStationStatus, action: PiPowerAction) => {
    const ask = CONFIRM[action];
    if (ask && !window.confirm(ask(station.name || "Der Raspberry Pi"))) return;
    setBusyDeviceId(station.deviceId);
    setError("");
    sendPiControl(station.deviceId, action)
      .then(({ standby }) =>
        setState((current) =>
          current
            ? { ...current, standbyByDeviceId: { ...current.standbyByDeviceId, [station.deviceId]: standby } }
            : current,
        ),
      )
      .catch((err: unknown) =>
        setError(`${station.name}: ${err instanceof Error ? err.message : "Befehl nicht gesendet"}`),
      )
      .finally(() => setBusyDeviceId(""));
  }, []);

  if (!state?.allowed) return null;
  return {
    standbyFor: (deviceId) => state.standbyByDeviceId[deviceId],
    busyDeviceId,
    error,
    onPower,
  };
}
