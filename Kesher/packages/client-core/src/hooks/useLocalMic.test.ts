import { act, renderHook } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLowLatencyMicConstraintCandidates,
  requestLowLatencyMicStream,
  computeGateCoefficients,
  resolveInputChannelIndexes,
  useLocalMic,
} from "./useLocalMic";

function useTestLocalMic(lowPowerMode: boolean) {
  const selectedInputDeviceIdRef = useRef("");
  const isUserSettingsOpenRef = useRef(false);
  const voiceModeRef = useRef<"always_on" | "ptt">("ptt");
  const pcRef = useRef<RTCPeerConnection | null>(null);
  return useLocalMic({
    selectedInputDeviceId: "",
    selectedInputDeviceIdRef,
    selectedInputGainFor: () => 1,
    inputGainByDeviceId: {},
    selectedInputChannel: "all",
    audioGateEnabled: false,
    audioGateThresholdDb: -45,
    isUserSettingsOpen: false,
    isUserSettingsOpenRef,
    inputMeteringActive: false,
    voiceModeRef,
    pcRef,
    onAudioError: vi.fn(),
    onRefreshAudioDevices: vi.fn(async () => undefined),
    lowPowerMode,
    enableReinit: false,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useLocalMic helpers", () => {
  it("builds low-latency microphone candidates with strict DSP disable first", () => {
    const candidates = buildLowLatencyMicConstraintCandidates("mic-1");

    expect(candidates[0]).toEqual({
      audio: {
        echoCancellation: { exact: false },
        noiseSuppression: { exact: false },
        autoGainControl: { exact: false },
        channelCount: { exact: 4 },
        latency: 0,
        deviceId: { exact: "mic-1" },
      },
      video: false,
    });
    expect(candidates[6]).toEqual({
      audio: {
        echoCancellation: { exact: false },
        noiseSuppression: { exact: false },
        autoGainControl: { exact: false },
        channelCount: { exact: 2 },
        latency: 0,
        deviceId: { exact: "mic-1" },
      },
      video: false,
    });
    expect(candidates[12]).toEqual({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 4 },
        latency: 0,
        deviceId: { exact: "mic-1" },
      },
      video: false,
    });
    expect(candidates[17]).toEqual({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 4 },
        latency: 0,
        deviceId: "mic-1",
      },
      video: false,
    });
    expect(candidates[candidates.length - 1]).toEqual({
      audio: true,
      video: false,
    });
  });

  it("keeps the selected device while relaxing capture constraints", async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const getUserMedia = vi.fn<
      (constraints: MediaStreamConstraints) => Promise<MediaStream>
    >(async (constraints) => {
      const audio = constraints.audio;
      const channelCount =
        typeof audio === "object" ? audio.channelCount : undefined;
      if (
        typeof channelCount === "object" &&
        "exact" in channelCount &&
        (channelCount.exact === 4 || channelCount.exact === 2)
      ) {
        throw new Error("strict multichannel unsupported");
      }
      return stream;
    });

    const result = await requestLowLatencyMicStream("mic-1", getUserMedia);

    expect(result).toBe(stream);
    expect(getUserMedia).toHaveBeenCalledTimes(13);
    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      audio: {
        echoCancellation: { exact: false },
        noiseSuppression: { exact: false },
        autoGainControl: { exact: false },
        channelCount: { exact: 4 },
        latency: 0,
        deviceId: { exact: "mic-1" },
      },
      video: false,
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(7, {
      audio: {
        echoCancellation: { exact: false },
        noiseSuppression: { exact: false },
        autoGainControl: { exact: false },
        channelCount: { exact: 2 },
        latency: 0,
        deviceId: { exact: "mic-1" },
      },
      video: false,
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(13, {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 4 },
        latency: 0,
        deviceId: { exact: "mic-1" },
      },
      video: false,
    });
  });

  it("rethrows the last capture error if all candidates fail", async () => {
    const finalError = new Error("permission denied");
    const getUserMedia = vi
      .fn<
        (constraints: MediaStreamConstraints) => Promise<MediaStream>
      >()
      .mockRejectedValue(finalError);

    await expect(requestLowLatencyMicStream("", getUserMedia)).rejects.toBe(
      finalError,
    );
    expect(getUserMedia).toHaveBeenLastCalledWith({
      audio: true,
      video: false,
    });
  });

  it("computes gate coefficients for smooth attack and release", () => {
    const { attackCoeff, releaseCoeff } = computeGateCoefficients(48000);

    // Both coefficients should be in [0, 1]
    expect(attackCoeff).toBeGreaterThan(0);
    expect(attackCoeff).toBeLessThanOrEqual(1);
    expect(releaseCoeff).toBeGreaterThan(0);
    expect(releaseCoeff).toBeLessThanOrEqual(1);

    // Attack should be faster (higher coefficient) than release
    expect(attackCoeff).toBeGreaterThan(releaseCoeff);
  });

  it("resolves individual interface inputs and the combined mix", () => {
    expect(resolveInputChannelIndexes("all", 2)).toEqual([0, 1]);
    expect(resolveInputChannelIndexes(1, 2)).toEqual([0]);
    expect(resolveInputChannelIndexes(2, 2)).toEqual([1]);
    expect(resolveInputChannelIndexes(3, 2)).toEqual([0]);
    expect(resolveInputChannelIndexes("all", 4)).toEqual([0, 1, 2, 3]);
    expect(resolveInputChannelIndexes(4, 4)).toEqual([3]);
  });

  it("does not start local metering in low-power mode", () => {
    const AudioContextMock = vi.fn();
    vi.stubGlobal("AudioContext", AudioContextMock);
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockReturnValue(1);
    const stream = {
      getAudioTracks: () => [{ clone: vi.fn() }],
    } as unknown as MediaStream;

    const { result } = renderHook(() => useTestLocalMic(true));

    act(() => {
      result.current.startLevelMeter(stream);
    });

    expect(AudioContextMock).not.toHaveBeenCalled();
    expect(requestAnimationFrameSpy).not.toHaveBeenCalled();
  });

  it("can start input metering while settings are closed", () => {
    const source = { connect: vi.fn() };
    const analyser = {
      fftSize: 0,
      frequencyBinCount: 64,
      getFloatTimeDomainData: vi.fn(),
    };
    const ctx = {
      createMediaStreamSource: vi.fn(() => source),
      createAnalyser: vi.fn(() => analyser),
      close: vi.fn(),
    };
    const AudioContextMock = vi.fn(function (
      this: typeof ctx,
    ) {
      Object.assign(this, ctx);
    });
    vi.stubGlobal("AudioContext", AudioContextMock);
    const MediaStreamMock = vi.fn(function (
      this: { getTracks: () => unknown[]; getAudioTracks: () => unknown[] },
      tracks: unknown[] = [],
    ) {
      this.getTracks = () => tracks;
      this.getAudioTracks = () => tracks;
    });
    vi.stubGlobal("MediaStream", MediaStreamMock);
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockReturnValue(1);
    const track = { clone: vi.fn(() => ({ enabled: false })) };
    const stream = {
      getAudioTracks: () => [track],
    } as unknown as MediaStream;

    const { result } = renderHook(() => useTestLocalMic(false));

    act(() => {
      result.current.startLevelMeter(stream);
    });

    expect(AudioContextMock).toHaveBeenCalled();
    expect(MediaStreamMock).toHaveBeenCalled();
    expect(ctx.createMediaStreamSource).toHaveBeenCalled();
    expect(ctx.createAnalyser).toHaveBeenCalled();
    expect(requestAnimationFrameSpy).toHaveBeenCalled();
  });

  it("meters the pre-PTT monitor stream instead of the gated send stream", () => {
    const source = { connect: vi.fn() };
    const sendGain = { gain: { value: 0 }, connect: vi.fn() };
    const outgoingGate = { gain: { value: 0 }, connect: vi.fn() };
    const analyser = {
      fftSize: 0,
      frequencyBinCount: 64,
      getFloatTimeDomainData: vi.fn(),
    };
    const inputTrack = {
      getSettings: () => ({ channelCount: 1 }),
      stop: vi.fn(),
    };
    const gatedTrack = {
      clone: vi.fn(() => ({ enabled: false })),
      getSettings: () => ({ channelCount: 1 }),
      stop: vi.fn(),
    };
    const monitorTrack = {
      clone: vi.fn(() => ({ enabled: false })),
      getSettings: () => ({ channelCount: 1 }),
      stop: vi.fn(),
    };
    const sourceStream = {
      getAudioTracks: () => [inputTrack],
      getTracks: () => [inputTrack],
    } as unknown as MediaStream;
    const gatedDestinationStream = {
      getAudioTracks: () => [gatedTrack],
      getTracks: () => [gatedTrack],
    } as unknown as MediaStream;
    const monitorDestinationStream = {
      getAudioTracks: () => [monitorTrack],
      getTracks: () => [monitorTrack],
    } as unknown as MediaStream;
    const gainNodes = [sendGain, outgoingGate];
    const destinationStreams = [
      gatedDestinationStream,
      monitorDestinationStream,
    ];
    const createCtx = () => ({
      sampleRate: 48000,
      createMediaStreamSource: vi.fn(() => source),
      createGain: vi.fn(() => gainNodes.shift()),
      createMediaStreamDestination: vi.fn(() => ({
        stream: destinationStreams.shift() ?? monitorDestinationStream,
      })),
      createAnalyser: vi.fn(() => analyser),
      close: vi.fn(),
    });
    const AudioContextMock = vi.fn(function (
      this: ReturnType<typeof createCtx>,
    ) {
      Object.assign(this, createCtx());
    });
    vi.stubGlobal("AudioContext", AudioContextMock);
    const MediaStreamMock = vi.fn(function (
      this: { getTracks: () => unknown[]; getAudioTracks: () => unknown[] },
      tracks: unknown[] = [],
    ) {
      this.getTracks = () => tracks;
      this.getAudioTracks = () => tracks;
    });
    vi.stubGlobal("MediaStream", MediaStreamMock);
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);

    const { result } = renderHook(() => useTestLocalMic(false));
    let sendStream: MediaStream | null = null;

    act(() => {
      sendStream = result.current.buildOutgoingMicStream(
        sourceStream,
        1,
        "all",
      );
    });
    act(() => {
      result.current.startLevelMeter(sendStream as MediaStream);
    });

    expect(monitorTrack.clone).toHaveBeenCalled();
    expect(gatedTrack.clone).not.toHaveBeenCalled();
  });
});
