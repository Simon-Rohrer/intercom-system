/**
 * Manages local microphone capture, input-gain processing, input level
 * metering, and track hot-swapping when the selected device changes.
 *
 * Exposed refs (`localStreamRef`, `inputGainNodeRef`, `inputCaptureStreamRef`,
 * `micReinitGenerationRef`) are mutable and shared with the WebRTC layer so the
 * caller can access the current stream / gain node without triggering re-renders.
 */
import { useEffect, useRef, useState } from "react";
import {
  clampAudioGateThresholdDb,
  clampInputGainValue,
  micInputBaseBoost,
  type InputChannelSelection,
} from "../app/settings";
import { resolveTrackInputChannelCount } from "../lib/audioDeviceChannels";
import { meterDbFsFloor, peakAmplitudeToDbFs } from "../lib/presence";

const webAudioGateBufferSize = 256;
const gateAttackTimeMs = 10;
const gateReleaseTimeMs = 150;

function dbFsToAmplitude(dbFs: number): number {
  return Math.pow(10, clampAudioGateThresholdDb(dbFs) / 20);
}

/**
 * Computes gate envelope attack/release coefficients for smooth gate opening/closing.
 * Prevents clicks and pops, and allows faster gate opening for word beginnings.
 */
function computeGateCoefficients(sampleRate: number): {
  attackCoeff: number;
  releaseCoeff: number;
} {
  const attackTimeSeconds = gateAttackTimeMs / 1000;
  const releaseTimeSeconds = gateReleaseTimeMs / 1000;
  // One-pole lowpass: coeff = 1.0 - exp(-2π * fc * dt)
  // where fc is cutoff in Hz, dt is time step
  const attackCoeff = 1.0 - Math.exp(-2 * Math.PI * (1 / attackTimeSeconds) / sampleRate);
  const releaseCoeff = 1.0 - Math.exp(-2 * Math.PI * (1 / releaseTimeSeconds) / sampleRate);
  return { attackCoeff, releaseCoeff };
}

export { computeGateCoefficients };

export function resolveInputChannelIndexes(
  selection: InputChannelSelection,
  capturedChannelCount: number,
): number[] {
  const channelCount = Math.max(
    1,
    Math.min(32, Math.floor(capturedChannelCount) || 1),
  );
  if (selection === "all") {
    return Array.from({ length: channelCount }, (_, index) => index);
  }
  const selectedIndex = Math.floor(selection) - 1;
  return selectedIndex >= 0 && selectedIndex < channelCount
    ? [selectedIndex]
    : [0];
}

type GetUserMediaFn = (
  constraints: MediaStreamConstraints,
) => Promise<MediaStream>;

type LowLatencyAudioConstraintKey =
  | "echoCancellation"
  | "noiseSuppression"
  | "autoGainControl"
  | "channelCount"
  | "latency";

type LowLatencyAudioConstraints = MediaTrackConstraints & {
  latency?: number;
};

const preferredInterfaceChannelCounts = [4, 2] as const;
const preferredIdealInterfaceChannelCount = preferredInterfaceChannelCounts[0];

const lowLatencyAudioConstraintVariants: ReadonlyArray<
  ReadonlyArray<LowLatencyAudioConstraintKey>
> = [
  [
    "echoCancellation",
    "noiseSuppression",
    "autoGainControl",
    "channelCount",
    "latency",
  ],
  [
    "echoCancellation",
    "noiseSuppression",
    "autoGainControl",
    "channelCount",
  ],
  [
    "echoCancellation",
    "noiseSuppression",
    "autoGainControl",
  ],
  ["channelCount", "latency"],
  ["channelCount"],
];

function buildLowLatencyAudioConstraints(
  keys: ReadonlyArray<LowLatencyAudioConstraintKey>,
  exactChannelCount?: number,
  requireAudioProcessingOff = exactChannelCount !== undefined,
): LowLatencyAudioConstraints {
  const constraints: LowLatencyAudioConstraints = {};
  for (const key of keys) {
    switch (key) {
      case "echoCancellation":
        constraints.echoCancellation = requireAudioProcessingOff
          ? { exact: false }
          : false;
        break;
      case "noiseSuppression":
        constraints.noiseSuppression = requireAudioProcessingOff
          ? { exact: false }
          : false;
        break;
      case "autoGainControl":
        constraints.autoGainControl = requireAudioProcessingOff
          ? { exact: false }
          : false;
        break;
      case "channelCount":
        // First require real multichannel streams for USB interfaces. Merely
        // marking the channel count as ideal lets Chromium silently open the
        // device as mono, which hides physical interface inputs. Later
        // candidates retain the ideal/mono-compatible fallback for regular
        // microphones.
        constraints.channelCount =
          exactChannelCount !== undefined
            ? { exact: exactChannelCount }
            : { ideal: preferredIdealInterfaceChannelCount };
        break;
      case "latency":
        constraints.latency = 0;
        break;
    }
  }
  return constraints;
}

export function buildLowLatencyMicConstraintCandidates(
  deviceId: string,
): MediaStreamConstraints[] {
  const candidates: MediaStreamConstraints[] = [];

  // Keep trying the selected device while relaxing optional processing and
  // latency constraints. Falling back to an unconstrained capture too early
  // can silently reopen the computer's built-in microphone instead of the
  // USB interface the user selected.
  if (deviceId) {
    // First request 4-channel and 2-channel streams with disabled browser
    // voice processing as hard requirements. Some browser/device combinations
    // do not expose every DSP constraint, so continue requiring the physical
    // channel count while relaxing only the DSP flags before allowing any
    // mono-compatible candidate.
    for (const channelCount of preferredInterfaceChannelCounts) {
      for (const keys of lowLatencyAudioConstraintVariants.slice(0, 2)) {
        const audio = buildLowLatencyAudioConstraints(keys, channelCount, true);
        candidates.push({
          audio: { ...audio, deviceId: { exact: deviceId } },
          video: false,
        });
      }
      for (const keys of lowLatencyAudioConstraintVariants.slice(0, 2)) {
        const audio = buildLowLatencyAudioConstraints(keys, channelCount, false);
        candidates.push({
          audio: { ...audio, deviceId: { exact: deviceId } },
          video: false,
        });
      }
      for (const keys of lowLatencyAudioConstraintVariants.slice(-2)) {
        const audio = buildLowLatencyAudioConstraints(keys, channelCount, false);
        candidates.push({
          audio: { ...audio, deviceId: { exact: deviceId } },
          video: false,
        });
      }
    }
    for (const keys of lowLatencyAudioConstraintVariants) {
      const audio = buildLowLatencyAudioConstraints(keys);
      candidates.push({
        audio: { ...audio, deviceId: { exact: deviceId } },
        video: false,
      });
    }
    for (const keys of lowLatencyAudioConstraintVariants) {
      const audio = buildLowLatencyAudioConstraints(keys);
      candidates.push({
        audio: { ...audio, deviceId },
        video: false,
      });
    }
  }
  for (const keys of lowLatencyAudioConstraintVariants) {
    const audio = buildLowLatencyAudioConstraints(keys);
    candidates.push({ audio, video: false });
  }
  candidates.push({ audio: true, video: false });
  return candidates;
}

export async function requestLowLatencyMicStream(
  deviceId: string,
  getUserMedia: GetUserMediaFn = (constraints) => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error("navigator.mediaDevices.getUserMedia is not available (is this a secure context?)"));
    }
    return navigator.mediaDevices.getUserMedia(constraints);
  }
): Promise<MediaStream> {
  const candidates = buildLowLatencyMicConstraintCandidates(deviceId);
  let lastError: unknown = null;
  for (const constraints of candidates) {
    try {
      return await getUserMedia(constraints);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error("Failed to access microphone with low-latency constraints");
}

export type UseLocalMicOptions = {
  /** Currently selected input device id (triggers reinit when it changes). */
  selectedInputDeviceId: string;
  /** Stable ref version so callbacks always read the latest value. */
  selectedInputDeviceIdRef: React.MutableRefObject<string>;
  /**
   * Returns the desired gain for the given device id. Must be stable or
   * produced via `useCallback` to avoid spurious effect re-runs.
   */
  selectedInputGainFor: (deviceId: string) => number;
  /** Raw gain map – used only as effect dependency to detect gain changes. */
  inputGainByDeviceId: Record<string, number>;
  /** Physical input channel selected for the current capture device. */
  selectedInputChannel: InputChannelSelection;
  /** Optional channel count hint from native metadata or known USB labels. */
  inputChannelCountHint?: number | null;
  /** User-configurable microphone gate toggle. */
  audioGateEnabled: boolean;
  /** User-configurable microphone gate threshold in dBFS. */
  audioGateThresholdDb: number;
  /** Whether the settings panel is open (controls level meter). */
  isUserSettingsOpen: boolean;
  /** Stable ref so the async WS-open path can check the current value. */
  isUserSettingsOpenRef: React.MutableRefObject<boolean>;
  /** Stable ref to the current voice mode (needed when applying mode to tracks). */
  voiceModeRef: React.MutableRefObject<"always_on" | "ptt">;
  /** The active RTCPeerConnection – used to replace the audio sender on device switch. */
  pcRef: React.MutableRefObject<RTCPeerConnection | null>;
  /** Called when a recoverable audio error occurs. */
  onAudioError: (msg: string) => void;
  /** Called after a new mic stream is obtained so the device list can refresh. */
  onRefreshAudioDevices: () => Promise<void>;
  /** Optional callback to tune the active outgoing RTCRtpSender after add/replace. */
  onAfterAudioSenderUpdated?: (pc: RTCPeerConnection) => Promise<void> | void;
  /**
   * When true the mic-reinit effect fires on `selectedInputDeviceId` changes.
   * Should be `!!(token && appData)` in the caller.
   */
  enableReinit: boolean;
};

export type UseLocalMicResult = {
  /** The outgoing (gain-processed) local stream added to the peer connection. */
  localStreamRef: React.MutableRefObject<MediaStream | null>;
  /** The Web Audio gain node that controls outgoing mic level. */
  inputGainNodeRef: React.MutableRefObject<GainNode | null>;
  /** The raw capture stream from getUserMedia (used for level metering). */
  inputCaptureStreamRef: React.MutableRefObject<MediaStream | null>;
  /** Incremented on every mic reinit to let async paths detect staleness. */
  micReinitGenerationRef: React.MutableRefObject<number>;
  /** Current input level in dBFS, updated by animation-frame loop. */
  inputLevelDbFs: number;
  /** True while a recent clipping peak has been detected. */
  displayedInputClipping: boolean;
  /** True while the local audio monitor (mic loopback) is active. */
  isLocalMonitorActive: boolean;
  /** Number of channels actually exposed by the active browser capture. */
  inputChannelCount: number;

  getMicStream: (deviceId: string) => Promise<MediaStream>;
  buildOutgoingMicStream: (
    sourceStream: MediaStream,
    gainValue: number,
    inputChannel: InputChannelSelection,
  ) => MediaStream;
  stopInputProcessing: () => void;
  startLevelMeter: (stream: MediaStream) => void;
  stopLevelMeter: () => void;
  applyVoiceModeToLocalTracks: (mode: "always_on" | "ptt") => void;
  /** Start playing mic input back to the user via the selected output device. */
  startLocalMonitor: (outputDeviceId: string) => Promise<void>;
  /** Stop local audio monitor loopback. */
  stopLocalMonitor: () => void;
};

export function useLocalMic({
  selectedInputDeviceId,
  selectedInputGainFor,
  inputGainByDeviceId,
  selectedInputChannel,
  inputChannelCountHint,
  audioGateEnabled,
  audioGateThresholdDb,
  isUserSettingsOpen,
  isUserSettingsOpenRef,
  voiceModeRef,
  pcRef,
  onAudioError,
  onRefreshAudioDevices,
  onAfterAudioSenderUpdated,
  enableReinit,
}: UseLocalMicOptions): UseLocalMicResult {
  const effectiveInputGain = (deviceGain: number): number =>
    clampInputGainValue(deviceGain * micInputBaseBoost);

  // ── State ──
  const [inputLevelDbFs, setInputLevelDbFs] = useState(meterDbFsFloor);
  const [inputSamplePeakClipping, setInputSamplePeakClipping] = useState(false);
  const [displayedInputClipping, setDisplayedInputClipping] = useState(false);
  const [isLocalMonitorActive, setIsLocalMonitorActive] = useState(false);
  const [inputChannelCount, setInputChannelCount] = useState(1);

  // ── Refs ──
  const localStreamRef = useRef<MediaStream | null>(null);
  const inputCaptureStreamRef = useRef<MediaStream | null>(null);
  const inputProcessingAudioCtxRef = useRef<AudioContext | null>(null);
  const inputGainNodeRef = useRef<GainNode | null>(null);
  const gateProcessorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const meterMonitorStreamRef = useRef<MediaStream | null>(null);
  const meterRafRef = useRef<number | null>(null);
  const inputClippingDisplayTimeoutRef = useRef<number | null>(null);
  const micReinitGenerationRef = useRef(0);
  const localMonitorCtxRef = useRef<AudioContext | null>(null);
  const localMonitorAudioElRef = useRef<HTMLAudioElement | null>(null);
  const audioGateThresholdDbRef = useRef(audioGateThresholdDb);
  const gateEnvelopeRef = useRef(0.0); // Current gate envelope (0.0 = fully muted, 1.0 = fully open)
  const gateCoefficientsRef = useRef({ attackCoeff: 0.1, releaseCoeff: 0.01 });

  useEffect(() => {
    audioGateThresholdDbRef.current = audioGateThresholdDb;
  }, [audioGateThresholdDb]);

  // ── Mic stream acquisition ──
  async function getMicStream(deviceId: string): Promise<MediaStream> {
    return requestLowLatencyMicStream(deviceId);
  }

  // ── Gain processing ──
  function buildOutgoingMicStream(
    sourceStream: MediaStream,
    gainValue: number,
    inputChannel: InputChannelSelection,
  ): MediaStream {
    const sourceTrack = sourceStream.getAudioTracks()[0];
    if (!sourceTrack) return sourceStream;
    const AudioCtx = window.AudioContext;
    if (!AudioCtx) return sourceStream;
    try {
      const ctx = new AudioCtx({ latencyHint: "interactive" });
      const sampleRate = ctx.sampleRate;
      gateCoefficientsRef.current = computeGateCoefficients(sampleRate);
      gateEnvelopeRef.current = 0.0;
      
      const src = ctx.createMediaStreamSource(sourceStream);
      const gain = ctx.createGain();
      gain.gain.value = effectiveInputGain(gainValue);
      const dest = ctx.createMediaStreamDestination();

      // A browser microphone is usually mono, while USB audio interfaces
      // often expose multiple discrete input channels. Route the selected
      // physical channel, or average all selected channels, into Kesher's
      // mono send track.
      const capturedChannelCount = Math.max(
        1,
        Math.min(
          32,
          resolveTrackInputChannelCount(sourceTrack, inputChannelCountHint),
        ),
      );
      setInputChannelCount(capturedChannelCount);
      let processorInput: AudioNode = src;
      if (capturedChannelCount > 1) {
        const splitter = ctx.createChannelSplitter(capturedChannelCount);
        const monoMixer = ctx.createGain();
        monoMixer.channelCount = 1;
        monoMixer.channelCountMode = "explicit";
        monoMixer.channelInterpretation = "discrete";
        const selectedIndexes = resolveInputChannelIndexes(
          inputChannel,
          capturedChannelCount,
        );
        monoMixer.gain.value = 1 / selectedIndexes.length;
        src.connect(splitter);
        for (const channel of selectedIndexes) {
          splitter.connect(monoMixer, channel, 0);
        }
        processorInput = monoMixer;
      }
      
      let processedInput: AudioNode = processorInput;
      let gate: ScriptProcessorNode | null = null;
      if (audioGateEnabled) {
        gate = ctx.createScriptProcessor(webAudioGateBufferSize, 1, 1);
        gate.onaudioprocess = (event) => {
          const input = event.inputBuffer.getChannelData(0);
          const output = event.outputBuffer.getChannelData(0);
          const threshold = dbFsToAmplitude(audioGateThresholdDbRef.current);
          const { attackCoeff, releaseCoeff } = gateCoefficientsRef.current;
          let gateEnvelope = gateEnvelopeRef.current;

          for (let index = 0; index < input.length; index += 1) {
            const sample = input[index] ?? 0;
            const isAboveThreshold = Math.abs(sample) >= threshold;
            const targetEnvelope = isAboveThreshold ? 1.0 : 0.0;
            const coeff = isAboveThreshold ? attackCoeff : releaseCoeff;
            gateEnvelope =
              targetEnvelope * coeff + gateEnvelope * (1.0 - coeff);
            output[index] = sample * gateEnvelope;
          }

          gateEnvelopeRef.current = gateEnvelope;
        };
        processorInput.connect(gate);
        processedInput = gate;
      }

      processedInput.connect(gain);
      gain.connect(dest);
      const processedTrack = dest.stream.getAudioTracks()[0];
      if (!processedTrack) {
        void ctx.close();
        return sourceStream;
      }
      inputProcessingAudioCtxRef.current = ctx;
      inputGainNodeRef.current = gain;
      gateProcessorNodeRef.current = gate;
      return new MediaStream([processedTrack]);
    } catch {
      return sourceStream;
    }
  }

  function stopInputProcessing() {
    if (inputCaptureStreamRef.current) {
      for (const track of inputCaptureStreamRef.current.getTracks())
        track.stop();
      inputCaptureStreamRef.current = null;
    }
    if (inputProcessingAudioCtxRef.current) {
      void inputProcessingAudioCtxRef.current.close();
      inputProcessingAudioCtxRef.current = null;
    }
    gateProcessorNodeRef.current = null;
    inputGainNodeRef.current = null;
  }

  // ── Level metering ──
  function stopLevelMeter() {
    if (meterRafRef.current !== null) {
      cancelAnimationFrame(meterRafRef.current);
      meterRafRef.current = null;
    }
    analyserRef.current = null;
    if (meterMonitorStreamRef.current) {
      for (const track of meterMonitorStreamRef.current.getTracks())
        track.stop();
      meterMonitorStreamRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    setInputLevelDbFs(meterDbFsFloor);
    setInputSamplePeakClipping(false);
  }

  function startLevelMeter(stream: MediaStream) {
    stopLevelMeter();
    const AudioCtx = window.AudioContext;
    if (!AudioCtx) return;
    const sourceTrack = stream.getAudioTracks()[0];
    if (!sourceTrack) return;
    const monitorTrack = sourceTrack.clone();
    monitorTrack.enabled = true;
    const monitorStream = new MediaStream([monitorTrack]);
    meterMonitorStreamRef.current = monitorStream;
    const ctx = new AudioCtx({ latencyHint: "interactive" });
    audioCtxRef.current = ctx;
    const src = ctx.createMediaStreamSource(monitorStream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(analyser);
    analyserRef.current = analyser;
    const buf = new Float32Array(analyser.fftSize);
    const tick = () => {
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) {
        const abs = Math.abs(v);
        if (abs > peak) peak = abs;
      }
      setInputLevelDbFs(peakAmplitudeToDbFs(peak));
      setInputSamplePeakClipping(peak >= 1);
      meterRafRef.current = requestAnimationFrame(tick);
    };
    meterRafRef.current = requestAnimationFrame(tick);
  }

  // ── Local audio monitor (mic loopback) ──
  function stopLocalMonitor() {
    const el = localMonitorAudioElRef.current;
    if (el) {
      el.pause();
      if (el.srcObject instanceof MediaStream) {
        for (const track of el.srcObject.getTracks()) track.stop();
      }
      el.srcObject = null;
      localMonitorAudioElRef.current = null;
    }
    if (localMonitorCtxRef.current) {
      void localMonitorCtxRef.current.close();
      localMonitorCtxRef.current = null;
    }
    setIsLocalMonitorActive(false);
  }

  async function startLocalMonitor(outputDeviceId: string): Promise<void> {
    const processedStream = localStreamRef.current;
    if (!processedStream) return;
    const AudioCtx = window.AudioContext;
    if (!AudioCtx) return;
    stopLocalMonitor();
    try {
      const ctx = new AudioCtx({ latencyHint: "interactive" });
      localMonitorCtxRef.current = ctx;
      const monitorTrack = processedStream.getAudioTracks()[0]?.clone();
      if (!monitorTrack) {
        void ctx.close();
        localMonitorCtxRef.current = null;
        return;
      }
      monitorTrack.enabled = true;
      const src = ctx.createMediaStreamSource(new MediaStream([monitorTrack]));
      const dest = ctx.createMediaStreamDestination();
      src.connect(dest);
      const el = new Audio();
      el.srcObject = dest.stream;
      const elWithSink = el as HTMLAudioElement & {
        setSinkId?: (sinkId: string) => Promise<void>;
      };
      if (outputDeviceId) {
        if (typeof elWithSink.setSinkId !== "function") {
          throw new Error("Output device selection is not supported");
        }
        await elWithSink.setSinkId(outputDeviceId);
      }
      await el.play();
      localMonitorAudioElRef.current = el;
      setIsLocalMonitorActive(true);
    } catch {
      stopLocalMonitor();
    }
  }

  // ── Track enable/disable ──
  function applyVoiceModeToLocalTracks(mode: "always_on" | "ptt") {
    const stream = localStreamRef.current;
    if (!stream) return;
    const enabled = mode === "always_on";
    for (const track of stream.getAudioTracks()) {
      track.enabled = enabled;
    }
  }

  // ── Mic reinit on device or connection change ──
  useEffect(() => {
    if (!enableReinit || !pcRef.current) return;
    stopLocalMonitor();
    const generation = ++micReinitGenerationRef.current;
    void (async () => {
      const pc = pcRef.current;
      if (!pc) return;
      try {
        const newCaptureStream = await getMicStream(selectedInputDeviceId);
        if (generation !== micReinitGenerationRef.current) {
          for (const t of newCaptureStream.getTracks()) t.stop();
          return;
        }
        stopInputProcessing();
        inputCaptureStreamRef.current = newCaptureStream;
        const newStream = buildOutgoingMicStream(
          newCaptureStream,
          selectedInputGainFor(selectedInputDeviceId),
          selectedInputChannel,
        );
        const newTrack = newStream.getAudioTracks()[0];
        if (!newTrack) return;
        const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
        if (sender) {
          await sender.replaceTrack(newTrack);
        } else {
          pc.addTrack(newTrack, newStream);
        }
        await onAfterAudioSenderUpdated?.(pc);
        if (generation !== micReinitGenerationRef.current) {
          for (const t of newStream.getTracks()) t.stop();
          return;
        }
        if (localStreamRef.current) {
          for (const t of localStreamRef.current.getTracks()) t.stop();
        }
        localStreamRef.current = newStream;
        if (isUserSettingsOpenRef.current) {
          startLevelMeter(newStream);
        } else {
          stopLevelMeter();
        }
        applyVoiceModeToLocalTracks(voiceModeRef.current);
        void onRefreshAudioDevices();
        onAudioError("");
      } catch (e) {
        onAudioError(
          `Failed to switch microphone: ${e instanceof Error ? e.message : "unknown error"}`,
        );
      }
    })();
    return () => {
      if (generation === micReinitGenerationRef.current) {
        micReinitGenerationRef.current += 1;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedInputDeviceId,
    selectedInputChannel,
    inputChannelCountHint,
    audioGateEnabled,
    enableReinit,
  ]);

  // ── Input gain node live update ──
  useEffect(() => {
    const selectedGain = selectedInputGainFor(selectedInputDeviceId);
    if (inputGainNodeRef.current) {
      inputGainNodeRef.current.gain.value = effectiveInputGain(selectedGain);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedInputDeviceId, inputGainByDeviceId]);

  // ── Level meter toggle + local monitor auto-stop (settings panel open/close) ──
  useEffect(() => {
    if (!isUserSettingsOpen) {
      stopLevelMeter();
      stopLocalMonitor();
      return;
    }
    const processedStream = localStreamRef.current;
    if (processedStream) startLevelMeter(processedStream);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isUserSettingsOpen]);

  // ── Clipping display debounce ──
  useEffect(() => {
    if (displayedInputClipping === inputSamplePeakClipping) return;
    if (inputClippingDisplayTimeoutRef.current !== null) {
      window.clearTimeout(inputClippingDisplayTimeoutRef.current);
      inputClippingDisplayTimeoutRef.current = null;
    }
    inputClippingDisplayTimeoutRef.current = window.setTimeout(() => {
      inputClippingDisplayTimeoutRef.current = null;
      setDisplayedInputClipping(inputSamplePeakClipping);
    }, 2000);
    return () => {
      if (inputClippingDisplayTimeoutRef.current !== null) {
        window.clearTimeout(inputClippingDisplayTimeoutRef.current);
        inputClippingDisplayTimeoutRef.current = null;
      }
    };
  }, [inputSamplePeakClipping, displayedInputClipping]);

  // Cleanup clipping timeout and local monitor on unmount
  useEffect(
    () => () => {
      if (inputClippingDisplayTimeoutRef.current !== null) {
        window.clearTimeout(inputClippingDisplayTimeoutRef.current);
        inputClippingDisplayTimeoutRef.current = null;
      }
      stopLocalMonitor();
    },
    [],
  );

  // ── Secure context check ──
  useEffect(() => {
    if (!(window.isSecureContext || window.location.hostname === "localhost")) {
      onAudioError(
        "Microphone capture needs HTTPS (or localhost). Open the app via HTTPS for remote devices.",
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    localStreamRef,
    inputGainNodeRef,
    inputCaptureStreamRef,
    micReinitGenerationRef,
    inputLevelDbFs,
    displayedInputClipping,
    isLocalMonitorActive,
    inputChannelCount,
    getMicStream,
    buildOutgoingMicStream,
    stopInputProcessing,
    startLevelMeter,
    stopLevelMeter,
    applyVoiceModeToLocalTracks,
    startLocalMonitor,
    stopLocalMonitor,
  };
}
