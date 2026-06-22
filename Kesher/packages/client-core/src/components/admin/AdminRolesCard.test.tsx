import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminRolesCard } from "./AdminRolesCard";
import type { Bootstrap } from "../../types";
import { createRole, duplicateRole, updateRole } from "../../api";

vi.mock("../../api", () => ({
  createRole: vi.fn().mockResolvedValue(undefined),
  duplicateRole: vi
    .fn()
    .mockResolvedValue({ id: "op-2", name: "Operator 2" }),
  updateRole: vi.fn().mockResolvedValue(undefined),
  deleteRole: vi.fn().mockResolvedValue(undefined),
}));

const appData: Bootstrap = {
  self: { id: "u1", username: "tim", roleId: "op" },
  users: [{ id: "u1", username: "tim", roleId: "op" }],
  roles: [{ id: "op", name: "Operator", defaultVoiceMode: "always_on" }],
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

describe("AdminRolesCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("toggles open/closed body", async () => {
    const user = userEvent.setup();
    render(
      <AdminRolesCard
        token="token-123"
        adminPin="1234"
        appData={appData}
        refreshBootstrapData={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("heading", { name: /Roles/i }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByRole("heading", { name: "Roles (1)" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Hide" }));
    expect(
      screen.queryByRole("heading", { name: "Roles (1)" }),
    ).not.toBeInTheDocument();
  });

  it("creates a role and refreshes bootstrap", async () => {
    const user = userEvent.setup();
    const refreshBootstrapData = vi.fn().mockResolvedValue(undefined);

    render(
      <AdminRolesCard
        token="token-123"
        adminPin="1234"
        appData={appData}
        refreshBootstrapData={refreshBootstrapData}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Show" }));
    await user.click(screen.getByRole("button", { name: "Create role" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    await user.type(screen.getByLabelText("Role ID"), "editor");
    await user.type(screen.getByLabelText("Role name"), "Editor");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(createRole).toHaveBeenCalledWith(
        "token-123",
        "1234",
        expect.objectContaining({ id: "editor", name: "Editor" }),
      );
    });
    expect(refreshBootstrapData).toHaveBeenCalledTimes(1);
  });

  it("opens edit form and saves role changes", async () => {
    const user = userEvent.setup();
    const refreshBootstrapData = vi.fn().mockResolvedValue(undefined);

    render(
      <AdminRolesCard
        token="token-123"
        adminPin="1234"
        appData={appData}
        refreshBootstrapData={refreshBootstrapData}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Show" }));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Edit role");
    expect(screen.getByLabelText("Role ID")).toHaveAttribute("readonly");
    const roleNameInput = screen.getByLabelText("Role name");
    await user.clear(roleNameInput);
    await user.type(roleNameInput, "Operator Team");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updateRole).toHaveBeenCalledWith(
        "token-123",
        "1234",
        "op",
        expect.objectContaining({ name: "Operator Team" }),
      );
    });
    expect(refreshBootstrapData).toHaveBeenCalledTimes(1);
  });

  it("opens an editable duplicate and only saves it after confirmation", async () => {
    const user = userEvent.setup();
    const refreshBootstrapData = vi.fn().mockResolvedValue(undefined);

    render(
      <AdminRolesCard
        token="token-123"
        adminPin="1234"
        appData={appData}
        refreshBootstrapData={refreshBootstrapData}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Show" }));
    const duplicateButton = screen.getByRole("button", {
      name: "Duplicate role Operator",
    });
    const editButton = screen.getByRole("button", { name: "Edit" });
    expect(
      duplicateButton.compareDocumentPosition(editButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await user.click(duplicateButton);

    expect(duplicateRole).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Duplicate role");
    expect(screen.getByLabelText("Role ID")).toHaveValue("op-2");
    const roleNameInput = screen.getByLabelText("Role name");
    expect(roleNameInput).toHaveValue("Operator 2");
    await user.clear(roleNameInput);
    await user.type(roleNameInput, "Operator Backup");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(duplicateRole).toHaveBeenCalledWith(
        "token-123",
        "1234",
        "op",
        {
          id: "op-2",
          name: "Operator Backup",
          defaultRoomId: "",
          defaultVoiceMode: "always_on",
          defaultSimpleView: false,
        },
      );
    });
    expect(refreshBootstrapData).toHaveBeenCalledTimes(1);
  });

  it("places cancel left of save and closes without persisting", async () => {
    const user = userEvent.setup();

    render(
      <AdminRolesCard
        token="token-123"
        adminPin="1234"
        appData={appData}
        refreshBootstrapData={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Show" }));
    await user.click(screen.getByRole("button", { name: "Create role" }));
    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    const saveButton = screen.getByRole("button", { name: "Save" });
    expect(
      cancelButton.compareDocumentPosition(saveButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await user.click(cancelButton);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(createRole).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Create role" }));
    await user.click(
      screen.getByRole("button", { name: "Close role dialog" }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(createRole).not.toHaveBeenCalled();
  });
});
