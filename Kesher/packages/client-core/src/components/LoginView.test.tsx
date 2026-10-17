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

  it("shows occupied roles as belegt but not selectable", () => {
    render(
      <LoginView
        {...baseProps}
        username="Tim"
        roleId="op"
        publicData={{
          ...baseProps.publicData,
          activeRoleIds: ["op"],
        }}
      />,
    );

    expect(screen.getByRole("option", { name: "Operator · belegt" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "Admin" })).toBeEnabled();
    expect(screen.getByText("Die gewählte Rolle ist gerade belegt.")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Intercom beitreten" }),
    ).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Rolle übernehmen" })).toBeNull();
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

    await user.click(screen.getByRole("tab", { name: "Bediener" }));
    expect(adminTab).toHaveAttribute("aria-selected", "false");
    expect(
      screen.queryByRole("tabpanel", { name: "Admin-Bereich" }),
    ).not.toBeInTheDocument();
  });

  it("shows only the Raspberry station list for login=raspberry", async () => {
    const user = userEvent.setup();
    const onRaspberryRemoteJoin = vi.fn();
    const ready = {
      deviceId: "pi-1",
      name: "Pi Bühne",
      roleId: "op",
      online: true,
      intercomConnected: true,
    };
    render(
      <LoginView
        {...baseProps}
        initialMode="raspberry"
        raspberryRemoteStations={[
          ready,
          { deviceId: "pi-2", name: "Pi Foyer", roleId: "op", online: false },
        ] as never}
        onRaspberryRemoteJoin={onRaspberryRemoteJoin}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Raspberry fernsteuern" }),
    ).toBeVisible();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Admin-PIN")).not.toBeInTheDocument();
    expect(screen.getByText("Pi Bühne")).toBeVisible();
    expect(screen.getByText("Pi Foyer")).toBeVisible();

    const joinButtons = screen.getAllByRole("button", { name: "Steuern" });
    expect(joinButtons[1]).toBeDisabled();
    await user.click(joinButtons[0]);
    expect(onRaspberryRemoteJoin).toHaveBeenCalledWith(ready);
  });

  it("keeps the operator, Raspberry and admin tabs for the normal login", () => {
    render(<LoginView {...baseProps} />);
    expect(screen.getByRole("tab", { name: "Bediener" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Raspberry" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Admin" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Intercom" })).toBeVisible();
  });
});
