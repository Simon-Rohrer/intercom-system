import { useCallback, useState } from "react";
import { publishUserCompanionProfile } from "../../api";
import type { CompanionProfileResponse } from "../../types";

type UserCompanionCardProps = {
  token: string;
  username: string;
  roleId: string;
};

function DisclosureChevronIcon({ isOpen }: { isOpen: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{
        width: "18px",
        height: "18px",
        transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 160ms ease",
      }}
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function UserCompanionCard({
  token,
  username,
  roleId,
}: UserCompanionCardProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [published, setPublished] = useState<CompanionProfileResponse | null>(
    null
  );

  const handlePublish = useCallback(async () => {
    setPublishing(true);
    setError("");
    setMessage("");
    try {
      const result = await publishUserCompanionProfile(token);
      setPublished(result);
      setMessage(
        `${result.roleId} als Version ${result.profileVersion} gesendet`
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Profil konnte nicht gesendet werden"
      );
    } finally {
      setPublishing(false);
    }
  }, [token]);

  return (
    <div className="card">
      <div
        className="card-header"
        style={{ cursor: "pointer" }}
        onClick={() => setIsOpen(!isOpen)}
      >
        <h3
          style={{
            margin: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "0.5rem",
          }}
        >
          <span>Companion-Profil senden</span>
          <DisclosureChevronIcon isOpen={isOpen} />
        </h3>
      </div>
      {isOpen && (
        <div className="card-content">
          {error && <div className="error-message">{error}</div>}
          {message && <div className="success-message">{message}</div>}

          <div style={{ marginBottom: "1rem" }}>
            <p>
              <strong>Deine Rolle:</strong> {roleId}
            </p>
            <p>
              Mit dem Knopf unten sendest du dein Companion-Profil an das
              Stream Deck.
            </p>
          </div>

          <button
            onClick={handlePublish}
            disabled={publishing}
            className="button"
            style={{
              backgroundColor: publishing ? "#ccc" : "#4CAF50",
              color: "white",
              padding: "10px 20px",
              border: "none",
              borderRadius: "4px",
              cursor: publishing ? "not-allowed" : "pointer",
              marginBottom: "1rem",
            }}
          >
            {publishing ? "Sende …" : "Mein Profil senden"}
          </button>

          {published && (
            <div style={{ marginTop: "1rem" }}>
              <h4>Gesendet:</h4>
              <ul style={{ lineHeight: "1.8" }}>
                <li>
                  <strong>Rollen-Kennung:</strong> {published.roleId}
                </li>
                <li>
                  <strong>Benutzername:</strong> {published.username}
                </li>
                <li>
                  <strong>Version:</strong> {published.profileVersion}
                </li>
                <li>
                  <strong>Status:</strong> {published.profileStatus}
                </li>
                {published.profileUpdatedAt && (
                  <li>
                    <strong>Aktualisiert:</strong>{" "}
                    {new Date(published.profileUpdatedAt).toLocaleString("de-DE")}
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
