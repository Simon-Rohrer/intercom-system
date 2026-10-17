import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminRolesCard, multiviewRolesUrl } from "./AdminRolesCard";
import type { Bootstrap } from "../../types";
import { createRole, duplicateRole, updateRole } from "../../api";

vi.mock("../../api", () => ({
  createRole: vi.fn().mockResolvedValue(undefined),
  duplicateRole: vi.fn().mockResolvedValue({ id: "op-2", name: "Operator 2" }),
  updateRole: vi.fn().mockResolvedValue(undefined),
  deleteRole: vi.fn().mockResolvedValue(undefined),
}));

const appData: Bootstrap = {
  self: { id: "u1", username: "tim", roleId: "op" },
  users: [{ id: "u1", username: "tim", roleId: "op" }],
  roles: [{ id: "op", name: "Operator", defaultVoiceMode: "always_on" }],
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
    await user.click(screen.getByRole("button", { name: "Einblenden" }));
    expect(screen.getByRole("heading", { name: "Rollen (1)" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Ausblenden" }));
    expect(
      screen.queryByRole("heading", { name: "Rollen (1)" }),
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

    await user.click(screen.getByRole("button", { name: "Einblenden" }));
    await user.click(screen.getByRole("button", { name: "+ Neue Rolle" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    await user.type(screen.getByLabelText("Kennung der Rolle"), "editor");
    await user.type(screen.getByLabelText("Name der Rolle"), "Editor");
    await user.click(screen.getByRole("button", { name: "Speichern" }));

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

    await user.click(screen.getByRole("button", { name: "Einblenden" }));
    await user.click(screen.getByRole("button", { name: "Bearbeiten" }));
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Rolle bearbeiten");
    expect(screen.getByLabelText("Kennung der Rolle")).toHaveAttribute("readonly");
    const roleNameInput = screen.getByLabelText("Name der Rolle");
    await user.clear(roleNameInput);
    await user.type(roleNameInput, "Operator Team");
    await user.click(screen.getByRole("button", { name: "Speichern" }));

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

    await user.click(screen.getByRole("button", { name: "Einblenden" }));
    const duplicateButton = screen.getByRole("button", {
      name: "Rolle Operator duplizieren",
    });
    const editButton = screen.getByRole("button", { name: "Bearbeiten" });
    expect(
      duplicateButton.compareDocumentPosition(editButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await user.click(duplicateButton);

    expect(duplicateRole).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Rolle duplizieren");
    expect(screen.getByLabelText("Kennung der Rolle")).toHaveValue("op-2");
    const roleNameInput = screen.getByLabelText("Name der Rolle");
    expect(roleNameInput).toHaveValue("Operator 2");
    await user.clear(roleNameInput);
    await user.type(roleNameInput, "Operator Backup");
    await user.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() => {
      expect(duplicateRole).toHaveBeenCalledWith("token-123", "1234", "op", {
        id: "op-2",
        name: "Operator Backup",
        defaultRoomId: "",
        defaultVoiceMode: "always_on",
        defaultSimpleView: false,
      });
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

    await user.click(screen.getByRole("button", { name: "Einblenden" }));
    await user.click(screen.getByRole("button", { name: "+ Neue Rolle" }));
    const cancelButton = screen.getByRole("button", { name: "Abbrechen" });
    const saveButton = screen.getByRole("button", { name: "Speichern" });
    expect(
      cancelButton.compareDocumentPosition(saveButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await user.click(cancelButton);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(createRole).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "+ Neue Rolle" }));
    await user.click(screen.getByRole("button", { name: "Fenster schließen" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(createRole).not.toHaveBeenCalled();
  });

  it("greys out the roles and points to JMS Control when roles are managed centrally", async () => {
    const user = userEvent.setup();
    render(
      <AdminRolesCard
        token="token-123"
        adminPin="1234"
        appData={{ ...appData, centralRoles: true }}
        refreshBootstrapData={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Einblenden" }));
    const overlay = screen.getByRole("dialog", {
      name: "Rollen werden in JMS Control verwaltet",
    });
    expect(overlay).toBeVisible();
    expect(
      screen.getByText(/Rollen legst du in JMS Control unter Benutzer & Rechte an/),
    ).toBeVisible();

    const link = screen.getByRole("link", { name: "Rechte in JMS Control anpassen" });
    expect(link).toHaveAttribute("href", expect.stringContaining("#/zugang/rollen"));
    expect(link).toHaveAttribute("target", "_blank");

    // the list stays visible, but greyed out and not usable
    expect(screen.getByText("Operator")).toBeInTheDocument();
    expect(screen.getByRole("list")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("list")).toHaveClass("admin-roles-central");
    expect(screen.getByRole("button", { name: "Bearbeiten" })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "+ Neue Rolle" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /duplizieren/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Löschen" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Bearbeiten" }));
    expect(screen.queryByLabelText("Name der Rolle")).not.toBeInTheDocument();
  });

  it("points to the roles page of JMS Control on the matching address", () => {
    expect(multiviewRolesUrl({ hostname: "192.168.0.21" })).toBe(
      "https://192.168.0.21:8090/#/zugang/rollen",
    );
    expect(multiviewRolesUrl({ hostname: "kesher.jms.de" })).toBe(
      "https://multiview.jms.de/#/zugang/rollen",
    );
    expect(multiviewRolesUrl({ hostname: "intercom.jms.de" })).toBe(
      "https://multiview.jms.de/#/zugang/rollen",
    );
    expect(multiviewRolesUrl({ hostname: "intercom.local" })).toBe(
      "https://jmscontrol.local/#/zugang/rollen",
    );
    expect(multiviewRolesUrl({ hostname: "kesher.local" })).toBe(
      "https://jmscontrol.local/#/zugang/rollen",
    );
    expect(multiviewRolesUrl({ hostname: "server" })).toBe(
      "https://server:8090/#/zugang/rollen",
    );
  });
});
