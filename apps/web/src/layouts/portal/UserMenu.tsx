import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { useSessionStore } from "../../lib/auth";
import { useTranslation } from "../../lib/i18n";

import { DeviceSessionsPanel } from "./DeviceSessionsPanel";
import { useDisclosure } from "./use-disclosure";

/** User menu: devices/sessions and sign-out, both against the real session-lifecycle endpoints. */
export function UserMenu() {
  const { t } = useTranslation();
  const { open, toggle, close, triggerRef, panelRef } = useDisclosure();
  const [devicePanelOpen, setDevicePanelOpen] = useState(false);
  const store = useSessionStore();
  const navigate = useNavigate();
  const panelId = "portal-user-menu-panel";

  const handleSignOut = async () => {
    close();
    await store.logout();
    void navigate("/", { replace: true });
  };

  return (
    <div className="portal-user-menu">
      <button
        ref={triggerRef}
        type="button"
        className="portal-icon-button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
          <circle cx="10" cy="7" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M3.5 17c1-3.3 3.8-5 6.5-5s5.5 1.7 6.5 5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
        <span className="sf-visually-hidden">{t("userMenu.ariaLabel")}</span>
      </button>

      {open ? (
        <div
          id={panelId}
          ref={panelRef}
          role="region"
          aria-label={t("userMenu.ariaLabel")}
          className="portal-popover portal-user-menu__panel"
        >
          <button
            type="button"
            className="portal-user-menu__item"
            onClick={() => {
              setDevicePanelOpen(true);
              close();
            }}
          >
            {t("userMenu.devicesAndSessions")}
          </button>
          <button
            type="button"
            className="portal-user-menu__item"
            onClick={() => void handleSignOut()}
          >
            {t("userMenu.signOut")}
          </button>
        </div>
      ) : null}

      <DeviceSessionsPanel open={devicePanelOpen} onClose={() => setDevicePanelOpen(false)} />
    </div>
  );
}
