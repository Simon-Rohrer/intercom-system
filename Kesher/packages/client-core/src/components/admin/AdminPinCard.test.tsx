import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AdminPinCard } from "./AdminPinCard";

it("central password page only links to JMS Control and exposes no local editing fields", () => {
  const update = vi.fn();
  const { container } = render(<AdminPinCard central onUpdateAdminPin={update} />);
  expect(screen.getByRole("heading", { name: "Admin-PIN wird in JMS Control verwaltet" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Admin-Passwort in JMS Control ändern" }).getAttribute("href")).toContain("#/einstellungen/zugang/anmeldung");
  expect(container.querySelectorAll("input")).toHaveLength(0);
  expect(update).not.toHaveBeenCalled();
});
