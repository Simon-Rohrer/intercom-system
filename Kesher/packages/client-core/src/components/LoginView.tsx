import { useState } from "react";
import type {
  LoginConflict,
  PublicBootstrap,
  RaspberryPiRemoteStationStatus,
} from "../types";
import { BrandLogo } from "./BrandLogo";

type LoginMode = "operator" | "raspberry" | "admin";

type LoginViewProps = {
  publicData: PublicBootstrap;
  username: string;
  roleId: string;
  onUsernameChange: (value: string) => void;
  onRoleChange: (roleId: string) => void;
  onLogin: () => void;
  loginError?: string;
  adminPin: string;
  initialMode?: LoginMode;
  onAdminPinChange: (value: string) => void;
  onAdminLogin: () => void;
  adminError?: string;
  takeoverConflict: LoginConflict | null;
  onConfirmTakeover: () => void;
  onCancelTakeover: () => void;
  raspberryRemoteStations: RaspberryPiRemoteStationStatus[] | null;
  raspberryRemoteError?: string;
  onRaspberryRemoteJoin: (station: RaspberryPiRemoteStationStatus) => void;
};

function RequiredFieldHint({
  id,
  children,
}: {
  id: string;
  children: string;
}) {
  return (
    <p id={id} className="login-required-hint">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5" />
        <path d="M12 16h.01" />
      </svg>
      <span>{children}</span>
    </p>
  );
}

function roleNameFor(publicData: PublicBootstrap, roleId: string): string {
  return publicData.roles.find((role) => role.id === roleId)?.name || roleId;
}

function remoteStationStatusLabel(station: RaspberryPiRemoteStationStatus): string {
  if (station.online && station.intercomConnected) return "Bereit";
  if (station.online) return "Wartet";
  return "Offline";
}

export function LoginView({
  publicData,
  username,
  roleId,
  onUsernameChange,
  onRoleChange,
  onLogin,
  loginError,
  adminPin,
  initialMode = "operator",
  onAdminPinChange,
  onAdminLogin,
  adminError,
  takeoverConflict,
  onConfirmTakeover,
  onCancelTakeover,
  raspberryRemoteStations,
  raspberryRemoteError,
  onRaspberryRemoteJoin,
}: LoginViewProps) {
  const stripWhitespace = (value: string) => value.replace(/\s+/g, "");
  const [loginMode, setLoginMode] = useState<LoginMode>(initialMode);
  const activeRoleIds = new Set(publicData.activeRoleIds);
  const availableRoles = publicData.roles.filter(
    (role) => !activeRoleIds.has(role.id),
  );
  const selectedRoleIsAvailable = availableRoles.some(
    (role) => role.id === roleId,
  );
  const usernameMissing = !username.trim();
  const roleMissing = !roleId || !selectedRoleIsAvailable;
  const roleHintText =
    availableRoles.length === 0
      ? "Gerade ist keine Rolle frei."
      : roleId && !selectedRoleIsAvailable
        ? "Die gewählte Rolle ist nicht mehr frei."
        : "Wähle eine Rolle, um fortzufahren.";
  const joinDisabled = usernameMissing || roleMissing;
  const remoteStations = raspberryRemoteStations ?? [];

  return (
    <div className="root login">
      <div className="login-backdrop" aria-hidden="true" />
      <div className="login-card panel">
        <div className="login-card-head">
          <BrandLogo className="login-brand-logo" />
          <div className="login-card-title">
            <h1>Intercom</h1>
            <p className="variant-subtitle">Live Production · Station Deck</p>
          </div>
        </div>
        <div className="login-box">
        <div className="login-mode-tabs" role="tablist" aria-label="Login mode">
          <button
            type="button"
            className={loginMode === "operator" ? "is-active" : ""}
            onClick={() => setLoginMode("operator")}
            role="tab"
            aria-selected={loginMode === "operator"}
          >
            Operator
          </button>
          <button
            type="button"
            className={loginMode === "raspberry" ? "is-active" : ""}
            onClick={() => setLoginMode("raspberry")}
            role="tab"
            aria-selected={loginMode === "raspberry"}
          >
            Raspberry
          </button>
          <button
            type="button"
            className={loginMode === "admin" ? "is-active" : ""}
            onClick={() => setLoginMode("admin")}
            role="tab"
            aria-selected={loginMode === "admin"}
          >
            Admin
          </button>
        </div>

        {loginMode === "operator" ? (
          <div className="login-form">
            <div
              className={`login-field${usernameMissing ? " is-required-missing" : ""}`}
            >
              <label htmlFor="login-username">
                <span className="login-label-text">Name</span>
              </label>
              <input
                id="login-username"
                value={username}
                onChange={(e) => onUsernameChange(stripWhitespace(e.target.value))}
                placeholder="z. B. Tim FOH"
                required
                aria-invalid={usernameMissing ? "true" : undefined}
                aria-describedby={
                  usernameMissing ? "login-username-required" : undefined
                }
              />
              {usernameMissing ? (
                <RequiredFieldHint id="login-username-required">
                  Gib einen Namen ein, um fortzufahren.
                </RequiredFieldHint>
              ) : null}
            </div>
            <div
              className={`login-field${roleMissing ? " is-required-missing" : ""}`}
            >
              <label htmlFor="login-role">
                <span className="login-label-text">Rolle</span>
              </label>
              <select
                id="login-role"
                value={roleId}
                onChange={(e) => onRoleChange(e.target.value)}
                required
                aria-invalid={roleMissing ? "true" : undefined}
                aria-describedby={roleMissing ? "login-role-required" : undefined}
              >
                <option value="">Rolle wählen</option>
                {availableRoles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
                {availableRoles.length === 0 ? (
                  <option value="" disabled>
                    Keine Rolle frei
                  </option>
                ) : null}
              </select>
              {roleMissing ? (
                <RequiredFieldHint id="login-role-required">
                  {roleHintText}
                </RequiredFieldHint>
              ) : null}
            </div>
            <button
              className="primary"
              onClick={onLogin}
              disabled={joinDisabled}
            >
              Intercom beitreten
            </button>
            {loginError ? <p className="login-error">{loginError}</p> : null}
            {takeoverConflict ? (
              <div className="login-admin-card" role="alert">
                <div className="login-admin-head">
                  <h3>Rolle ist gerade belegt</h3>
                </div>
                <p className="login-admin-note">
                  {takeoverConflict.conflictRoleName ||
                    takeoverConflict.conflictRoleId}
                  {" "}
                  ist gerade aktiv
                  {takeoverConflict.conflictUsername
                    ? ` (${takeoverConflict.conflictUsername})`
                    : ""}
                  . Übernehmen beendet die bestehende Sitzung.
                </p>
                <div className="login-admin-actions">
                  <button className="primary" onClick={onConfirmTakeover}>
                    Rolle übernehmen
                  </button>
                  <button className="secondary" onClick={onCancelTakeover}>
                    Abbrechen
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : loginMode === "raspberry" ? (
          <div className="login-remote-panel">
            <div className="login-remote-stations" aria-label="Active Raspberry Pis">
              {remoteStations.length === 0 ? (
                <div className="login-remote-empty">
                  {raspberryRemoteError || "Noch keine Raspberry Pis bekannt."}
                </div>
              ) : (
                remoteStations.map((station) => {
                  const stationRoleId = station.intercomRoleId || station.roleId;
                  const canJoin = station.online && station.intercomConnected;
                  return (
                    <div
                      key={station.deviceId}
                      className={`login-remote-station${canJoin ? " is-ready" : ""}`}
                    >
                      <span>
                        <strong>{station.name}</strong>
                        <span>{roleNameFor(publicData, stationRoleId)}</span>
                      </span>
                      <span className="login-remote-station-actions">
                        <span
                          className={`login-remote-status ${
                            canJoin
                              ? "is-ready"
                              : station.online
                                ? "is-waiting"
                                : "is-offline"
                          }`}
                        >
                          {remoteStationStatusLabel(station)}
                        </span>
                        <button
                          type="button"
                          className="login-remote-join"
                          disabled={!canJoin}
                          onClick={() => onRaspberryRemoteJoin(station)}
                        >
                          Steuern
                        </button>
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        ) : (
          <div
            className="login-admin-card"
            role="tabpanel"
            aria-label="Admin-Bereich"
          >
            <div className="login-admin-head">
              <h3>Admin-Bereich</h3>
              <span className="login-admin-pin-hint">PIN nötig</span>
            </div>
            <p className="login-admin-note">
              Für Rollen, Party Lines und Einstellungen.
            </p>
            <label>
              <span className="login-label-text">Admin-PIN</span>
              <input
                type="password"
                value={adminPin}
                onChange={(e) => onAdminPinChange(e.target.value)}
                placeholder="PIN"
                autoComplete="off"
              />
            </label>
            {adminError ? <p className="login-error">{adminError}</p> : null}
            <div className="login-admin-actions">
              <button
                className="primary"
                onClick={onAdminLogin}
                disabled={!adminPin.trim()}
              >
                Admin-Bereich öffnen
              </button>
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
