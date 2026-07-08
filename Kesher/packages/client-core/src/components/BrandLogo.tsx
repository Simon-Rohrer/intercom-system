import jmsLogoUrl from "../assets/jms-logo-transparent.svg?url";

type BrandLogoProps = {
  className?: string;
  compact?: boolean;
};

export function BrandLogo({ className = "", compact = false }: BrandLogoProps) {
  return (
    <img
      className={`app-brand-logo ${compact ? "app-brand-logo-compact" : ""} ${className}`.trim()}
      src={jmsLogoUrl}
      alt="JMS Logo"
      loading="eager"
      decoding="async"
    />
  );
}
