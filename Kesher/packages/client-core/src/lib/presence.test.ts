import { describe, expect, it } from "vitest";
import { samePresenceList } from "./presence";
import type { Presence } from "../types";

const basePresence: Presence = {
  userId: "u1",
  username: "User 1",
  roleId: "op",
  listenRooms: ["room-1"],
  talkRooms: ["room-1"],
  voiceMode: "ptt",
  micEnabled: true,
  broadcastActive: false,
  audioState: {
    inputDevices: [],
    outputDevices: [],
    selectedInputDeviceId: "",
    selectedOutputDeviceId: "",
    inputLevelDbFs: -60,
  },
};

describe("samePresenceList", () => {
  it("treats input level changes as presence changes", () => {
    expect(
      samePresenceList(
        [basePresence],
        [
          {
            ...basePresence,
            audioState: {
              ...basePresence.audioState!,
              inputLevelDbFs: -24,
            },
          },
        ],
      ),
    ).toBe(false);
  });
});
