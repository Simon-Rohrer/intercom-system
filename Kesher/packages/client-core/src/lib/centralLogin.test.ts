import { describe, expect, it } from "vitest";
import { centralIdentityKey, resolveStoredTokenRestore } from "./centralLogin";

const tim = { name: "Tim", roleId: "ton", admin: false };

describe("resolveStoredTokenRestore", () => {
  it("keeps the tab's session for the same central identity", () => {
    expect(
      resolveStoredTokenRestore({
        storedToken: "t1",
        storedIdentityKey: centralIdentityKey(tim),
        identity: tim,
        raspberryRemoteLogin: false,
      }),
    ).toBe("keep");
  });

  it("drops the session when someone else is signed in centrally", () => {
    expect(
      resolveStoredTokenRestore({
        storedToken: "t1",
        storedIdentityKey: centralIdentityKey(tim),
        identity: { name: "Anna", roleId: "licht", admin: false },
        raspberryRemoteLogin: false,
      }),
    ).toBe("discard");
  });

  it("never restores the own session when opened with login=raspberry", () => {
    expect(
      resolveStoredTokenRestore({
        storedToken: "t1",
        storedIdentityKey: centralIdentityKey(tim),
        identity: tim,
        raspberryRemoteLogin: true,
      }),
    ).toBe("discard");
  });

  it("has nothing to do without a stored token", () => {
    expect(
      resolveStoredTokenRestore({
        storedToken: null,
        storedIdentityKey: "",
        identity: tim,
        raspberryRemoteLogin: true,
      }),
    ).toBe("none");
  });
});
