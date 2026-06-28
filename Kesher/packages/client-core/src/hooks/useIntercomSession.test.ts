import { describe, expect, it } from "vitest";
import {
  aggregateRemoteRoomLevels,
  resolveUnknownSourceGain,
  trySetReceiverPlayoutDelayHint,
  tuneOpusSdpForSpeech,
  upsertFmtpParams,
  getAdaptivePlayoutDelayHint,
  getPttReleaseTailMs,
} from "./useIntercomSession";

describe("aggregateRemoteRoomLevels", () => {
  it("assigns each remote track level to its active party line", () => {
    expect(
      aggregateRemoteRoomLevels({
        remoteLevelByKey: { trackA: 0.25, trackB: 0.83 },
        remoteSources: new Map([
          ["trackA", { userID: "u1", sourceID: "main" }],
          ["trackB", { userID: "u2", sourceID: "feed-1" }],
        ]),
        routes: [
          {
            senderUserID: "u1",
            sourceID: "main",
            scope: "room",
            targetID: "room-1",
            label: "Room 1",
          },
          {
            senderUserID: "u2",
            sourceID: "feed-1",
            scope: "room",
            targetID: "room-2",
            label: "Room 2",
          },
        ],
        presence: [],
        listenRoomIDs: ["room-1", "room-2"],
      }),
    ).toEqual({ "room-1": 0.25, "room-2": 0.83 });
  });

  it("falls back to always-on presence room assignments", () => {
    expect(
      aggregateRemoteRoomLevels({
        remoteLevelByKey: { trackA: 0.5 },
        remoteSources: new Map([
          ["trackA", { userID: "u1", sourceID: "main" }],
        ]),
        routes: [],
        presence: [
          {
            userId: "u1",
            username: "User 1",
            roleId: "op",
            voiceMode: "always_on",
            micEnabled: true,
            talkRooms: ["room-1", "room-muted"],
          },
        ],
        listenRoomIDs: ["room-1"],
      }),
    ).toEqual({ "room-1": 0.5 });
  });

  it("does not assign direct-call audio to a presence party line", () => {
    expect(
      aggregateRemoteRoomLevels({
        remoteLevelByKey: { trackA: 0.75 },
        remoteSources: new Map([
          ["trackA", { userID: "u1", sourceID: "main" }],
        ]),
        routes: [
          {
            senderUserID: "u1",
            sourceID: "main",
            scope: "direct",
            targetID: "self",
            label: "Direct",
          },
        ],
        presence: [
          {
            userId: "u1",
            username: "User 1",
            roleId: "op",
            voiceMode: "always_on",
            micEnabled: true,
            talkRooms: ["room-1"],
          },
        ],
        listenRoomIDs: ["room-1"],
      }),
    ).toEqual({});
  });
});

describe("useIntercomSession low-latency helpers", () => {
  it("uses a short PTT release tail to avoid cutting buffered speech", () => {
    expect(getPttReleaseTailMs()).toBe(220);
  });

  it("upserts opus fmtp params for low-latency speech with FEC enabled", () => {
    expect(
      upsertFmtpParams(
        "useinbandfec=0;usedtx=0;maxaveragebitrate=64000;stereo=1",
      ),
    ).toBe(
      [
        "useinbandfec=1",
        "usedtx=0",
        "maxaveragebitrate=24000",
        "stereo=0",
        "sprop-stereo=0",
        "cbr=1",
        "ptime=2.5",
        "minptime=2.5",
      ].join(";"),
    );
  });

  it("adds or updates opus fmtp lines in SDP answers", () => {
    const sdp = [
      "v=0",
      "o=- 0 0 IN IP4 127.0.0.1",
      "s=-",
      "t=0 0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=rtpmap:111 opus/48000/2",
      "",
    ].join("\r\n");

    expect(tuneOpusSdpForSpeech(sdp)).toContain(
      "a=fmtp:111 stereo=0;sprop-stereo=0;useinbandfec=1;usedtx=0;cbr=1;ptime=2.5;minptime=2.5;maxaveragebitrate=24000",
    );
  });

  it("uses lower-overhead Opus settings in low-power mode", () => {
    const sdp = [
      "v=0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=rtpmap:111 opus/48000/2",
      "a=fmtp:111 usedtx=0;cbr=1;ptime=2.5;minptime=2.5;maxaveragebitrate=24000",
      "",
    ].join("\r\n");

    const tuned = tuneOpusSdpForSpeech(sdp, true);
    expect(tuned).toContain("usedtx=1");
    expect(tuned).toContain("cbr=0");
    expect(tuned).toContain("ptime=20");
    expect(tuned).toContain("minptime=10");
    expect(tuned).toContain("maxaveragebitrate=16000");
    expect(tuned).toContain("a=ptime:20");
  });

  it("sets playoutDelayHint to zero when the receiver supports it", () => {
    const receiver = { playoutDelayHint: 0.25 };

    expect(trySetReceiverPlayoutDelayHint(receiver, 0)).toBe(true);
    expect(receiver.playoutDelayHint).toBe(0);
  });

  it("fails closed when playoutDelayHint is unsupported or throws", () => {
    expect(trySetReceiverPlayoutDelayHint({}, 0)).toBe(false);

    const receiver = {
      get playoutDelayHint() {
        return 0;
      },
      set playoutDelayHint(_value: number) {
        throw new Error("unsupported");
      },
    };

    expect(trySetReceiverPlayoutDelayHint(receiver, 0)).toBe(false);
  });

  it("returns aggressive 0ms delay for LAN with low jitter", () => {
    expect(getAdaptivePlayoutDelayHint(2, 3)).toBe(0);
  });

  it("returns 20ms delay for good network", () => {
    expect(getAdaptivePlayoutDelayHint(10, 8)).toBe(0.02);
  });

  it("returns 50ms delay for moderate RTT", () => {
    expect(getAdaptivePlayoutDelayHint(35, 12)).toBe(0.05);
  });

  it("returns 100ms delay for higher RTT", () => {
    expect(getAdaptivePlayoutDelayHint(80, 20)).toBe(0.1);
  });

  it("returns 150ms delay for poor network", () => {
    expect(getAdaptivePlayoutDelayHint(120, 30)).toBe(0.15);
  });
});

describe("resolveUnknownSourceGain", () => {
  it("applies attenuated direct gain for unknown source tracks", () => {
    const gain = resolveUnknownSourceGain({
      routes: [
        {
          senderUserID: "u1",
          scope: "direct",
          targetID: "self",
        },
      ],
      selfUserID: "self",
      listenRoomIDs: ["r1"],
      talkRoomIDs: ["r1"],
      roomGainById: {},
      directGainByUserId: { u1: 0.35 },
      presence: [],
      clampGain: (value) => Math.max(0, Math.min(2, value)),
    });

    expect(gain).toBeCloseTo(0.35, 5);
  });

  it("applies attenuated room gain for unknown source tracks", () => {
    const gain = resolveUnknownSourceGain({
      routes: [
        {
          senderUserID: "u1",
          scope: "room",
          targetID: "r1",
        },
      ],
      selfUserID: "self",
      listenRoomIDs: ["r1"],
      talkRoomIDs: ["r1"],
      roomGainById: { r1: 0.25 },
      directGainByUserId: {},
      presence: [],
      clampGain: (value) => Math.max(0, Math.min(2, value)),
    });

    expect(gain).toBeCloseTo(0.25, 5);
  });

  it("falls back to unity gain when no route context is available", () => {
    const gain = resolveUnknownSourceGain({
      routes: [],
      selfUserID: "self",
      listenRoomIDs: [],
      talkRoomIDs: [],
      roomGainById: {},
      directGainByUserId: {},
      presence: [],
      clampGain: (value) => Math.max(0, Math.min(2, value)),
    });

    expect(gain).toBe(1);
  });
});
