import { useState } from "react";
import type { Bootstrap } from "../../types";
import { AppShell, type ShellUser } from "../shell/AppShell";
import {
  AdminMenu,
  adminSectionCounts,
  readStoredAdminSection,
  storeAdminSection,
} from "./AdminMenu";
import { ADMIN_SECTIONS, type AdminSectionId } from "./adminSections";

type AdminShellProps = {
  token: string;
  appData: Bootstrap;
  adminPin: string;
  onUpdateAdminPin: (currentPin: string, newPin: string) => Promise<void>;
  audioStats: {
    inKbps: number;
    outKbps: number;
    jitterMs: number;
    roundTripMs: number;
    playoutDelayMs: number;
  };
  activeRoutesCount: number;
  displayUsername: string;
  adminRoleLabel: string;
  onRefresh: () => Promise<void>;
  onLogout: () => Promise<void>;
  /** User card in the sidebar (name, role, Konto wechseln, Abmelden). */
  shellUser?: ShellUser;
};

/**
 * Admin console in the sidebar frame like JMS Control: the admin sections are
 * a grouped sub-navigation of "Admin" in the sidebar, the page shows the chosen
 * section. Adding new admin features only requires changes to AdminMenu,
 * adminSections and the cards; App.tsx never needs to be touched.
 */
export function AdminShell({
  token,
  appData,
  adminPin,
  onUpdateAdminPin,
  audioStats,
  activeRoutesCount,
  displayUsername,
  adminRoleLabel,
  onRefresh,
  onLogout,
  shellUser,
}: AdminShellProps) {
  const [section, setSection] = useState<AdminSectionId>(readStoredAdminSection);
  const [refreshing, setRefreshing] = useState(false);
  const active =
    ADMIN_SECTIONS.find((info) => info.id === section) ?? ADMIN_SECTIONS[0];
  const counts = adminSectionCounts(appData);
  const groupLabels = Array.from(new Set(ADMIN_SECTIONS.map((info) => info.group)));
  const selectSection = (id: AdminSectionId) => {
    setSection(id);
    storeAdminSection(id);
  };
  const user: ShellUser = shellUser ?? {
    name: displayUsername,
    role: adminRoleLabel,
    onSwitchAccount: () => void onLogout(),
    onLogout: () => void onLogout(),
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <AppShell
      user={user}
      items={[
        {
          id: "admin",
          label: "Admin",
          icon: "admin",
          active: true,
          onSelect: () => undefined,
          groups: groupLabels.map((group) => ({
            label: group,
            items: ADMIN_SECTIONS.filter((info) => info.group === group).map(
              (info) => ({
                id: info.id,
                label: info.label,
                active: info.id === active.id,
                count: counts[info.id],
                onSelect: () => selectSection(info.id),
              }),
            ),
          })),
        },
      ]}
      status={
        <div className="k-admin-status">
          <strong>Admin</strong>
          <span>
            Angemeldet als {displayUsername} ({adminRoleLabel})
          </span>
        </div>
      }
      actions={
        <button
          type="button"
          className="k-btn"
          onClick={() => void refresh()}
          disabled={refreshing}
        >
          <svg viewBox="0 0 24 24" className="k-icon" aria-hidden="true">
            <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />
          </svg>
          <span>{refreshing ? "Aktualisiere …" : "Aktualisieren"}</span>
        </button>
      }
    >
      <div className="root admin-shell">
        <section className="k-page" aria-labelledby="admin-section-title">
          <div className="k-page-head">
            <div>
              <span className="k-eyebrow">{active.group}</span>
              <h1 id="admin-section-title">{active.label}</h1>
              <p className="k-lead">{active.description}</p>
            </div>
          </div>
          <AdminMenu
            token={token}
            appData={appData}
            refreshBootstrapData={onRefresh}
            adminPin={adminPin}
            onUpdateAdminPin={onUpdateAdminPin}
            audioStats={audioStats}
            activeRoutesCount={activeRoutesCount}
            section={active.id}
            onSectionChange={selectSection}
            hideNav
          />
        </section>
      </div>
    </AppShell>
  );
}
