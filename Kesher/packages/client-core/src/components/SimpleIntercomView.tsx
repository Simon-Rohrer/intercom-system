import { useState } from "react";
import { createHoldButtonProps } from "../lib/holdButton";
import type { InputChannelSelection } from "../app/settings";
import { BrandLogo } from "./BrandLogo";
import { LowPowerModeBadge } from "./LowPowerModeBadge";
import { AppShell, type ShellUser } from "./shell/AppShell";
import { resolveEmbedMode } from "../lib/runtimeMode";

type DirectReplyTarget = {
  userId: string;
  username: string;
};

type SimpleIntercomViewProps = {
  connectionState: "connecting" | "connected" | "reconnecting" | "offline";
  lowPowerMode: boolean;
  pttPressed: boolean;
  onStartPpt: () => void;
  onStopPpt: () => void;
  replyTarget: DirectReplyTarget | null;
  selectedInputDeviceId: string;
  onSelectedInputDeviceIdChange: (deviceId: string) => void;
  inputDevices: MediaDeviceInfo[];
  selectedInputChannel: InputChannelSelection;
  inputChannelCount: number;
  onSelectedInputChannelChange: (channel: InputChannelSelection) => void;
  selectedOutputDeviceId: string;
  onSelectedOutputDeviceIdChange: (deviceId: string) => void;
  outputDevices: MediaDeviceInfo[];
  outputSelectionSupported: boolean;
  enableBackgroundAudioRecovery: boolean;
  onEnableBackgroundAudioRecoveryChange: (enabled: boolean) => void;
  keepScreenAwake: boolean;
  onKeepScreenAwakeChange: (enabled: boolean) => void;
  mediaSessionSupported: boolean;
  wakeLockSupported: boolean;
  wakeLockActive: boolean;
  isStandaloneDisplayMode: boolean;
  audioError: string;
  webrtcState: string;
  hasVoiceTarget: boolean;
  hasListenTarget: boolean;
  simplePptTargetLabel: string;
  doLogout: () => void;
  /** Page frame with sidebar (like JMS Control); not passed for kiosk stations. */
  shell?: { user: ShellUser };
};

export function SimpleIntercomView({
  connectionState,
  lowPowerMode,
  pttPressed,
  onStartPpt,
  onStopPpt,
  replyTarget,
  selectedInputDeviceId,
  onSelectedInputDeviceIdChange,
  inputDevices,
  selectedInputChannel,
  inputChannelCount,
  onSelectedInputChannelChange,
  selectedOutputDeviceId,
  onSelectedOutputDeviceIdChange,
  outputDevices,
  outputSelectionSupported,
  enableBackgroundAudioRecovery,
  onEnableBackgroundAudioRecoveryChange,
  keepScreenAwake,
  onKeepScreenAwakeChange,
  mediaSessionSupported,
  wakeLockSupported,
  wakeLockActive,
  isStandaloneDisplayMode,
  audioError,
  webrtcState,
  hasVoiceTarget,
  hasListenTarget,
  simplePptTargetLabel,
  doLogout,
  shell,
}: SimpleIntercomViewProps) {
  const [pressedButton, setPressedButton] = useState<"main" | "reply" | null>(
    null,
  );

  const mainActive =
    pressedButton === "main" || (pttPressed && pressedButton == null);
  const replyActive = pressedButton === "reply";
  const selectedInputChannelValue =
    inputChannelCount > 1 &&
    selectedInputChannel !== "all" &&
    selectedInputChannel <= inputChannelCount
      ? String(selectedInputChannel)
      : "all";
  const allInputsLabel =
    inputChannelCount === 1 ? "Eingang 1" : `Alle ${inputChannelCount} Eingänge`;
  const hasInputDevice = inputDevices.length > 0;
  const runtimeIssues = [
    !hasVoiceTarget
      ? "Dieser Rolle ist keine Party Line zugewiesen. Lege in den Rollen-Einstellungen eine Standard-Party-Line fest."
      : "",
    !hasListenTarget
      ? "Diese Rolle darf keine Party Line hören. Erlaube der Rolle, die Standard-Party-Line zu empfangen."
      : "",
    audioError,
  ].filter(Boolean);
  const mainPttButtonProps = createHoldButtonProps<HTMLButtonElement>({
    disabled: !hasVoiceTarget || !hasInputDevice,
    onStart: () => {
      setPressedButton("main");
      onStartPpt();
    },
    onStop: () => {
      setPressedButton(null);
      onStopPpt();
    },
  });
  const replyButtonProps = createHoldButtonProps<HTMLButtonElement>({
    disabled: !replyTarget,
    onStart: () => {
      if (!replyTarget) return;
      setPressedButton("reply");
      onStartPpt();
    },
    onStop: () => {
      if (!replyTarget) return;
      setPressedButton(null);
      onStopPpt();
    },
  });

  const liveBadge = (
    <span
      className={`simple-live ${connectionState === "connected" ? "connected" : "disconnected"}`}
    >
      <span className="simple-live-dot" />
      {connectionState === "connected" ? "Live" : "Offline"}
    </span>
  );

  const simpleView = (
    <div className={`root app simple-shell ${shell ? "simple-in-shell" : ""}`.trim()}>
      {connectionState !== "connected" && (
        <div className="connection-offline-banner">
          <span className="connection-offline-icon" />
          {connectionState === "reconnecting"
            ? "Verbindung wird wiederhergestellt …"
            : connectionState === "connecting"
              ? "Verbinde …"
              : "Offline"}
        </div>
      )}
      {shell ? null : (
      <header className="simple-runtime-header">
        <BrandLogo className="simple-brand-logo" />
        <span className="simple-header-sep" aria-hidden="true" />
        <div className="simple-header-copy">
          <strong>Einfach</strong>
          <span>{simplePptTargetLabel || "Keine Party Line"}</span>
        </div>
        {liveBadge}
        {lowPowerMode ? <LowPowerModeBadge /> : null}
        {/* Eingebettet (Kesher-Kachel in JMS Control): ein Spiegel – ohne Abmelden */}
        {resolveEmbedMode(window.location.search) ? null : (
        <button
          type="button"
          className="simple-logout"
          onClick={doLogout}
          aria-label="Abmelden"
          title="Abmelden"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <path d="m16 17 5-5-5-5" />
            <path d="M21 12H9" />
          </svg>
          <span>Abmelden</span>
        </button>
        )}
      </header>
      )}
      <section className="simple-controls">
        <button
          className={`simple-ptt hold-button ${mainActive ? "active" : ""}`}
          disabled={!hasVoiceTarget || !hasInputDevice}
          {...mainPttButtonProps}
        >
          <strong>Gedrückt halten zum Sprechen</strong>
          <small>
            {hasInputDevice
              ? `Party Line: ${simplePptTargetLabel}`
              : "Kein Mikrofon"}
          </small>
        </button>
        <div
          className={`simple-audio-status ${
            runtimeIssues.length > 0 ? "has-error" : "is-ready"
          }`}
          role="status"
          aria-label="Audio-Status"
          aria-live="polite"
        >
          <span className="simple-audio-status-dot" aria-hidden="true" />
          <div>
            <strong>
              {runtimeIssues.length > 0
                ? "Audio nicht bereit"
                : hasInputDevice
                  ? "Audio bereit"
                  : "Nur Empfang bereit"}
            </strong>
            {runtimeIssues.length > 0 ? (
              runtimeIssues.map((issue) => <span key={issue}>{issue}</span>)
            ) : !hasInputDevice ? (
              <span>
                Hören bleibt aktiv. Schließe ein Mikrofon an, um zu sprechen.
                {webrtcState ? ` · WebRTC: ${webrtcState}` : ""}
              </span>
            ) : (
              <span>
                Party Line: {simplePptTargetLabel} · Mikrofon bereit
                {webrtcState ? ` · WebRTC: ${webrtcState}` : ""}
              </span>
            )}
          </div>
        </div>
        <button
          className={`simple-reply hold-button ${replyTarget ? "has-caller" : "disabled"} ${replyActive ? "active" : ""}`}
          disabled={!replyTarget}
          {...replyButtonProps}
        >
          <strong>Anrufer antworten</strong>
          <small>
            {replyTarget ? replyTarget.username : "Kein aktiver Anrufer"}
          </small>
        </button>

        <div className="simple-devices">
          <label className="simple-mic">
            <span>Mikrofon</span>
            <select
              value={selectedInputDeviceId}
              onChange={(e) => onSelectedInputDeviceIdChange(e.target.value)}
              disabled={inputDevices.length === 0}
            >
              {inputDevices.length === 0 ? (
                <option value="">Kein Eingabegerät</option>
              ) : null}
              {inputDevices.map((d) => (
                <option key={`simple-mic-${d.deviceId}`} value={d.deviceId}>
                  {d.label || `Mikrofon ${d.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
          </label>
          <label className="simple-mic">
            <span>Interface-Eingang</span>
            <select
              value={selectedInputChannelValue}
              onChange={(event) =>
                onSelectedInputChannelChange(
                  event.target.value === "all"
                    ? "all"
                    : Number(event.target.value),
                )
              }
            >
              <option value="all">{allInputsLabel}</option>
              {inputChannelCount > 1
                ? Array.from({ length: inputChannelCount }, (_, index) => (
                    <option
                      key={`simple-input-channel-${index + 1}`}
                      value={index + 1}
                    >
                      Eingang {index + 1}
                    </option>
                  ))
                : null}
            </select>
          </label>
          <label className="simple-mic">
            <span>Lautsprecher</span>
            <select
              value={selectedOutputDeviceId}
              onChange={(e) => onSelectedOutputDeviceIdChange(e.target.value)}
              disabled={outputDevices.length === 0}
            >
              <option value="">Systemstandard</option>
              {outputDevices.length === 0 ? (
                <option value="" disabled>
                  Keine Ausgabegeräte
                </option>
              ) : null}
              {outputDevices.map((d) => (
                <option key={`simple-out-${d.deviceId}`} value={d.deviceId}>
                  {d.label || `Ausgang ${d.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
            {!outputSelectionSupported ? (
              <small>
                Lautsprecher-Auswahl wird hier nicht unterstützt; es wird der
                Systemstandard genutzt.
              </small>
            ) : null}
          </label>
          <label className="simple-check">
            <input
              type="checkbox"
              checked={enableBackgroundAudioRecovery}
              onChange={(event) =>
                onEnableBackgroundAudioRecoveryChange(event.target.checked)
              }
            />
            <span>Audio im Hintergrund wiederherstellen</span>
          </label>
          <label className="simple-check">
            <input
              type="checkbox"
              checked={keepScreenAwake}
              disabled={!wakeLockSupported}
              onChange={(event) => onKeepScreenAwakeChange(event.target.checked)}
            />
            <span>Gerät wach halten, solange verbunden</span>
          </label>
          <small className="simple-capabilities">
            Mediensteuerung:{" "}
            {mediaSessionSupported ? "unterstützt" : "nicht unterstützt"} · Wake
            Lock:{" "}
            {wakeLockSupported
              ? wakeLockActive
                ? "aktiv"
                : "verfügbar"
              : "nicht unterstützt"}{" "}
            · Modus: {isStandaloneDisplayMode ? "installierte App" : "Browser-Tab"}
          </small>
        </div>
      </section>
    </div>
  );

  if (!shell) return simpleView;
  return (
    <AppShell
      user={shell.user}
      items={[
        {
          id: "intercom",
          label: "Intercom",
          icon: "intercom",
          active: true,
          onSelect: () => undefined,
        },
      ]}
      status={
        <div className="k-station-status">
          <div className="k-station-who">
            <strong>{shell.user.role}</strong>
            <span>{simplePptTargetLabel || "Keine Party Line"}</span>
          </div>
          {liveBadge}
          {lowPowerMode ? <LowPowerModeBadge /> : null}
        </div>
      }
    >
      {simpleView}
    </AppShell>
  );
}
