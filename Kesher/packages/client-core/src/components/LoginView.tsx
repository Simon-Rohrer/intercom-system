import { useState } from "react";
import type { LoginConflict, PublicBootstrap } from "../types";

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
};

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
}: LoginViewProps) {
  const stripWhitespace = (value: string) => value.replace(/\s+/g, "");
  const [showAdmin, setShowAdmin] = useState(false);
  const activeRoleIds = new Set(publicData.activeRoleIds);
  const availableRoles = publicData.roles.filter(
    (role) => !activeRoleIds.has(role.id),
  );
  const selectedRoleIsAvailable = availableRoles.some(
    (role) => role.id === roleId,
  );
  return (
    <div className="root login">
      <div className="login-card panel">
        <div className="login-card-head">
          <h1>Live Production Intercom</h1>
          <p className="variant-subtitle">Station Deck</p>
        </div>
        <div className="login-form">
          <label>
            <span className="login-label-text">Display name</span>
            <input
              value={username}
              onChange={(e) => onUsernameChange(stripWhitespace(e.target.value))}
              placeholder="e.g. Tim FOH"
            />
          </label>
          <label>
            <span className="login-label-text">Role</span>
            <select
              value={roleId}
              onChange={(e) => onRoleChange(e.target.value)}
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
          </label>
          <button
            className="primary"
            onClick={onLogin}
            disabled={!username.trim() || !roleId || !selectedRoleIsAvailable}
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
                {takeoverConflict.conflictRoleName || takeoverConflict.conflictRoleId}
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
