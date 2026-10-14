import { useMemo, useState } from "react";
import { resetAdminRoleStreamDeckSettings } from "../../api";
import type { Bootstrap } from "../../types";
import { AdminCardHeader } from "./AdminCardHeader";
import { useAdminCardOpenState } from "./adminCardOpen";

type AdminStreamDeckCardProps = {
  token: string;
  adminPin: string;
  appData: Bootstrap;
};

export function AdminStreamDeckCard({
  token,
  adminPin,
  appData,
}: AdminStreamDeckCardProps) {
  const [isOpen, setIsOpen] = useAdminCardOpenState();
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [selectedRoleId, setSelectedRoleId] = useState(
    () => appData.roles[0]?.id || appData.self.roleId || "",
  );

  const selectedRoleName = useMemo(() => {
    return appData.roles.find((role) => role.id === selectedRoleId)?.name || selectedRoleId;
  }, [appData.roles, selectedRoleId]);

  async function handleReset() {
    if (!selectedRoleId) return;
    setResetting(true);
    setError("");
    setMessage("");
    try {
      await resetAdminRoleStreamDeckSettings(token, adminPin, selectedRoleId);
      setMessage(`Stream Deck layout for ${selectedRoleName} reset to defaults.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to reset Stream Deck settings");
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="admin-card">
      <AdminCardHeader
        title="Stream-Deck-Profile"
        isOpen={isOpen}
        onToggle={() => setIsOpen((value) => !value)}
      />
      {isOpen ? (
        <div className="admin-card-body">
          <p>
            Jede Station belegt ihr Stream Deck selbst (Einstellungen → Stream Deck). Hier lässt sich die Belegung einer Rolle auf den Standard zurücksetzen.
          </p>
          <div className="admin-grid">
            <label>
              <span>Rolle</span>
              <select
                value={selectedRoleId}
                onChange={(event) => setSelectedRoleId(event.target.value)}
                disabled={resetting}
              >
                <option value="">Rolle wählen …</option>
                {appData.roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name} ({role.id})
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="admin-form-actions" style={{ marginTop: "0.8rem" }}>
            <button
              type="button"
              className="secondary"
              onClick={() => void handleReset()}
              disabled={!selectedRoleId || resetting}
            >
              {resetting ? "Setze zurück …" : "Auf Standard zurücksetzen"}
            </button>
          </div>
          {error ? <p className="admin-error">{error}</p> : null}
          {message ? <p>{message}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
