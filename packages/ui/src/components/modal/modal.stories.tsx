import { useRef, useState } from "react";

import { Button } from "../button";

import { Modal } from "./modal";

import type { Meta, StoryObj } from "@storybook/react-vite";

const meta: Meta<typeof Modal> = {
  title: "Components/Modal",
  component: Modal,
  tags: ["autodocs"],
  args: { title: "Delete course", open: true },
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          'A portalled `role="dialog"` with `aria-modal`. Focus moves into the dialog on open, ' +
          "Tab and Shift+Tab wrap inside it, and focus returns to the trigger on close. Escape " +
          "and an overlay click both dismiss unless disabled. An overlay click only counts when " +
          "the gesture starts *and* ends on the overlay, so a drag out of the dialog cannot " +
          "dismiss it by accident.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Modal>;

const Contents = () => (
  <>
    <Modal.Body>This cannot be undone. Every lesson and submission will be removed.</Modal.Body>
    <Modal.Footer>
      <Button variant="tertiary">Cancel</Button>
      <Button variant="primary">Delete</Button>
    </Modal.Footer>
  </>
);

export const Default: Story = {
  render: (args) => (
    <Modal {...args} onClose={() => undefined}>
      <Contents />
    </Modal>
  ),
};

export const WithDescription: Story = {
  args: { description: "Removes every lesson in this course." },
  render: (args) => (
    <Modal {...args} onClose={() => undefined}>
      <Contents />
    </Modal>
  ),
};

/** Focus lands on the first focusable control in the dialog — here, the close button. */
export const Focus: Story = {
  render: (args) => (
    <Modal {...args} onClose={() => undefined}>
      <Contents />
    </Modal>
  ),
};

/** `initialFocusRef` overrides that: on a destructive dialog, prefer the non-destructive action. */
export const InitialFocus: Story = {
  render: (args) => {
    const cancelRef = useRef<HTMLButtonElement>(null);
    return (
      <Modal {...args} onClose={() => undefined} initialFocusRef={cancelRef}>
        <Modal.Body>This cannot be undone.</Modal.Body>
        <Modal.Footer>
          <Button ref={cancelRef} variant="tertiary">
            Cancel
          </Button>
          <Button variant="primary">Delete</Button>
        </Modal.Footer>
      </Modal>
    );
  },
};

/** Neither Escape nor an overlay click dismisses; the footer must be used. */
export const NonDismissable: Story = {
  args: { closeOnEsc: false, closeOnOverlayClick: false },
  render: (args) => (
    <Modal {...args} onClose={() => undefined}>
      <Contents />
    </Modal>
  ),
};

/** Open and close it: focus returns to the trigger button every time. */
export const Interactive: Story = {
  args: { open: false },
  render: (args) => {
    const [open, setOpen] = useState(false);
    return (
      <div style={{ padding: "var(--space-24)" }}>
        <Button onClick={() => setOpen(true)}>Delete course</Button>
        <Modal {...args} open={open} onClose={() => setOpen(false)}>
          <Modal.Body>This cannot be undone.</Modal.Body>
          <Modal.Footer>
            <Button variant="tertiary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => setOpen(false)}>
              Delete
            </Button>
          </Modal.Footer>
        </Modal>
      </div>
    );
  },
};

export const DarkTheme: Story = {
  globals: { theme: "dark" },
  render: (args) => (
    <Modal {...args} onClose={() => undefined}>
      <Contents />
    </Modal>
  ),
};
