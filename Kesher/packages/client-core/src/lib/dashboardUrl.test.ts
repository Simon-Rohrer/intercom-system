import { describe, expect, it } from "vitest";
import { dashboardUrl } from "./centralLogin";

describe("dashboardUrl", () => {
  it("keeps the kind of address the page was opened with", () => {
    expect(dashboardUrl({ hostname: "192.168.0.21" })).toBe("https://192.168.0.21:3000/");
    expect(dashboardUrl({ hostname: "intercom.local" })).toBe("https://technik.local/");
    expect(dashboardUrl({ hostname: "intercom.jms.de" })).toBe("https://dashboard.jms.de/");
  });
});
