import { Button } from "../button";

import { ToastProvider, useToast } from "./toast";

import type { ToastVariant } from "./toast";
import type { Meta, StoryObj } from "@storybook/react-vite";

const meta: Meta<typeof ToastProvider> = {
  title: "Components/Toast",
  component: ToastProvider,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "Mount `<ToastProvider>` once at the application root and fire toasts imperatively with " +
          '`useToast()`. Errors and warnings are announced assertively (`role="alert"`); ' +
          'successes and info wait for a pause in speech (`role="status"`).',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ToastProvider>;

interface Sample {
  variant: ToastVariant;
  title: string;
  description: string;
}

const SAMPLES: Sample[] = [
  { variant: "success", title: "Course published", description: "Students can now enrol." },
  { variant: "error", title: "Upload failed", description: "The file exceeded the 20 MB limit." },
  {
    variant: "warning",
    title: "Unsaved changes",
    description: "Leaving now will discard your edits.",
  },
  {
    variant: "info",
    title: "Term starts Monday",
    description: "Your timetable is ready to review.",
  },
];

function Trigger({ sample, duration }: { sample: Sample; duration?: number }) {
  const { show } = useToast();
  return (
    <Button variant="secondary" onClick={() => show({ ...sample, duration })}>
      Show {sample.variant}
    </Button>
  );
}

function TriggerRow({ duration }: { duration?: number }) {
  return (
    <div style={{ display: "flex", gap: "var(--space-8)", flexWrap: "wrap" }}>
      {SAMPLES.map((sample) => (
        <Trigger key={sample.variant} sample={sample} duration={duration} />
      ))}
    </div>
  );
}

/** Each variant, auto-dismissing after the provider's default five seconds. */
export const Default: Story = {
  render: () => (
    <ToastProvider>
      <TriggerRow />
    </ToastProvider>
  ),
};

/** A short duration, so the auto-dismiss timer is easy to observe. */
export const AutoDismiss: Story = {
  render: () => (
    <ToastProvider duration={2000}>
      <TriggerRow />
    </ToastProvider>
  ),
};

/** `duration: 0` disables the timer — the toast stays until its dismiss button is pressed. */
export const ManualDismiss: Story = {
  render: () => (
    <ToastProvider>
      <TriggerRow duration={0} />
    </ToastProvider>
  ),
};

/** Toasts stack in the order they were shown. Fire several before the first expires. */
export const Interactive: Story = {
  render: () => (
    <ToastProvider duration={6000}>
      <TriggerRow />
    </ToastProvider>
  ),
};

export const Focus: Story = {
  render: () => (
    <ToastProvider>
      <TriggerRow duration={0} />
    </ToastProvider>
  ),
  play: async ({ canvasElement }) => {
    canvasElement.querySelector("button")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.querySelector<HTMLButtonElement>(".sf-toast__dismiss")?.focus();
  },
};

export const DarkTheme: Story = {
  globals: { theme: "dark" },
  render: () => (
    <ToastProvider>
      <TriggerRow duration={0} />
    </ToastProvider>
  ),
};
