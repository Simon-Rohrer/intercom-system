import { useState } from "react";
import type { Bootstrap } from "../../types";
import { AdminCardHeader } from "./AdminCardHeader";
import { UsersPanel } from "./UsersPanel";
import { useAdminCardOpenState } from "./adminCardOpen";

type AdminUsersCardProps = {
  token: string;
  adminPin: string;
  appData: Bootstrap;
  refreshBootstrapData: () => Promise<void>;
};

export function AdminUsersCard({
  token,
  adminPin,
  appData,
  refreshBootstrapData,
}: AdminUsersCardProps) {
  const [isOpen, setIsOpen] = useAdminCardOpenState();

  return (
    <div className="admin-card">
      <AdminCardHeader
        title="Benutzer"
        isOpen={isOpen}
        onToggle={() => setIsOpen((v) => !v)}
      />
      {isOpen ? (
        <div className="admin-card-body">
          <UsersPanel
            token={token}
            adminPin={adminPin}
            appData={appData}
            refreshBootstrapData={refreshBootstrapData}
          />
        </div>
      ) : null}
    </div>
  );
}
