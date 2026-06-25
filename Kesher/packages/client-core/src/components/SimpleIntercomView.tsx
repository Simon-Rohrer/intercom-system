import { useState } from "react";
import { createHoldButtonProps } from "../lib/holdButton";
import type { InputChannelSelection } from "../app/settings";
import { LowPowerModeBadge } from "./LowPowerModeBadge";

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
    inputChannelCount === 1 ? "Input 1" : `All ${inputChannelCount} inputs`;
  const hasInputDevice = inputDevices.length > 0;
  const runtimeIssues = [
    !hasVoiceTarget
      ? "No party line is assigned to this role. Set a default party line in the role settings."
      : "",
    !hasListenTarget
      ? "No receive party line is assigned to this role. Allow the role to receive the default party line."
      : "",
    !hasInputDevice
      ? "No microphone is available to Chromium. Check USB power, PipeWire and browser permissions."
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

  return (
    <div className="root app simple-shell">
      {lowPowerMode ? (
        <header className="simple-runtime-header">
          <LowPowerModeBadge />
        </header>
      ) : null}
      {connectionState !== "connected" && (
        <div className="connection-offline-banner">
          <span className="connection-offline-icon" />
          {connectionState === "reconnecting"
            ? "Reconnecting\u2026"
            : connectionState === "connecting"
              ? "Connecting\u2026"
              : "Offline"}
        </div>
      )}
      <section className="simple-controls">
        <div className="simple-top-actions">
          <button className="simple-logout" onClick={doLogout}>
            Logout
          </button>
        </div>
        <button
          className={`simple-ptt hold-button ${mainActive ? "active" : ""}`}
          disabled={!hasVoiceTarget || !hasInputDevice}
          {...mainPttButtonProps}
        >
          Hold to talk
          <small>{simplePptTargetLabel}</small>
        </button>
        <div
          className={`simple-audio-status ${
            runtimeIssues.length > 0 ? "has-error" : "is-ready"
          }`}
          role="status"
          aria-label="Audio runtime status"
          aria-live="polite"
        >
          <strong>
            {runtimeIssues.length > 0 ? "Audio not ready" : "Audio ready"}
          </strong>
          {runtimeIssues.length > 0 ? (
            runtimeIssues.map((issue) => <span key={issue}>{issue}</span>)
          ) : (
            <span>
              Party line: {simplePptTargetLabel} · Microphone ready
              {webrtcState ? ` · WebRTC: ${webrtcState}` : ""}
            </span>
          )}
        </div>
        <button
          className={`simple-reply hold-button ${replyTarget ? "" : "disabled"} ${replyActive ? "active" : ""}`}
          disabled={!replyTarget}
          {...replyButtonProps}
        >
          Reply to caller
          <small>
            {replyTarget ? replyTarget.username : "No active caller"}
          </small>
        </button>

        <label className="simple-mic">
          <span>Microphone</span>
          <select
            value={selectedInputDeviceId}
            onChange={(e) => onSelectedInputDeviceIdChange(e.target.value)}
            disabled={inputDevices.length === 0}
          >
            {inputDevices.length === 0 ? (
              <option value="">No input devices</option>
            ) : null}
            {inputDevices.map((d) => (
              <option key={`simple-mic-${d.deviceId}`} value={d.deviceId}>
                {d.label || `Mic ${d.deviceId.slice(0, 6)}`}
              </option>
            ))}
          </select>
        </label>
        <label className="simple-mic">
          <span>Interface input</span>
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
                    Input {index + 1}
                  </option>
                ))
              : null}
          </select>
        </label>
        <label className="simple-mic">
          <span>Speaker output</span>
          <select
            value={selectedOutputDeviceId}
            onChange={(e) => onSelectedOutputDeviceIdChange(e.target.value)}
            disabled={outputDevices.length === 0}
          >
            <option value="">System default</option>
            {outputDevices.length === 0 ? (
              <option value="" disabled>
                No output devices
              </option>
            ) : null}
            {outputDevices.map((d) => (
              <option key={`simple-out-${d.deviceId}`} value={d.deviceId}>
                {d.label || `Output ${d.deviceId.slice(0, 6)}`}
              </option>
            ))}
          </select>
          {!outputSelectionSupported ? (
            <small>
              Explicit speaker selection is not supported; using system default
              output.
            </small>
          ) : null}
        </label>
        <label className="simple-mic">
          <span>
            <input
              type="checkbox"
              checked={enableBackgroundAudioRecovery}
              onChange={(event) =>
                onEnableBackgroundAudioRecoveryChange(event.target.checked)
              }
            />{" "}
            Background audio assist
          </span>
        </label>
        <label className="simple-mic">
          <span>
            <input
              type="checkbox"
              checked={keepScreenAwake}
              disabled={!wakeLockSupported}
              onChange={(event) =>
                onKeepScreenAwakeChange(event.target.checked)
              }
            />{" "}
            Keep device awake while connected
          </span>
          <small>
            Media controls:{" "}
            {mediaSessionSupported ? "supported" : "not supported"} · Wake lock:{" "}
            {wakeLockSupported
              ? wakeLockActive
                ? "active"
                : "available"
              : "not supported"}{" "}
            · Install mode:{" "}
            {isStandaloneDisplayMode ? "installed app" : "browser tab"}
          </small>
        </label>
      </section>
    </div>
  );
}
