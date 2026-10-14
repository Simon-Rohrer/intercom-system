import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AdminMenu } from "./AdminMenu";
import type { Bootstrap } from "../../types";

vi.mock("./AdminConfigCard", () => ({
  AdminConfigCard: () => <div data-testid="admin-config-card">config</div>,
}));

vi.mock("./AdminPinCard", () => ({
  AdminPinCard: () => <div data-testid="admin-pin-card">pin</div>,
}));

vi.mock("./AdminMonitoringCard", () => ({
  AdminMonitoringCard: () => (
    <div data-testid="admin-monitoring-card">monitoring</div>
  ),
}));

const appData: Bootstrap = {
  self: { id: "u1", username: "tim", roleId: "op" },
  users: [{ id: "u1", username: "tim", roleId: "op" }],
  roles: [{ id: "op", name: "Operator" }],
  activeRoleIds: [],
  rooms: [
    {
      id: "r1",
      name: "Party Line 1",
      senderRoleIds: ["op"],
      receiverRoleIds: ["op"],
      forcedListenRoleIds: [],
    },
  ],
  broadcastGroups: [],
  ackEnabled: true,
  appVersion: { version: "dev", buildTimestamp: "2026-03-10" },
};

describe("AdminMenu", () => {
  it("renders nothing without token", () => {
    const { container } = render(
      <AdminMenu
        token={null}
        appData={appData}
        refreshBootstrapData={vi.fn()}
        adminPin="1234"
        onUpdateAdminPin={vi.fn().mockResolvedValue(undefined)}
        audioStats={{
          inKbps: 1,
          outKbps: 2,
          jitterMs: 3,
          roundTripMs: 4,
          playoutDelayMs: 5,
        }}
        activeRoutesCount={0}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("shows the selected section and moves monitoring and PIN into their own sections", () => {
    window.localStorage.removeItem("kesher.admin.section");
    render(
      <AdminMenu
        token="token-123"
        appData={appData}
        refreshBootstrapData={vi.fn()}
        adminPin="1234"
        onUpdateAdminPin={vi.fn().mockResolvedValue(undefined)}
        audioStats={{
          inKbps: 1,
          outKbps: 2,
          jitterMs: 3,
          roundTripMs: 4,
          playoutDelayMs: 5,
        }}
        activeRoutesCount={3}
      />,
    );

    expect(screen.getByTestId("admin-config-card")).toBeVisible();
    expect(screen.queryByTestId("admin-monitoring-card")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Live-Zustand" }));
    expect(screen.getByTestId("admin-monitoring-card")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Admin-PIN" }));
    expect(screen.getByTestId("admin-pin-card")).toBeVisible();
  });
});
