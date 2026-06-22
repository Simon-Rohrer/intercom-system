type LowPowerModeBadgeProps = {
  className?: string;
};

export function LowPowerModeBadge({
  className = "",
}: LowPowerModeBadgeProps) {
  return (
    <div
      className={`low-power-mode-badge ${className}`.trim()}
      role="status"
      aria-label="Low power mode active"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="7" width="16" height="10" rx="2" />
        <path d="M21 10v4" />
        <path d="m12 9-3 4h3l-1 2 4-5h-3l1-1Z" />
      </svg>
      <span>Low power mode</span>
    </div>
  );
}
