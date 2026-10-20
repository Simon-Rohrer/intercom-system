import { useState } from "react";
import type { Bootstrap } from "../../types";
import { AdminConfigCard } from "./AdminConfigCard";
import { ADMIN_SECTIONS, type AdminSectionId } from "./adminSections";
import { AdminCardDefaultOpenContext } from "./adminCardOpen";
import { AdminPinCard } from "./AdminPinCard";
import { AdminMonitoringCard } from "./AdminMonitoringCard";

type AdminMenuProps = {
  token: string | null;
  appData: Bootstrap;
  refreshBootstrapData: () => Promise<void>;
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
  /** Controlled section (the sidebar frame shows the navigation itself). */
  section?: AdminSectionId;
  onSectionChange?: (id: AdminSectionId) => void;
  /** Hide the built-in left navigation (it lives in the sidebar). */
  hideNav?: boolean;
};

export function AdminMenu({
  token,
  appData,
  refreshBootstrapData,
  adminPin,
  onUpdateAdminPin,
  audioStats,
  activeRoutesCount,
  section: controlledSection,
  onSectionChange,
  hideNav = false,
}: AdminMenuProps) {
  const [ownSection, setOwnSection] = useState<AdminSectionId>(readStoredAdminSection);
  const section = controlledSection ?? ownSection;

  if (!token) return null;

  const active =
    ADMIN_SECTIONS.find((info) => info.id === section) ?? ADMIN_SECTIONS[0];
  const counts = adminSectionCounts(appData);
  const groups = Array.from(new Set(ADMIN_SECTIONS.map((info) => info.group)));
  const selectSection = (id: AdminSectionId) => {
    setOwnSection(id);
    storeAdminSection(id);
    onSectionChange?.(id);
  };

  return (
    <div className="admin-stack">
      <div className={`admin-settings-layout ${hideNav ? "is-nav-external" : ""}`.trim()}>
        {hideNav ? null : (
        <nav className="admin-nav" aria-label="Admin-Bereiche">
          {groups.map((group) => (
            <div className="admin-nav-group" key={group}>
              <span className="admin-nav-label">{group}</span>
              {ADMIN_SECTIONS.filter((info) => info.group === group).map((info) => (
                <button
                  key={info.id}
                  type="button"
                  className="admin-nav-item"
                  aria-current={info.id === active.id ? "page" : undefined}
                  onClick={() => selectSection(info.id)}
                >
                  <span>{info.label}</span>
                  {counts[info.id] !== undefined ? (
                    <small>{counts[info.id]}</small>
                  ) : null}
                </button>
              ))}
            </div>
          ))}
        </nav>
        )}

        <section className="admin-settings-main" aria-label={active.label}>
          {hideNav ? null : (
          <div className="admin-layout-intro">
            <span className="admin-layout-eyebrow">{active.group}</span>
            <h2>{active.label}</h2>
            <p>{active.description}</p>
          </div>
          )}

          <AdminCardDefaultOpenContext.Provider value={true}>
            {active.id === "status" ? (
              <div className="admin-section-cards">
              <AdminMonitoringCard
                token={token}
                adminPin={adminPin}
                audioStats={audioStats}
                activeRoutesCount={activeRoutesCount}
              />
              </div>
            ) : active.id === "security" ? (
              <div className="admin-section-cards">
                <AdminPinCard onUpdateAdminPin={onUpdateAdminPin} />
              </div>
            ) : (
              <AdminConfigCard
                token={token}
                adminPin={adminPin}
                appData={appData}
                refreshBootstrapData={refreshBootstrapData}
                section={active.id}
              />
            )}
          </AdminCardDefaultOpenContext.Provider>
        </section>
      </div>
    </div>
  );
}

const SECTION_STORAGE_KEY = "kesher.admin.section";

/** Number shown next to a section in the navigation. */
export function adminSectionCounts(
  appData: Bootstrap,
): Partial<Record<AdminSectionId, number>> {
  return {
    roles: appData.roles.length,
    users: appData.users.length,
    rooms: appData.rooms.length,
    channels: appData.broadcastGroups.length,
  };
}

export function storeAdminSection(id: AdminSectionId): void {
  try {
    window.localStorage.setItem(SECTION_STORAGE_KEY, id);
  } catch {
    // Remembering the section is a convenience only.
  }
}

export function readStoredAdminSection(): AdminSectionId {
  try {
    const stored = window.localStorage.getItem(SECTION_STORAGE_KEY);
    if (stored && ADMIN_SECTIONS.some((info) => info.id === stored)) {
      return stored as AdminSectionId;
    }
  } catch {
    // ignore unavailable storage
  }
  return "rooms";
}
