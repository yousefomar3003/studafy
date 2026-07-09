import { useState } from "react";

import { Select } from "./select";

import type { SelectOption } from "./select";
import type { Meta, StoryObj } from "@storybook/react-vite";

const options: SelectOption[] = [
  { value: "easy", label: "Easy" },
  { value: "medium", label: "Medium" },
  { value: "hard", label: "Hard" },
];

const meta: Meta<typeof Select> = {
  title: "Components/Select",
  component: Select,
  tags: ["autodocs"],
  args: { label: "Difficulty", options },
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "A custom ARIA 1.2 listbox, not a native `<select>`. Focus stays on the trigger and the " +
          "active option is tracked with `aria-activedescendant`. Open with Enter, Space or the " +
          "arrow keys; move with arrows, Home and End; type to jump; Escape closes and restores " +
          "focus; Tab closes without selecting.\n\n" +
          "The popup is absolutely positioned, so it will be clipped by an ancestor with " +
          "`overflow: hidden`.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Select>;

export const Default: Story = {};

export const WithPlaceholder: Story = { args: { placeholder: "Pick a difficulty" } };

export const WithSelection: Story = { args: { defaultValue: "medium" } };

export const WithHelperText: Story = { args: { helperText: "You can change this later." } };

export const Error: Story = { args: { error: "Choose a difficulty to continue.", required: true } };

export const Disabled: Story = { args: { disabled: true, defaultValue: "easy" } };

export const DisabledOption: Story = {
  args: {
    options: [
      { value: "easy", label: "Easy" },
      { value: "medium", label: "Medium", disabled: true },
      { value: "hard", label: "Hard" },
    ],
  },
};

export const Focus: Story = {
  play: ({ canvasElement }) => {
    canvasElement.querySelector("button")?.focus();
  },
};

export const Open: Story = {
  play: ({ canvasElement }) => {
    canvasElement.querySelector("button")?.click();
  },
};

/** The Select owns its value. Add `name` to submit it in a plain HTML form. */
export const Uncontrolled: Story = { args: { defaultValue: "easy", name: "difficulty" } };

export const Controlled: Story = {
  render: (args) => {
    const [value, setValue] = useState("easy");
    return (
      <>
        <Select {...args} value={value} onChange={setValue} />
        <p style={{ color: "var(--color-muted-foreground)" }}>Selected: {value}</p>
      </>
    );
  },
};

/** Open it, then try the arrow keys, Home, End, typing "h", and Escape. */
export const Interactive: Story = { args: { helperText: "Try the keyboard." } };

export const DarkTheme: Story = { globals: { theme: "dark" }, args: { defaultValue: "hard" } };
