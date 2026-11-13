import { useState } from "react";

import { Input } from "./input";

import type { Meta, StoryObj } from "@storybook/react-vite";

const meta: Meta<typeof Input> = {
  title: "Components/Input",
  component: Input,
  tags: ["autodocs"],
  args: { label: "Email", placeholder: "you@studafy.com" },
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof Input>;

export const Default: Story = {};

export const WithHelperText: Story = {
  args: { helperText: "We only use this to send you assignment reminders." },
};

export const Required: Story = { args: { required: true } };

export const Error: Story = {
  args: { error: "Enter a valid email address.", defaultValue: "not-an-email" },
};

export const Disabled: Story = { args: { disabled: true, defaultValue: "you@studafy.com" } };

export const Focus: Story = {
  play: ({ canvasElement }) => {
    canvasElement.querySelector("input")?.focus();
  },
};

export const WithPrefixAndSuffix: Story = {
  args: { label: "Amount", placeholder: "0.00", prefix: "$", suffix: "USD" },
};

/** The value lives in the parent; the Input only reports changes. */
export const Controlled: Story = {
  render: (args) => {
    const [value, setValue] = useState("");
    return (
      <>
        <Input {...args} value={value} onChange={(event) => setValue(event.target.value)} />
        <p style={{ color: "var(--color-muted-foreground)" }}>Value: {value || "(empty)"}</p>
      </>
    );
  },
};

/** The Input owns the value. Useful inside plain HTML forms. */
export const Uncontrolled: Story = { args: { defaultValue: "you@studafy.com" } };

export const DarkTheme: Story = {
  globals: { theme: "dark" },
  args: { helperText: "Rendered against the dark surface tokens." },
};
