import { Button } from "./button";

import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";

const meta: Meta<typeof Button> = {
  title: "Components/Button",
  component: Button,
  tags: ["autodocs"],
  args: { children: "Save changes" },
  argTypes: {
    variant: { control: "inline-radio", options: ["primary", "secondary", "tertiary"] },
    loading: { control: "boolean" },
    disabled: { control: "boolean" },
    fullWidth: { control: "boolean" },
  },
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "Hover and active states are pure CSS and cannot be forced from a story — use the " +
          "Interactive story and a pointer to see them. Focus is shown by the Focus story, which " +
          "moves focus on play.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Button>;

const Row = ({ children }: { children: ReactNode }) => (
  <div style={{ display: "flex", gap: "var(--space-16)", alignItems: "center" }}>{children}</div>
);

export const Default: Story = {};

export const Variants: Story = {
  render: (args) => (
    <Row>
      <Button {...args} variant="primary">
        Primary
      </Button>
      <Button {...args} variant="secondary">
        Secondary
      </Button>
      <Button {...args} variant="tertiary">
        Tertiary
      </Button>
    </Row>
  ),
};

/** Focus is applied on play, so the focus ring token is visible without touching the keyboard. */
export const Focus: Story = {
  play: ({ canvasElement }) => {
    canvasElement.querySelector("button")?.focus();
  },
};

export const Disabled: Story = {
  args: { disabled: true },
  render: (args) => (
    <Row>
      <Button {...args} variant="primary">
        Primary
      </Button>
      <Button {...args} variant="secondary">
        Secondary
      </Button>
      <Button {...args} variant="tertiary">
        Tertiary
      </Button>
    </Row>
  ),
};

export const Loading: Story = {
  args: { loading: true, children: "Saving" },
  render: (args) => (
    <Row>
      <Button {...args} variant="primary" />
      <Button {...args} variant="secondary" />
      <Button {...args} variant="tertiary" />
    </Row>
  ),
};

export const WithIcons: Story = {
  args: {
    leadingIcon: <ArrowIcon />,
    trailingIcon: <ArrowIcon />,
  },
};

export const FullWidth: Story = {
  args: { fullWidth: true },
  parameters: { layout: "padded" },
};

/** Hover and press this one to exercise the states that cannot be captured statically. */
export const Interactive: Story = {
  args: { variant: "primary" },
};

export const DarkTheme: Story = {
  globals: { theme: "dark" },
  render: (args) => (
    <Row>
      <Button {...args} variant="primary">
        Primary
      </Button>
      <Button {...args} variant="secondary">
        Secondary
      </Button>
      <Button {...args} variant="tertiary">
        Tertiary
      </Button>
    </Row>
  ),
};

function ArrowIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 8h10M9 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
