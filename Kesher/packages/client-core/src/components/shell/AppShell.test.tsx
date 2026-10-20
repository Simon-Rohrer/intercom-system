import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";
import { dashboardUrl, switchAccountUrl, userInitials } from "./shellLinks";
import { wallpaperVariables } from "./jmsTheme";

function renderShell(overrides: Partial<Parameters<typeof AppShell>[0]> = {}) {
  const onSwitchAccount = vi.fn();
  const onLogout = vi.fn();
  const onSettings = vi.fn();
  render(
    <AppShell
      user={{ name: "Tim FOH", role: "Ton", onSwitchAccount, onLogout }}
      items={[
        { id: "intercom", label: "Intercom", icon: "intercom", active: true, onSelect: vi.fn() },
        { id: "settings", label: "Einstellungen", icon: "settings", active: false, onSelect: onSettings },
      ]}
      {...overrides}
    >
      <p>Seite</p>
    </AppShell>,
  );
  return { onSwitchAccount, onLogout, onSettings };
}

describe("AppShell", () => {
  it("shows Dashboard first, the entries and the user card", async () => {
    const user = userEvent.setup();
    const { onSwitchAccount, onLogout, onSettings } = renderShell();

    const nav = screen.getByRole("navigation", { name: "Bereiche" });
    const links = nav.querySelectorAll(".k-nav-link");
    expect(links[0]).toHaveTextContent("Dashboard");
    expect(links[0]).toHaveAttribute("href", dashboardUrl());
    expect(links[1]).toHaveTextContent("Intercom");
    expect(links[1]).toHaveAttribute("aria-current", "page");

    expect(screen.getByText("Tim FOH")).toBeVisible();
    expect(screen.getByText("Ton")).toBeVisible();
    expect(screen.getByText("TF")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Einstellungen" }));
    expect(onSettings).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Konto wechseln" }));
    expect(onSwitchAccount).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Abmelden" }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("links 'Konto wechseln' to the central login when there is one", () => {
    renderShell({
      user: {
        name: "Tim",
        role: "Ton",
        switchAccountHref: switchAccountUrl("/"),
        onSwitchAccount: vi.fn(),
        onLogout: vi.fn(),
      },
    });
    expect(screen.getByRole("link", { name: "Konto wechseln" })).toHaveAttribute(
      "href",
      "/.jms-auth/login?wechseln=1&next=%2F",
    );
  });

  it("opens the sidebar on phones via the menu button", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <AppShell
        user={{ name: "Tim", role: "Ton", onSwitchAccount: vi.fn(), onLogout: vi.fn() }}
        items={[]}
      >
        <p>Seite</p>
      </AppShell>,
    );
    const shell = container.querySelector(".k-shell");
    expect(shell).not.toHaveClass("is-nav-open");
    await user.click(screen.getByRole("button", { name: "Menü" }));
    expect(shell).toHaveClass("is-nav-open");
    await user.keyboard("{Escape}");
    expect(shell).not.toHaveClass("is-nav-open");
  });
});

describe("JMS wallpaper", () => {
  it("uses the user's wallpaper picture and glass in dark mode", () => {
    const vars = wallpaperVariables("ozean", true);
    expect(vars.wallpaper).toContain("/.jms-auth/api/wallpaper/ozean.jpg");
    expect(vars.surface).toBe("rgba(16, 26, 92, 0.48)");
    expect(vars.accent).toBe("#3478f6");
  });

  it("uses the light picture in light mode and keeps the default glass", () => {
    const vars = wallpaperVariables("ozean", false);
    expect(vars.wallpaper).toContain("ozean-hell.jpg");
    expect(vars.surface).toBeUndefined();
  });

  it("falls back to Graphit and keeps the gradient for Blau", () => {
    expect(wallpaperVariables("gibtsnicht", true).wallpaper).toContain("graphit.jpg");
    expect(wallpaperVariables("blau", true)).toEqual({ accent: "#007aff" });
  });
});

describe("shell links", () => {
  it("points Dashboard to the dashboard of the current address", () => {
    expect(dashboardUrl({ hostname: "intercom.local" })).toBe("https://technik.local/");
    expect(dashboardUrl({ hostname: "kesher.jms.de" })).toBe("https://dashboard.jms.de/");
    expect(dashboardUrl({ hostname: "192.168.0.21" })).toBe("https://192.168.0.21:3000/");
    expect(dashboardUrl({ hostname: "intercom.internal" })).toBe("https://technik.internal/");
  });

  it("builds initials like JMS Control", () => {
    expect(userInitials("Tim FOH")).toBe("TF");
    expect(userInitials("admin")).toBe("A");
    expect(userInitials("")).toBe("?");
  });
});
