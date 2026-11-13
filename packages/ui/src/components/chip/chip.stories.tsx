import { useState } from "react";

import { Chip } from "./chip";

import type { Meta, StoryObj } from "@storybook/react-vite";

const meta: Meta<typeof Chip> = {
  title: "Components/Chip",
  component: Chip,
  tags: ["autodocs"],
  args: { children: "Algebra" },
  argTypes: { variant: { control: "inline-radio", options: ["filled", "outlined"] } },
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "The chip body is a non-interactive `<span>`. When removable, the remove button is the " +
          "only focusable element — a clickable chip wrapping a remove button would nest one " +
          "control inside another.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Chip>;

export const Filled: Story = {};

export const Outlined: Story = { args: { variant: "outlined" } };

export const Removable: Story = { args: { onRemove: () => undefined } };

export const Disabled: Story = { args: { disabled: true, onRemove: () => undefined } };

export const Focus: Story = {
  args: { onRemove: () => undefined },
  play: ({ canvasElement }) => {
    canvasElement.querySelector("button")?.focus();
  },
};

/** Remove chips to see the list shrink; the remove button carries the chip's name. */
export const Interactive: Story = {
  render: () => {
    const [topics, setTopics] = useState(["Algebra", "Geometry", "Calculus"]);
    return (
      <div style={{ display: "flex", gap: "var(--space-8)", flexWrap: "wrap" }}>
        {topics.map((topic) => (
          <Chip key={topic} onRemove={() => setTopics(topics.filter((t) => t !== topic))}>
            {topic}
          </Chip>
        ))}
        {topics.length === 0 ? (
          <button type="button" onClick={() => setTopics(["Algebra", "Geometry", "Calculus"])}>
            Reset
          </button>
        ) : null}
      </div>
    );
  },
};

export const DarkTheme: Story = {
  globals: { theme: "dark" },
  render: (args) => (
    <div style={{ display: "flex", gap: "var(--space-8)" }}>
      <Chip {...args} variant="filled">
        Filled
      </Chip>
      <Chip {...args} variant="outlined">
        Outlined
      </Chip>
      <Chip {...args} onRemove={() => undefined}>
        Removable
      </Chip>
    </div>
  ),
};
