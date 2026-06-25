/**
 * Manages remote audio playback elements, per-track Web Audio analyser nodes,
 * output-device routing (setSinkId), volume gain, and the incoming-audio
 * activity indicator.
 *
 * The caller is responsible for supplying `resolveGainForRemoteSource` and
 * for setting `remoteSourceRef` entries when `pc.ontrack` fires.
 *
 * Exposed refs are shared with the WebRTC `ontrack` handler so the caller can
 * attach new audio elements/analyser nodes without storing them locally.
 */
import { useEffect, useRef, useState } from "react";
import type { RemoteAudioSource } from "./useIntercomSession";

export type UseRemoteAudioOptions = {
  /** Currently selected output device id. */
  selectedOutputDeviceId: string;
  /** Stable ref version for use inside async callbacks. */
  selectedOutputDeviceIdRef: React.MutableRefObject<string>;
  /** Room gain map – listed as dep so volume is reapplied on changes. */
  roomGainById: Record<string, number>;
  /** Direct-user gain map – listed as dep so volume is reapplied on changes. */
  directGainByUserId: Record<string, number>;
  /**
   * A stable ref wrapping the upstream `resolveGainForSourceUser` function.
   * Using a ref means the audio meter loop always calls the latest version
   * without the effect having to re-register.
   */
  resolveGainRef: React.MutableRefObject<(source: RemoteAudioSource) => number>;
  /** Called when a recoverable audio error occurs. */
  onAudioError: (msg: string) => void;
  /** Disable continuous per-track RMS analysis on constrained clients. */
  enableMetering?: boolean;
};

export type UseRemoteAudioResult = {
  /** HTMLAudioElement map keyed by `${trackId}-${streamId}`. */
  remoteAudioRef: React.MutableRefObject<Map<string, HTMLAudioElement>>;
  /** Maps track key to the source resolved from SDP mid/track id. */
  remoteSourceRef: React.MutableRefObject<Map<string, RemoteAudioSource>>;
  /** Per-key Web Audio chain (ctx + analyser + gain + buffer). */
  remoteAnalyserNodesRef: React.MutableRefObject<
    Map<
      string,
      {
        ctx: AudioContext;
        analyser: AnalyserNode;
        gain: GainNode;
        buf: Uint8Array;
      }
    >
  >;
  /** True while incoming audio is detected above the RMS threshold. */
  incomingAudioActive: boolean;
  /** Smoothed, normalized post-gain level per remote track key. */
  remoteLevelByKey: Record<string, number>;

  applyOutputDeviceToAudio: (
    audio: HTMLAudioElement,
    outputDeviceId: string,
  ) => Promise<boolean>;
  applyVolumeToRemoteAudio: (key: string) => void;
  applyVolumeToAllRemoteAudio: () => void;
  startRemoteAudioMeterLoop: () => void;
  stopRemoteAudioMeter: () => void;
  pauseAllRemoteAudio: () => void;
  retryPlayAllRemoteAudio: () => Promise<void>;
  resumeRemoteAudioContexts: () => Promise<void>;
};

export function useRemoteAudio({
  selectedOutputDeviceId,
  roomGainById,
  directGainByUserId,
  resolveGainRef,
  onAudioError,
  enableMetering = true,
}: UseRemoteAudioOptions): UseRemoteAudioResult {
  // ── State ──
  const [incomingAudioActive, setIncomingAudioActive] = useState(false);
  const [remoteLevelByKey, setRemoteLevelByKey] = useState<
    Record<string, number>
  >({});

  // ── Refs ──
  const remoteAudioRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const remoteSourceRef = useRef<Map<string, RemoteAudioSource>>(new Map());
  const remoteAnalyserNodesRef = useRef<
    Map<
      string,
      {
        ctx: AudioContext;
        analyser: AnalyserNode;
        gain: GainNode;
        buf: Uint8Array;
      }
    >
  >(new Map());
  const remoteAudioMeterTimerRef = useRef<number | null>(null);
  const incomingAudioOffTimeoutRef = useRef<number | null>(null);
  const incomingAudioActiveRef = useRef(false);
  const remoteLevelByKeyRef = useRef<Record<string, number>>({});

  // ── Output device ──
  async function applyOutputDeviceToAudio(
    audio: HTMLAudioElement,
    outputDeviceId: string,
  ): Promise<boolean> {
    type AudioWithSinkId = HTMLAudioElement & {
      setSinkId?: (sinkId: string) => Promise<void>;
    };
    const audioWithSink = audio as AudioWithSinkId;
    if (typeof audioWithSink.setSinkId !== "function")
      return outputDeviceId === "";
    const sinkId = outputDeviceId || "default";
    try {
      await audioWithSink.setSinkId(sinkId);
      return true;
    } catch (err) {
      onAudioError(
        `Failed to switch speaker output: ${err instanceof Error ? err.message : "unknown error"}`,
      );
      return false;
    }
  }

  // Apply output device when it changes
  useEffect(() => {
    for (const audio of remoteAudioRef.current.values()) {
      void (async () => {
        const sinkApplied = await applyOutputDeviceToAudio(
          audio,
          selectedOutputDeviceId,
        );
        // Fail closed for explicit device selection to avoid default-device leaks.
        if (selectedOutputDeviceId && !sinkApplied) {
          audio.pause();
          audio.muted = true;
          return;
        }
        audio.muted = false;
        if (audio.srcObject) {
          await audio.play();
        }
      })().catch((err) => {
        onAudioError(
          `Failed to resume remote audio: ${err instanceof Error ? err.message : "unknown error"}`,
        );
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOutputDeviceId]);

  // ── Volume routing ──
  function applyVolumeToRemoteAudio(key: string) {
    const source = remoteSourceRef.current.get(key) || {
      userID: "",
      sourceID: "main",
    };
    const gainValue = resolveGainRef.current(source);
    const analyserNode = remoteAnalyserNodesRef.current.get(key);
    if (analyserNode) analyserNode.gain.gain.value = gainValue;
    const audio = remoteAudioRef.current.get(key);
    if (audio) audio.volume = Math.min(1, Math.max(0, gainValue));
  }

  function applyVolumeToAllRemoteAudio() {
    for (const key of remoteAudioRef.current.keys()) {
      applyVolumeToRemoteAudio(key);
    }
  }

  // Re-apply volume when gain maps change
  useEffect(() => {
    applyVolumeToAllRemoteAudio();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomGainById, directGainByUserId]);

  // ── Incoming audio meter ──
  function stopRemoteAudioMeter() {
    if (remoteAudioMeterTimerRef.current !== null) {
      window.clearTimeout(remoteAudioMeterTimerRef.current);
      remoteAudioMeterTimerRef.current = null;
    }
    if (incomingAudioOffTimeoutRef.current !== null) {
      window.clearTimeout(incomingAudioOffTimeoutRef.current);
      incomingAudioOffTimeoutRef.current = null;
    }
    for (const { ctx } of remoteAnalyserNodesRef.current.values()) {
      void ctx.close();
    }
    remoteAnalyserNodesRef.current.clear();
    incomingAudioActiveRef.current = false;
    remoteLevelByKeyRef.current = {};
    setIncomingAudioActive(false);
    setRemoteLevelByKey({});
  }

  function startRemoteAudioMeterLoop() {
    if (!enableMetering) return;
    if (remoteAudioMeterTimerRef.current !== null) return;
    const tick = () => {
      let active = false;
      const nextLevels: Record<string, number> = {};
      for (const [key, { analyser, buf }] of remoteAnalyserNodesRef.current) {
        analyser.getByteTimeDomainData(
          buf as unknown as Uint8Array<ArrayBuffer>,
        );
        let sum = 0;
        for (const v of buf) {
          const centered = (v - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / buf.length);
        const dbFs = rms > 0 ? 20 * Math.log10(rms) : -60;
        const targetLevel =
          rms < 0.006 ? 0 : Math.max(0, Math.min(1, (dbFs + 48) / 45));
        const previousLevel = remoteLevelByKeyRef.current[key] ?? 0;
        const smoothedLevel =
          targetLevel >= previousLevel
            ? targetLevel
            : Math.max(0, previousLevel * 0.72);
        const quantizedLevel =
          smoothedLevel < 0.025 ? 0 : Math.round(smoothedLevel * 12) / 12;
        nextLevels[key] = quantizedLevel;
        if (rms > 0.018) {
          active = true;
        }
      }
      const previousLevels = remoteLevelByKeyRef.current;
      const nextKeys = Object.keys(nextLevels);
      const levelsChanged =
        nextKeys.length !== Object.keys(previousLevels).length ||
        nextKeys.some((key) => nextLevels[key] !== previousLevels[key]);
      if (levelsChanged) {
        remoteLevelByKeyRef.current = nextLevels;
        setRemoteLevelByKey(nextLevels);
      }
      if (active) {
        if (incomingAudioOffTimeoutRef.current !== null) {
          window.clearTimeout(incomingAudioOffTimeoutRef.current);
          incomingAudioOffTimeoutRef.current = null;
        }
        if (!incomingAudioActiveRef.current) {
          incomingAudioActiveRef.current = true;
          setIncomingAudioActive(true);
        }
      } else if (
        incomingAudioActiveRef.current &&
        incomingAudioOffTimeoutRef.current === null
      ) {
        incomingAudioOffTimeoutRef.current = window.setTimeout(() => {
          incomingAudioOffTimeoutRef.current = null;
          incomingAudioActiveRef.current = false;
          setIncomingAudioActive(false);
        }, 1000);
      }
      remoteAudioMeterTimerRef.current = window.setTimeout(tick, 80);
    };
    remoteAudioMeterTimerRef.current = window.setTimeout(tick, 0);
  }

  function pauseAllRemoteAudio() {
    for (const audio of remoteAudioRef.current.values()) {
      audio.pause();
    }
  }

  async function resumeRemoteAudioContexts() {
    await Promise.allSettled(
      Array.from(remoteAnalyserNodesRef.current.values()).map(({ ctx }) =>
        ctx.state === "suspended" ? ctx.resume() : Promise.resolve(),
      ),
    );
  }

  async function retryPlayAllRemoteAudio() {
    if (remoteAudioRef.current.size === 0) return;
    await resumeRemoteAudioContexts();
    let successfulPlays = 0;
    let firstError: unknown = null;
    await Promise.allSettled(
      Array.from(remoteAudioRef.current.values()).map(async (audio) => {
        try {
          await audio.play();
          successfulPlays += 1;
        } catch (err) {
          if (firstError === null) firstError = err;
        }
      }),
    );
    if (successfulPlays === 0 && firstError) {
      onAudioError(
        `Remote audio playback blocked: ${firstError instanceof Error ? firstError.message : "unknown error"}`,
      );
    }
  }

  return {
    remoteAudioRef,
    remoteSourceRef,
    remoteAnalyserNodesRef,
    incomingAudioActive,
    remoteLevelByKey,
    applyOutputDeviceToAudio,
    applyVolumeToRemoteAudio,
    applyVolumeToAllRemoteAudio,
    startRemoteAudioMeterLoop,
    stopRemoteAudioMeter,
    pauseAllRemoteAudio,
    retryPlayAllRemoteAudio,
    resumeRemoteAudioContexts,
  };
}
