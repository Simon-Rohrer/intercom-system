import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LoginView } from "./LoginView";

const baseProps = {
  publicData: {
    roles: [
      { id: "op", name: "Operator" },
      { id: "admin", name: "Admin" },
    ],
    rooms: [],
    broadcastGroups: [],
    activeRoleIds: [],
    ackEnabled: true,
    appVersion: { version: "dev", buildTimestamp: "2026-03-10" },
  },
  username: "",
  roleId: "",
  onUsernameChange: vi.fn(),
  onRoleChange: vi.fn(),
  onLogin: vi.fn(),
  loginError: "",
  adminPin: "",
  onAdminPinChange: vi.fn(),
  onAdminLogin: vi.fn(),
  takeoverConflict: null,
  onConfirmTakeover: vi.fn(),
  onCancelTakeover: vi.fn(),
  raspberryRemoteStations: null,
  onRaspberryRemoteJoin: vi.fn(),
};

describe("LoginView", () => {
  it("disables join button until username and role are present", () => {
    const { rerender } = render(<LoginView {...baseProps} />);
    expect(
      screen.getByRole("button", { name: "Intercom beitreten" }),
    ).toBeDisabled();

    rerender(<LoginView {...baseProps} username="Tim" roleId="op" />);
    expect(screen.getByRole("button", { name: "Intercom beitreten" })).toBeEnabled();
  });

  it("marks missing display name and role as required", () => {
    const { rerender } = render(<LoginView {...baseProps} />);

    expect(screen.getByText("Gib einen Namen ein, um fortzufahren.")).toBeVisible();
    expect(screen.getByText("Wähle eine Rolle, um fortzufahren.")).toBeVisible();
    expect(screen.getByLabelText("Name")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByLabelText("Rolle")).toHaveAttribute(
      "aria-invalid",
      "true",
    );

    rerender(<LoginView {...baseProps} username="Tim" roleId="op" />);

    expect(
      screen.queryByText("Gib einen Namen ein, um fortzufahren."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Wähle eine Rolle, um fortzufahren."),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Name")).not.toHaveAttribute(
      "aria-invalid",
    );
    expect(screen.getByLabelText("Rolle")).not.toHaveAttribute("aria-invalid");
  });

  it("explains when all roles are already active", () => {
    render(
      <LoginView
        {...baseProps}
        publicData={{
          ...baseProps.publicData,
          activeRoleIds: ["op", "admin"],
        }}
      />,
    );

    expect(screen.getByText("Gerade ist keine Rolle frei.")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Intercom beitreten" }),
    ).toBeDisabled();
  });

  it("shows operator login error in the main login form", () => {
    render(
      <LoginView
        {...baseProps}
        username="Tim"
        roleId="op"
        loginError="Die Rolle Operator ist bereits angemeldet."
      />,
    );

    expect(
      screen.getByText("Die Rolle Operator ist bereits angemeldet."),
    ).toBeVisible();
  });

  it("hides roles that already have an active session", () => {
    render(
      <LoginView
        {...baseProps}
        publicData={{
          ...baseProps.publicData,
          activeRoleIds: ["op"],
        }}
      />,
    );

    expect(screen.queryByRole("option", { name: "Operator" })).toBeNull();
    expect(screen.getByRole("option", { name: "Admin" })).toBeVisible();
  });

  it("calls callbacks when typing/selecting and joining", async () => {
    const user = userEvent.setup();
    const onUsernameChange = vi.fn();
    const onRoleChange = vi.fn();
    const onLogin = vi.fn();

    render(
      <LoginView
        {...baseProps}
        username="Tim"
        roleId="op"
        onUsernameChange={onUsernameChange}
        onRoleChange={onRoleChange}
        onLogin={onLogin}
      />,
    );

    await user.type(screen.getByLabelText("Name"), " A");
    await user.selectOptions(screen.getByLabelText("Rolle"), "admin");
    await user.click(screen.getByRole("button", { name: "Intercom beitreten" }));

    expect(onUsernameChange).toHaveBeenCalled();
    expect(onRoleChange).toHaveBeenCalledWith("admin");
    expect(onLogin).toHaveBeenCalledTimes(1);
  });

  it("strips whitespace from display name while typing", async () => {
    const user = userEvent.setup();
    const onUsernameChange = vi.fn();

    function Harness() {
      const [username, setUsername] = useState("");
      return (
        <LoginView
          {...baseProps}
          username={username}
          roleId="op"
          onUsernameChange={(value) => {
            onUsernameChange(value);
            setUsername(value);
          }}
        />
      );
    }

    render(<Harness />);

    await user.type(screen.getByLabelText("Name"), "Tim FOH");
    expect(onUsernameChange).toHaveBeenLastCalledWith("TimFOH");
  });

  it("selects admin tab and handles admin login action", async () => {
    const user = userEvent.setup();
    const onAdminPinChange = vi.fn();
    const onAdminLogin = vi.fn();

    render(
      <LoginView
        {...baseProps}
        adminPin="1234"
        adminError="Wrong PIN"
        onAdminPinChange={onAdminPinChange}
        onAdminLogin={onAdminLogin}
      />,
    );

    const adminTab = screen.getByRole("tab", { name: "Admin" });
    expect(adminTab).toHaveAttribute("aria-selected", "false");

    await user.click(adminTab);
    expect(adminTab).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("tabpanel", { name: "Admin-Bereich" }),
    ).toBeVisible();
    expect(screen.getByText("Wrong PIN")).toBeVisible();

    await user.type(screen.getByLabelText("Admin-PIN"), "5");
    await user.click(
      screen.getByRole("button", { name: "Admin-Bereich öffnen" }),
    );
    expect(onAdminPinChange).toHaveBeenCalled();
    expect(onAdminLogin).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("tab", { name: "Operator" }));
    expect(adminTab).toHaveAttribute("aria-selected", "false");
    expect(
      screen.queryByRole("tabpanel", { name: "Admin-Bereich" }),
    ).not.toBeInTheDocument();
  });

  it("renders and handles takeover confirmation controls", async () => {
    const user = userEvent.setup();
    const onConfirmTakeover = vi.fn();
    const onCancelTakeover = vi.fn();

    render(
      <LoginView
        {...baseProps}
        takeoverConflict={{
          requiresTakeover: true,
          conflictRoleId: "op",
          conflictRoleName: "Operator",
          conflictUsername: "Alex",
        }}
        onConfirmTakeover={onConfirmTakeover}
        onCancelTakeover={onCancelTakeover}
      />,
    );

    expect(screen.getByText(/Rolle ist gerade belegt/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Rolle übernehmen" }));
    await user.click(screen.getByRole("button", { name: "Abbrechen" }));

    expect(onConfirmTakeover).toHaveBeenCalledTimes(1);
    expect(onCancelTakeover).toHaveBeenCalledTimes(1);
  });
});
