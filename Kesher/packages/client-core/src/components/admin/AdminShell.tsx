import type { Bootstrap } from "../../types";
import { BrandLogo } from "../BrandLogo";
import { AdminMenu } from "./AdminMenu";

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
};

/**
 * Admin console shell — owns the layout, header and AdminMenu wiring.
 * Adding new admin features only requires changes to AdminMenu and its
 * sub-components; App.tsx never needs to be touched for admin-panel changes.
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
}: AdminShellProps) {
  return (
    <div className="root admin-shell">
      <div className="admin-shell-header">
        <div className="admin-shell-brand">
          <BrandLogo className="admin-shell-logo" />
          <span className="admin-shell-sep" aria-hidden="true" />
          <div>
            <h1>Admin</h1>
            <p className="admin-shell-user">
              Angemeldet als {displayUsername} ({adminRoleLabel})
            </p>
          </div>
        </div>
        <div className="admin-shell-actions">
          <button type="button" onClick={() => void onRefresh()}>
            Aktualisieren
          </button>
          <button
            type="button"
            className="admin-shell-logout"
            onClick={() => void onLogout()}
          >
            Sperren
          </button>
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
      />
    </div>
  );
}
