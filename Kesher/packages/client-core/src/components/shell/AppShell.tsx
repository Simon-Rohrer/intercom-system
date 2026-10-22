import { useEffect, useState, type ReactNode } from "react";
import { loadJmsTheme } from "./jmsTheme";
import { dashboardUrl, isDesktopApp, userInitials } from "./shellLinks";

/**
 * Page frame of Kesher in the style of JMS Control: sidebar (brand, entries,
 * user card) + top bar + page. Same structure on PC and phone; on phones
 * (≤ 980 px) the sidebar slides in from the left via the ☰ button.
 * Not used for kiosk stations, embedded tiles, the Raspberry remote session
 * and the chat display – those keep their bare full-screen views.
 */

export type ShellIconName = "dashboard" | "intercom" | "settings" | "admin" | "simple";

export type ShellSubItem = {
  id: string;
  label: string;
  active: boolean;
  onSelect: () => void;
  count?: number;
};

export type ShellSubGroup = {
  label?: string;
  items: ShellSubItem[];
};

export type ShellNavItem = {
  id: string;
  label: string;
  icon: ShellIconName;
  active: boolean;
  onSelect: () => void;
  /** Sub-navigation shown below the entry (e.g. the admin sections). */
  groups?: ShellSubGroup[];
};

export type ShellUser = {
  name: string;
  role: string;
  /** Link for "Konto wechseln" (central login) … */
  switchAccountHref?: string;
  /** … or what happens instead (without central login: sign out). */
  onSwitchAccount: () => void;
  onLogout: () => void;
};

type AppShellProps = {
  items: ShellNavItem[];
  user: ShellUser;
  /** Left part of the top bar: status of the page (e.g. Live, role, mic). */
  status?: ReactNode;
  /** Right part of the top bar: page actions. */
  actions?: ReactNode;
  /** Fill exactly one screen (the station deck scrolls on its own on wide screens). */
  fit?: boolean;
  className?: string;
  children: ReactNode;
};

const COLLAPSED_STORAGE_KEY = "kesher.sidebarCollapsed";

type Scheme = "light" | "dark";

/** Browsers without :where() (e.g. old iPads with Safari 12) keep the dark look. */
function supportsLightScheme(): boolean {
  try {
    return typeof CSS !== "undefined" && CSS.supports("selector(:where(a))");
  } catch {
    return false;
  }
}

/** Light/dark like JMS Control: the user's choice (data-theme from theme-boot.js), else the system. */
function resolveScheme(): Scheme {
  if (typeof window === "undefined" || !supportsLightScheme()) return "dark";
  const theme = document.documentElement.dataset.theme;
  if (theme === "light" || theme === "dark") return theme;
  return typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function useColorScheme(): Scheme {
  const [scheme, setScheme] = useState<Scheme>(resolveScheme);
  useEffect(() => {
    const update = () => setScheme(resolveScheme());
    const query =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : null;
    if (query?.addEventListener) query.addEventListener("change", update);
    else query?.addListener?.(update);
    const observer =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(update);
    observer?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => {
      if (query?.removeEventListener) query.removeEventListener("change", update);
      else query?.removeListener?.(update);
      observer?.disconnect();
    };
  }, []);
  return scheme;
}

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function ShellIcon({ name }: { name: ShellIconName | "menu" | "sidebar" }) {
  const common = {
    viewBox: "0 0 24 24",
    className: "k-icon",
    "aria-hidden": true as const,
  };
  switch (name) {
    case "dashboard":
      return (
        <svg {...common}>
          {/* ‹ zurück zum Dashboard */}
          <path d="M14.5 5.5 8 12l6.5 6.5" />
        </svg>
      );
    case "intercom":
      return (
        <svg {...common}>
          <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
          <rect x="3" y="13.5" width="4" height="6" rx="1.6" />
          <rect x="17" y="13.5" width="4" height="6" rx="1.6" />
          <path d="M19 19.5c0 1.2-1.6 2-4 2h-2" />
        </svg>
      );
    case "simple":
      return (
        <svg {...common}>
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
        </svg>
      );
    case "settings":
      return (
        <svg {...common}>
          <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
          <circle cx="16" cy="7" r="2.2" />
          <circle cx="10" cy="17" r="2.2" />
        </svg>
      );
    case "admin":
      return (
        <svg {...common}>
          <path d="M12 3 5 6v5c0 4.4 3 8.4 7 9.5 4-1.1 7-5.1 7-9.5V6l-7-3z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );
    case "menu":
      return (
        <svg {...common}>
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      );
    case "sidebar":
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2.5" />
          <path d="M9 4v16" />
        </svg>
      );
  }
}

export function AppShell({
  items,
  user,
  status,
  actions,
  fit = false,
  className = "",
  children,
}: AppShellProps) {
  const [navOpen, setNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [showDashboard] = useState(() => !isDesktopApp());
  const scheme = useColorScheme();

  useEffect(() => {
    loadJmsTheme();
  }, []);

  useEffect(() => {
    if (!navOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNavOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [navOpen]);

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(COLLAPSED_STORAGE_KEY, next ? "1" : "0");
      } catch {
        // remembering is a convenience only
      }
      return next;
    });
  };

  const select = (onSelect: () => void) => {
    onSelect();
    setNavOpen(false);
  };

  return (
    <div
      className={`k-shell ${fit ? "k-shell-fit" : ""} ${navOpen ? "is-nav-open" : ""} ${
        collapsed ? "is-collapsed" : ""
      } ${className}`.trim()}
      data-scheme={scheme}
    >
      <aside className="k-sidebar" id="k-sidebar" aria-label="Seitenleiste">
        <div className="k-sidebar-head">
          <span className="k-brand">
            <span className="k-brand-logo" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
            </span>
            <span className="k-brand-text">
              JMS Intercom<small>Kesher</small>
            </span>
          </span>
          <button
            type="button"
            className="k-icon-btn k-sidebar-collapse"
            aria-label="Seitenleiste ausblenden"
            title="Seitenleiste ausblenden"
            onClick={toggleCollapsed}
          >
            <ShellIcon name="sidebar" />
          </button>
        </div>

        <nav className="k-site-nav" aria-label="Bereiche">
          {showDashboard ? (
            <a
              href={dashboardUrl()}
              className="k-nav-link"
              data-page="dashboard"
              title="Zurück zum Dashboard"
            >
              <ShellIcon name="dashboard" />
              <span>Dashboard</span>
            </a>
          ) : null}
          {items.map((item) => (
            <div className="k-nav-entry" key={item.id}>
              <button
                type="button"
                className={`k-nav-link ${item.active ? "active" : ""}`.trim()}
                data-page={item.id}
                aria-current={item.active && !item.groups ? "page" : undefined}
                onClick={() => select(item.onSelect)}
              >
                <ShellIcon name={item.icon} />
                <span>{item.label}</span>
              </button>
              {item.groups ? (
                <div className="k-subnav-tree" aria-label={`Bereiche: ${item.label}`} role="group">
                  {item.groups.map((group, index) => (
                    <div className="k-subnav-group" key={group.label ?? index}>
                      {group.label ? (
                        <span className="k-subnav-label">{group.label}</span>
                      ) : null}
                      {group.items.map((sub) => (
                        <button
                          key={sub.id}
                          type="button"
                          className={`k-subnav-link ${sub.active ? "active" : ""}`.trim()}
                          aria-current={sub.active ? "page" : undefined}
                          onClick={() => select(sub.onSelect)}
                        >
                          <span>{sub.label}</span>
                          {sub.count !== undefined ? <small>{sub.count}</small> : null}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </nav>

        <div className="k-sidebar-foot">
          <div className="k-user-card">
            <span className="k-avatar" aria-hidden="true">
              {userInitials(user.name)}
            </span>
            <div className="k-user-meta">
              <b>{user.name}</b>
              <span>{user.role}</span>
            </div>
            <div className="k-user-actions">
              {user.switchAccountHref ? (
                <a
                  className="k-icon-btn"
                  href={user.switchAccountHref}
                  title="Konto wechseln"
                  aria-label="Konto wechseln"
                >
                  <svg viewBox="0 0 24 24" className="k-icon" aria-hidden="true">
                    <path d="M7 7h12l-3-3M17 17H5l3 3" />
                  </svg>
                </a>
              ) : (
                <button
                  type="button"
                  className="k-icon-btn"
                  title="Konto wechseln"
                  aria-label="Konto wechseln"
                  onClick={user.onSwitchAccount}
                >
                  <svg viewBox="0 0 24 24" className="k-icon" aria-hidden="true">
                    <path d="M7 7h12l-3-3M17 17H5l3 3" />
                  </svg>
                </button>
              )}
              <button
                type="button"
                className="k-icon-btn"
                title="Abmelden"
                aria-label="Abmelden"
                onClick={user.onLogout}
              >
                <svg viewBox="0 0 24 24" className="k-icon" aria-hidden="true">
                  <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </aside>
      <div
        className="k-sidebar-backdrop"
        aria-hidden="true"
        onClick={() => setNavOpen(false)}
      />

      <div className="k-main-col">
        <header className="k-topbar">
          <button
            type="button"
            className="k-icon-btn k-menu-btn"
            aria-label="Menü"
            aria-controls="k-sidebar"
            aria-expanded={navOpen}
            onClick={() => setNavOpen((open) => !open)}
          >
            <ShellIcon name="menu" />
          </button>
          <button
            type="button"
            className="k-icon-btn k-sidebar-expand"
            aria-label="Seitenleiste einblenden"
            title="Seitenleiste einblenden"
            onClick={toggleCollapsed}
          >
            <ShellIcon name="sidebar" />
          </button>
          <div className="k-topbar-status">{status}</div>
          {actions ? <div className="k-topbar-actions">{actions}</div> : null}
        </header>
        <main className="k-main">{children}</main>
      </div>
    </div>
  );
}
