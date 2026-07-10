import { act, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, mock, test } from "bun:test";
import { useRef } from "react";

import { expectNoA11yViolations } from "../../internal/test/axe";

import { ToastProvider, useToast } from "./toast";

import type { ToastOptions, ToastProviderProps } from "./toast";

/** Fires a toast on click, so every `show` call is wrapped in an act-ed event handler. */
function Trigger({ label = "Notify", ...options }: ToastOptions & { label?: string }) {
  const { show } = useToast();
  return (
    <button type="button" onClick={() => show(options)}>
      {label}
    </button>
  );
}

/** Shows a toast, remembers its id, and dismisses it programmatically on a second button. */
function ShowAndDismiss(options: ToastOptions) {
  const { show, dismiss } = useToast();
  const id = useRef<string | null>(null);

  return (
    <>
      <button type="button" onClick={() => (id.current = show(options))}>
        Notify
      </button>
      <button type="button" onClick={() => id.current && dismiss(id.current)}>
        Dismiss programmatically
      </button>
    </>
  );
}

const renderWithProvider = (ui: React.ReactNode, props: Partial<ToastProviderProps> = {}) =>
  render(<ToastProvider {...props}>{ui}</ToastProvider>);

const notify = () => fireEvent.click(screen.getByRole("button", { name: "Notify" }));

const viewport = () => document.querySelector(".sf-toast-viewport") as HTMLElement;

/**
 * Lets real timers elapse inside `act`, so the auto-dismiss re-render is flushed before we assert.
 * `waitFor` is not usable here: it polls a MutationObserver that does not observe the portal.
 */
const elapse = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

describe("ToastProvider", () => {
  test("renders a portalled viewport before any toast exists", () => {
    const { container } = renderWithProvider(<Trigger title="Saved" />);

    expect(container.querySelector(".sf-toast-viewport")).toBeNull();
    expect(document.body.contains(viewport())).toBe(true);
    expect(viewport().children).toHaveLength(0);
  });

  test("show renders the toast title and description", () => {
    renderWithProvider(<Trigger title="Saved" description="Your course was updated." />);
    notify();

    expect(screen.getByText("Saved")).toBeDefined();
    expect(screen.getByText("Your course was updated.")).toBeDefined();
  });

  test("omits the description when none is given", () => {
    renderWithProvider(<Trigger title="Saved" />);
    notify();

    expect(document.querySelector(".sf-toast__description")).toBeNull();
  });

  test("defaults to the info variant", () => {
    renderWithProvider(<Trigger title="Heads up" />);
    notify();

    expect(document.querySelector(".sf-toast")?.className).toContain("sf-toast--info");
  });

  test.each([["success"], ["error"], ["warning"], ["info"]] as const)(
    "applies the %s variant class",
    (variant) => {
      renderWithProvider(<Trigger title="Saved" variant={variant} />);
      notify();

      expect(document.querySelector(".sf-toast")?.className).toContain(`sf-toast--${variant}`);
    },
  );

  test.each([["error"], ["warning"]] as const)("announces %s assertively", (variant) => {
    renderWithProvider(<Trigger title="Upload failed" variant={variant} />);
    notify();

    expect(screen.getByRole("alert")).toBeDefined();
  });

  test.each([["success"], ["info"]] as const)("announces %s politely", (variant) => {
    renderWithProvider(<Trigger title="Saved" variant={variant} />);
    notify();

    expect(screen.getByRole("status")).toBeDefined();
  });

  test("auto-dismisses after the provider's default duration", async () => {
    renderWithProvider(<Trigger title="Saved" />, { duration: 20 });
    notify();
    expect(screen.getByText("Saved")).toBeDefined();

    await elapse(40);

    expect(screen.queryByText("Saved")).toBeNull();
  });

  test("a per-toast duration overrides the provider default", async () => {
    renderWithProvider(<Trigger title="Saved" duration={20} />, { duration: 100_000 });
    notify();

    await elapse(40);

    expect(screen.queryByText("Saved")).toBeNull();
  });

  test("duration 0 keeps the toast until it is dismissed", async () => {
    renderWithProvider(<Trigger title="Saved" duration={0} />, { duration: 20 });
    notify();

    await elapse(40);

    expect(screen.getByText("Saved")).toBeDefined();
  });

  test("the dismiss button names the toast it closes and removes it", () => {
    renderWithProvider(<Trigger title="Saved" duration={0} />);
    notify();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss Saved" }));

    expect(screen.queryByText("Saved")).toBeNull();
  });

  test("dismiss(id) removes the toast that show returned", () => {
    renderWithProvider(<ShowAndDismiss title="Saved" duration={0} />);
    notify();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss programmatically" }));

    expect(screen.queryByText("Saved")).toBeNull();
  });

  test("stacks concurrent toasts in the order they were shown", () => {
    renderWithProvider(
      <>
        <Trigger label="Notify" title="First" duration={0} />
        <Trigger label="Notify second" title="Second" duration={0} />
      </>,
    );
    notify();
    fireEvent.click(screen.getByRole("button", { name: "Notify second" }));

    const titles = [...viewport().querySelectorAll(".sf-toast__title")].map(
      (node) => node.textContent,
    );
    expect(titles).toEqual(["First", "Second"]);
  });

  test("useToast throws outside a provider", () => {
    const onError = mock();
    const originalError = console.error;
    console.error = onError;

    try {
      expect(() => render(<Trigger title="Saved" />)).toThrow(
        "useToast must be called inside <ToastProvider>.",
      );
    } finally {
      console.error = originalError;
    }
  });

  test("removes its portal viewport on unmount", () => {
    const { unmount } = renderWithProvider(<Trigger title="Saved" />);
    const portalContainer = viewport().closest("body > *");

    unmount();

    expect(document.body.contains(portalContainer as Element)).toBe(false);
  });

  test("has no accessibility violations", async () => {
    renderWithProvider(
      <>
        <Trigger label="Notify" title="Saved" variant="success" duration={0} />
        <Trigger label="Notify error" title="Upload failed" variant="error" duration={0} />
      </>,
    );
    notify();
    fireEvent.click(screen.getByRole("button", { name: "Notify error" }));

    // The viewport is portalled, so scope axe at it rather than at the render container.
    await expectNoA11yViolations(viewport());
  });
});
