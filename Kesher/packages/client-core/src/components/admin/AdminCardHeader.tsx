import type { MouseEvent, ReactNode } from "react";

type AdminCardHeaderProps = {
  title: ReactNode;
  isOpen: boolean;
  onToggle: () => void;
};

export function AdminCardHeader({
  title,
  isOpen,
  onToggle,
}: AdminCardHeaderProps) {
  const handleButtonClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onToggle();
  };

  return (
    <div
      className="admin-card-header admin-card-header-clickable"
      onClick={onToggle}
    >
      <div className="admin-card-title">{title}</div>
      <div className="admin-card-actions">
        <button
          type="button"
          className="admin-toggle-button"
          onClick={handleButtonClick}
          aria-expanded={isOpen}
        >
          {isOpen ? "Hide" : "Show"}
        </button>
      </div>
    </div>
  );
}
