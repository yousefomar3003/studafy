import { useState } from "react";

import { Checkbox } from "./checkbox";

import type { Meta, StoryObj } from "@storybook/react-vite";

const meta: Meta<typeof Checkbox> = {
  title: "Components/Checkbox",
  component: Checkbox,
  tags: ["autodocs"],
  args: { label: "Email me assignment reminders" },
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof Checkbox>;

export const Unchecked: Story = {};

export const Checked: Story = { args: { defaultChecked: true } };

export const Indeterminate: Story = { args: { label: "Select all lessons", indeterminate: true } };

export const Disabled: Story = { args: { disabled: true } };

export const DisabledChecked: Story = { args: { disabled: true, defaultChecked: true } };

export const Error: Story = {
  args: { label: "Accept the terms", error: "You must accept the terms to continue." },
};

export const Focus: Story = {
  play: ({ canvasElement }) => {
    canvasElement.querySelector("input")?.focus();
  },
};

/** A parent checkbox whose mixed state is derived from its children. */
export const Interactive: Story = {
  render: () => {
    const [lessons, setLessons] = useState([true, false, false]);
    const checkedCount = lessons.filter(Boolean).length;

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-8)" }}>
        <Checkbox
          label="Select all lessons"
          checked={checkedCount === lessons.length}
          indeterminate={checkedCount > 0 && checkedCount < lessons.length}
          onChange={(event) => setLessons(lessons.map(() => event.target.checked))}
        />
        <div style={{ paddingInlineStart: "var(--space-24)" }}>
          {lessons.map((checked, index) => (
            <Checkbox
              key={index}
              label={`Lesson ${index + 1}`}
              checked={checked}
              onChange={(event) =>
                setLessons(lessons.map((value, i) => (i === index ? event.target.checked : value)))
              }
            />
          ))}
        </div>
      </div>
    );
  },
};

export const DarkTheme: Story = {
  globals: { theme: "dark" },
  args: { defaultChecked: true },
};
