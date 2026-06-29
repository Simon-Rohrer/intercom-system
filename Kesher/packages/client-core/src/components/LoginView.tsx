import { useState } from "react";
import type {
  LoginConflict,
  PublicBootstrap,
  RaspberryPiRemoteStationStatus,
} from "../types";

type LoginMode = "operator" | "raspberry";

type LoginViewProps = {
  publicData: PublicBootstrap;
  username: string;
  roleId: string;
  onUsernameChange: (value: string) => void;
  onRoleChange: (roleId: string) => void;
  onLogin: () => void;
  loginError?: string;
  adminPin: string;
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
  if (station.online && station.intercomConnected) return "Ready";
  if (station.online) return "Waiting";
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
  const [showAdmin, setShowAdmin] = useState(false);
  const [loginMode, setLoginMode] = useState<LoginMode>("operator");
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
      ? "No roles are available right now."
      : roleId && !selectedRoleIsAvailable
        ? "The selected role is no longer available."
        : "Select a role to continue.";
  const joinDisabled = usernameMissing || roleMissing;
  const remoteStations = raspberryRemoteStations ?? [];

  return (
    <div className="root login">
      <div className="login-card panel">
        <div className="login-card-head">
          <h1>Live Production Intercom</h1>
          <p className="variant-subtitle">Station Deck</p>
        </div>
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
            Raspberry remote
          </button>
        </div>

        {loginMode === "operator" ? (
          <div className="login-form">
            <div
              className={`login-field${usernameMissing ? " is-required-missing" : ""}`}
            >
              <label htmlFor="login-username">
                <span className="login-label-text">Display name</span>
              </label>
              <input
                id="login-username"
                value={username}
                onChange={(e) => onUsernameChange(stripWhitespace(e.target.value))}
                placeholder="e.g. Tim FOH"
                required
                aria-invalid={usernameMissing ? "true" : undefined}
                aria-describedby={
                  usernameMissing ? "login-username-required" : undefined
                }
              />
              {usernameMissing ? (
                <RequiredFieldHint id="login-username-required">
                  Enter a display name to continue.
                </RequiredFieldHint>
              ) : null}
            </div>
            <div
              className={`login-field${roleMissing ? " is-required-missing" : ""}`}
            >
              <label htmlFor="login-role">
                <span className="login-label-text">Role</span>
              </label>
              <select
                id="login-role"
                value={roleId}
                onChange={(e) => onRoleChange(e.target.value)}
                required
                aria-invalid={roleMissing ? "true" : undefined}
                aria-describedby={roleMissing ? "login-role-required" : undefined}
              >
                <option value="">Select role</option>
                {availableRoles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
                {availableRoles.length === 0 ? (
                  <option value="" disabled>
                    No roles available
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
              Join Intercom
            </button>
            {loginError ? <p className="login-error">{loginError}</p> : null}
            {takeoverConflict ? (
              <div className="login-admin-card" role="alert">
                <div className="login-admin-head">
                  <h3>Role currently in use</h3>
                </div>
                <p className="login-admin-note">
                  {takeoverConflict.conflictRoleName ||
                    takeoverConflict.conflictRoleId}
                  {" "}
                  is currently active
                  {takeoverConflict.conflictUsername
                    ? ` by ${takeoverConflict.conflictUsername}`
                    : ""}
                  . Confirm takeover to replace the existing session.
                </p>
                <div className="login-admin-actions">
                  <button className="primary" onClick={onConfirmTakeover}>
                    Confirm takeover
                  </button>
                  <button className="secondary" onClick={onCancelTakeover}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="login-remote-panel">
            <div className="login-remote-stations" aria-label="Active Raspberry Pis">
              {remoteStations.length === 0 ? (
                <div className="login-remote-empty">
                  {raspberryRemoteError || "No Raspberry Pi stations known yet."}
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
                          Join
                        </button>
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        <div className="login-admin-disclosure">
          <button
            type="button"
            className="login-admin-disclosure-trigger"
            onClick={() => setShowAdmin((value) => !value)}
            aria-expanded={showAdmin}
            aria-controls="login-admin-panel"
            aria-label="Admin console"
          >
            <span className="login-admin-disclosure-label">
              <span>Admin console</span>
              <span className="login-admin-pin-hint">PIN required</span>
            </span>
            <svg
              className={`login-admin-chevron${showAdmin ? " is-open" : ""}`}
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>

          {showAdmin ? (
            <div
              id="login-admin-panel"
              className="login-admin-card login-admin-disclosure-panel"
              role="region"
              aria-label="Admin console"
            >
              <p className="login-admin-note">
                For role and channel configuration only.
              </p>
              <label>
                <span className="login-label-text">Admin PIN</span>
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
                  Open admin console
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
