import { AdminCardHeader } from "./AdminCardHeader";
import { useEffect, useState } from "react";
import {
  getAdminCompanionRolePages,
  saveAdminCompanionRolePage,
} from "../../api";
import type {
  Bootstrap,
  CompanionRolePagesResponse,
} from "../../types";
import { useAdminCardOpenState } from "./adminCardOpen";

type AdminCompanionPageConfigCardProps = {
  token: string;
  adminPin: string;
  appData: Bootstrap;
};

export function AdminCompanionPageConfigCard({
  token,
  adminPin,
  appData,
}: AdminCompanionPageConfigCardProps) {
  const [isOpen, setIsOpen] = useAdminCardOpenState();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [rolePages, setRolePages] = useState<Record<string, number>>({});
  const [selectedRoleId, setSelectedRoleId] = useState(
    appData.roles[0]?.id || ""
  );
  const [selectedPageNumber, setSelectedPageNumber] = useState(0);

  async function loadRolePages() {
    setLoading(true);
    setError("");
    try {
      const data = await getAdminCompanionRolePages(token, adminPin);
      setRolePages(data.rolePages || {});
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Rollen-Seiten konnten nicht geladen werden"
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (isOpen) {
      loadRolePages();
    }
  }, [isOpen]);

  async function handleSavePage() {
    if (!selectedRoleId) {
      setError("Bitte wähle eine Rolle");
      return;
    }
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await saveAdminCompanionRolePage(
        token,
        adminPin,
        selectedRoleId,
        selectedPageNumber
      );
      setMessage(
        `Gespeichert: ${roleName(selectedRoleId)} → Seite ${selectedPageNumber}`
      );
      await loadRolePages();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Zuordnung konnte nicht gespeichert werden"
      );
    } finally {
      setSaving(false);
    }
  }

  const roleName = (roleId: string) =>
    appData.roles.find((role) => role.id === roleId)?.name ?? roleId;

  return (
    <div className="admin-card">
      <AdminCardHeader
        title="Companion · Stream-Deck-Seite je Rolle"
        isOpen={isOpen}
        onToggle={() => setIsOpen(!isOpen)}
      />
      {isOpen && (
        <div className="admin-card-body">
          <p className="admin-card-subtitle" style={{ margin: 0 }}>
            Auf welcher Stream-Deck-Seite in Companion die Tasten einer Rolle landen.
          </p>
          {error && <p className="admin-error">{error}</p>}
          {message && <p className="admin-success">{message}</p>}

          <div className="admin-inline-form">
            <label>
              <span>Rolle</span>
              <select
                value={selectedRoleId}
                onChange={(e) => setSelectedRoleId(e.target.value)}
                disabled={saving}
              >
                {appData.roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Seite (0–14)</span>
              <input
                type="number"
                min="0"
                max="14"
                value={selectedPageNumber}
                onChange={(e) => setSelectedPageNumber(Math.min(14, Math.max(0, parseInt(e.target.value) || 0)))}
                disabled={saving}
              />
            </label>
            <button
              type="button"
              onClick={handleSavePage}
              disabled={saving || !selectedRoleId}
              className="primary"
            >
              {saving ? "Speichere …" : "Zuordnung speichern"}
            </button>
          </div>

          <div className="admin-block">
            <div className="admin-block-header">
              <h4>Aktuelle Zuordnungen</h4>
            </div>
            {loading ? (
              <p>Lade …</p>
            ) : Object.keys(rolePages).length === 0 ? (
              <p>Noch keine Rolle einer Seite zugeordnet.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Rolle</th>
                    <th>Seite</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(rolePages).map(([roleId, pageNum]) => (
                    <tr key={roleId}>
                      <td>{roleName(roleId)}</td>
                      <td>{pageNum}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
