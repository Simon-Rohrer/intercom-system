import type { ReactNode } from "react";
import type { Bootstrap } from "../../types";
import { ADMIN_SECTIONS, type AdminSectionId } from "./adminSections";
import { AdminRolesCard } from "./AdminRolesCard";
import { AdminRoomsCard } from "./AdminRoomsCard";
import { AdminChannelsCard } from "./AdminChannelsCard";
import { AdminUsersCard } from "./AdminUsersCard";
import { AdminTelegramCard } from "./AdminTelegramCard";
import { AdminTelegramUsersCard } from "./AdminTelegramUsersCard";
import { AdminRoutingMatrixCard } from "./AdminRoutingMatrixCard";
import { AdminChatHistoryCard } from "./AdminChatHistoryCard";
import { AdminShowfileCard } from "./AdminShowfileCard";
import { AdminCompanionCard } from "./AdminCompanionCard";
import { AdminCompanionPageConfigCard } from "./AdminCompanionPageConfigCard";
import { AdminStreamDeckCard } from "./AdminStreamDeckCard";
import { AdminLogsCard } from "./AdminLogsCard";

type AdminConfigCardProps = {
  token: string;
  adminPin: string;
  appData: Bootstrap;
  refreshBootstrapData: () => Promise<void>;
  /** Which section to show; without it every section is listed (legacy layout). */
  section?: AdminSectionId;
};

export function AdminConfigCard({
  token,
  adminPin,
  appData,
  refreshBootstrapData,
  section,
}: AdminConfigCardProps) {
  const shared = { token, adminPin, appData, refreshBootstrapData };
  const cards: Record<AdminSectionId, ReactNode> = {
    showfile: (
      <AdminShowfileCard
        token={token}
        adminPin={adminPin}
        refreshBootstrapData={refreshBootstrapData}
      />
    ),
    roles: <AdminRolesCard {...shared} />,
    users: <AdminUsersCard {...shared} />,
    rooms: <AdminRoomsCard {...shared} />,
    channels: <AdminChannelsCard {...shared} />,
    routing: <AdminRoutingMatrixCard {...shared} />,
    companion: (
      <>
        <AdminCompanionCard token={token} adminPin={adminPin} appData={appData} />
        <AdminCompanionPageConfigCard token={token} adminPin={adminPin} appData={appData} />
      </>
    ),
    streamdeck: <AdminStreamDeckCard token={token} adminPin={adminPin} appData={appData} />,
    telegram: (
      <>
        <AdminTelegramCard token={token} adminPin={adminPin} appData={appData} />
        <AdminTelegramUsersCard token={token} adminPin={adminPin} />
      </>
    ),
    chat: <AdminChatHistoryCard {...shared} />,
    logs: <AdminLogsCard token={token} adminPin={adminPin} />,
  };

  if (section) {
    return (
      <div className="admin-section-cards" key={section}>
        {cards[section]}
      </div>
    );
  }

  return (
    <div className="admin-theme-groups">
      {ADMIN_SECTIONS.map((info) => (
        <section key={info.id} className="admin-theme-group" aria-label={info.label}>
          {cards[info.id]}
        </section>
      ))}
    </div>
  );
}
