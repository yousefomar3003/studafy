import { forwardRef, useEffect, useImperativeHandle, useId, useRef, useState } from "react";

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js";

interface TurnstileRenderOptions {
  sitekey: string;
  callback: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: () => void;
}

interface TurnstileApi {
  render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

// Cloudflare's script self-registers `window.turnstile` once loaded; a module-level promise
// makes concurrent/repeated mounts share one <script> tag and one load instead of racing.
let scriptLoad: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) {
    return Promise.resolve(window.turnstile);
  }
  scriptLoad ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (window.turnstile) {
        resolve(window.turnstile);
      } else {
        reject(new Error("Turnstile script loaded but window.turnstile is unavailable."));
      }
    };
    script.onerror = () => reject(new Error("Failed to load the Turnstile script."));
    document.head.appendChild(script);
  });
  return scriptLoad;
}

export interface TurnstileWidgetHandle {
  /** Discards the current (single-use) token and issues a fresh challenge. */
  reset: () => void;
}

export interface TurnstileWidgetProps {
  siteKey: string;
  onToken: (token: string) => void;
  /** Fires when a token expires or the widget errors — callers should clear any held token. */
  onInvalidate?: () => void;
}

/**
 * Cloudflare Turnstile bot-protection widget (registration/captcha.ts is the server-side half).
 * Hand-rolled rather than a dependency: this is the only Turnstile call site in the app, and the
 * script-load + render/reset lifecycle is a few lines, not worth a package for one widget.
 */
export const TurnstileWidget = forwardRef<TurnstileWidgetHandle, TurnstileWidgetProps>(
  function TurnstileWidget({ siteKey, onToken, onInvalidate }, ref) {
    const containerId = useId();
    const containerRef = useRef<HTMLDivElement>(null);
    const widgetIdRef = useRef<string | null>(null);
    const [error, setError] = useState(false);

    useImperativeHandle(ref, () => ({
      reset: () => {
        const widgetId = widgetIdRef.current;
        if (widgetId && window.turnstile) {
          window.turnstile.reset(widgetId);
        }
      },
    }));

    useEffect(() => {
      let cancelled = false;

      loadTurnstile()
        .then((turnstile) => {
          if (cancelled || !containerRef.current) return;
          widgetIdRef.current = turnstile.render(containerRef.current, {
            sitekey: siteKey,
            callback: onToken,
            "expired-callback": onInvalidate,
            "error-callback": onInvalidate,
          });
        })
        .catch(() => {
          if (!cancelled) setError(true);
        });

      return () => {
        cancelled = true;
        const widgetId = widgetIdRef.current;
        if (widgetId && window.turnstile) {
          window.turnstile.remove(widgetId);
        }
      };
      // Deliberately keyed on `siteKey` alone: `onToken`/`onInvalidate` are re-created every render
      // by their callers, and including them would tear down and re-issue a real Turnstile
      // challenge on every keystroke upstream.
    }, [siteKey]);

    if (error) {
      return (
        <p role="alert">
          Bot-protection challenge failed to load. Check your connection and reload the page.
        </p>
      );
    }

    return <div id={containerId} ref={containerRef} />;
  },
);
