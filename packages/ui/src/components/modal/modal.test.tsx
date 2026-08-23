import { fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, mock, test } from "bun:test";
import { useRef, useState } from "react";

import { expectNoA11yViolations } from "../../internal/test/axe";

import { Modal } from "./modal";

const renderModal = (props: Partial<Parameters<typeof Modal>[0]> = {}) =>
  render(
    <Modal open onClose={() => undefined} title="Delete course" {...props}>
      <Modal.Body>This cannot be undone.</Modal.Body>
      <Modal.Footer>
        <button type="button">Cancel</button>
        <button type="button">Delete</button>
      </Modal.Footer>
    </Modal>,
  );

const dialog = () => screen.getByRole("dialog");

describe("Modal", () => {
  test("renders nothing when closed", () => {
    renderModal({ open: false });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("renders an accessible modal dialog named by its title", () => {
    renderModal();

    expect(dialog().getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("dialog", { name: "Delete course" })).toBeDefined();
  });

  test("describes the dialog when a description is given", () => {
    renderModal({ description: "Removes every lesson." });
    const describedBy = dialog().getAttribute("aria-describedby");

    expect(document.getElementById(describedBy as string)?.textContent).toBe(
      "Removes every lesson.",
    );
  });

  test("omits aria-describedby when there is no description", () => {
    renderModal();

    expect(dialog().hasAttribute("aria-describedby")).toBe(false);
  });

  test("renders into a portal on document.body, not in place", () => {
    const { container } = renderModal();

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.contains(dialog())).toBe(true);
  });

  test("moves focus into the dialog on open", () => {
    renderModal();

    expect(dialog().contains(document.activeElement)).toBe(true);
  });

  test("defaults focus to the first content control, not the header's close button", () => {
    // The close button is first in DOM order in every `@studafy/ui` dialog, but a sighted mouse
    // user's eye (and the ARIA APG's own guidance) goes to the dialog's content first — so that is
    // what a keyboard/AT user should land on too, not the chrome around it.
    render(
      <Modal open onClose={() => undefined} title="New invitation">
        <Modal.Body>
          <input type="email" aria-label="Email" />
        </Modal.Body>
      </Modal>,
    );

    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Email" }));
  });

  test("falls back to the close button when the dialog has no other focusable content", () => {
    render(
      <Modal open onClose={() => undefined} title="Delete course">
        <Modal.Body>This cannot be undone.</Modal.Body>
      </Modal>,
    );

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close dialog" }));
  });

  test("initialFocusRef still wins over the first-content-control default", () => {
    function WithRef() {
      const ref = useRef<HTMLButtonElement>(null);
      return (
        <Modal open onClose={() => undefined} title="New invitation" initialFocusRef={ref}>
          <Modal.Body>
            <input type="email" aria-label="Email" />
          </Modal.Body>
          <Modal.Footer>
            <button type="button" ref={ref}>
              Send
            </button>
          </Modal.Footer>
        </Modal>
      );
    }
    render(<WithRef />);

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Send" }));
  });

  test("honours initialFocusRef", () => {
    function WithInitialFocus() {
      const ref = useRef<HTMLButtonElement>(null);
      return (
        <Modal open onClose={() => undefined} title="Delete course" initialFocusRef={ref}>
          <Modal.Footer>
            <button type="button">Cancel</button>
            <button type="button" ref={ref}>
              Delete
            </button>
          </Modal.Footer>
        </Modal>
      );
    }
    render(<WithInitialFocus />);

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete" }));
  });

  test("restores focus to the previously focused element on close", () => {
    function Toggle() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <Modal open={open} onClose={() => setOpen(false)} title="Delete course">
            <Modal.Body>Body</Modal.Body>
          </Modal>
        </>
      );
    }
    render(<Toggle />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();

    fireEvent.click(opener);
    expect(dialog()).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));

    expect(document.activeElement).toBe(opener);
  });

  test("Escape closes the dialog", () => {
    const onClose = mock();
    renderModal({ onClose });

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("closeOnEsc=false ignores Escape", () => {
    const onClose = mock();
    renderModal({ onClose, closeOnEsc: false });

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
  });

  test("the close button closes the dialog", () => {
    const onClose = mock();
    renderModal({ onClose });

    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("clicking the overlay closes the dialog", () => {
    const onClose = mock();
    const { baseElement } = renderModal({ onClose });
    const overlay = baseElement.querySelector(".sf-modal__overlay") as HTMLElement;

    fireEvent.mouseDown(overlay);
    fireEvent.click(overlay);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("clicking inside the dialog does not close it", () => {
    const onClose = mock();
    renderModal({ onClose });

    fireEvent.mouseDown(dialog());
    fireEvent.click(dialog());

    expect(onClose).not.toHaveBeenCalled();
  });

  test("a drag that starts inside the dialog and ends on the overlay does not close it", () => {
    const onClose = mock();
    const { baseElement } = renderModal({ onClose });
    const overlay = baseElement.querySelector(".sf-modal__overlay") as HTMLElement;

    fireEvent.mouseDown(dialog());
    fireEvent.click(overlay);

    expect(onClose).not.toHaveBeenCalled();
  });

  test("closeOnOverlayClick=false ignores overlay clicks", () => {
    const onClose = mock();
    const { baseElement } = renderModal({ onClose, closeOnOverlayClick: false });
    const overlay = baseElement.querySelector(".sf-modal__overlay") as HTMLElement;

    fireEvent.mouseDown(overlay);
    fireEvent.click(overlay);

    expect(onClose).not.toHaveBeenCalled();
  });

  test("Tab from the last focusable element wraps to the first", () => {
    renderModal();
    const focusables = Array.from(dialog().querySelectorAll("button"));
    const last = focusables[focusables.length - 1];
    last.focus();

    fireEvent.keyDown(document, { key: "Tab" });

    expect(document.activeElement).toBe(focusables[0]);
  });

  test("Shift+Tab from the first focusable element wraps to the last", () => {
    renderModal();
    const focusables = Array.from(dialog().querySelectorAll("button"));
    focusables[0].focus();

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });

    expect(document.activeElement).toBe(focusables[focusables.length - 1]);
  });

  test("locks background scrolling while open and restores it on close", () => {
    const { rerender } = renderModal();
    expect(document.body.style.overflow).toBe("hidden");

    rerender(
      <Modal open={false} onClose={() => undefined} title="Delete course">
        <Modal.Body>Body</Modal.Body>
      </Modal>,
    );

    expect(document.body.style.overflow).not.toBe("hidden");
  });

  test("removes its portal container on unmount", () => {
    const { unmount } = renderModal();
    // The portal container is the <body> child the dialog was mounted into. Counting body children
    // would not work: Testing Library leaves its own render container behind after `unmount`.
    const portalContainer = dialog().closest("body > *");
    expect(portalContainer).not.toBeNull();

    unmount();

    expect(document.body.contains(portalContainer as Element)).toBe(false);
  });

  test("has no accessibility violations", async () => {
    renderModal({ description: "Removes every lesson." });

    // The dialog is portalled, so scope axe at the dialog itself rather than the render container.
    await expectNoA11yViolations(dialog());
  });
});
