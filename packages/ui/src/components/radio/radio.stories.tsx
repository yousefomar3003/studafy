import { useState } from "react";

import { Radio } from "./radio";
import { RadioGroup } from "./radio-group";

import type { Meta, StoryObj } from "@storybook/react-vite";

const meta: Meta<typeof RadioGroup> = {
  title: "Components/RadioGroup",
  component: RadioGroup,
  subcomponents: { Radio: Radio as never },
  tags: ["autodocs"],
  args: { label: "Difficulty", name: "difficulty" },
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Radios are native inputs sharing one `name`, so arrow-key navigation, wrapping and " +
          "roving focus come from the browser rather than from JavaScript.",
      },
    },
  },
  render: (args) => (
    <RadioGroup {...args}>
      <Radio value="easy" label="Easy" />
      <Radio value="medium" label="Medium" />
      <Radio value="hard" label="Hard" />
    </RadioGroup>
  ),
};

export default meta;
type Story = StoryObj<typeof RadioGroup>;

export const Default: Story = {};

export const WithSelection: Story = { args: { defaultValue: "medium" } };

export const Disabled: Story = { args: { disabled: true, defaultValue: "easy" } };

/** Keyboard navigation skips the disabled option. */
export const DisabledOption: Story = {
  render: (args) => (
    <RadioGroup {...args} defaultValue="easy">
      <Radio value="easy" label="Easy" />
      <Radio value="medium" label="Medium" disabled />
      <Radio value="hard" label="Hard" />
    </RadioGroup>
  ),
};

export const Error: Story = { args: { error: "Choose a difficulty to continue.", required: true } };

export const Focus: Story = {
  play: ({ canvasElement }) => {
    canvasElement.querySelector("input")?.focus();
  },
};

/** Focus a radio, then use Arrow keys — selection follows focus, as the ARIA pattern requires. */
export const Interactive: Story = {
  render: (args) => {
    const [value, setValue] = useState("easy");
    return (
      <>
        <RadioGroup {...args} value={value} onChange={setValue}>
          <Radio value="easy" label="Easy" />
          <Radio value="medium" label="Medium" />
          <Radio value="hard" label="Hard" />
        </RadioGroup>
        <p style={{ color: "var(--color-muted-foreground)" }}>Selected: {value}</p>
      </>
    );
  },
};

export const DarkTheme: Story = {
  globals: { theme: "dark" },
  args: { defaultValue: "medium" },
};
