import { useState } from "react";

import { Tabs } from "./tabs";

import type { Meta, StoryObj } from "@storybook/react-vite";

const meta: Meta<typeof Tabs> = {
  title: "Components/Tabs",
  component: Tabs,
  tags: ["autodocs"],
  args: { defaultValue: "lessons" },
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Selection follows focus (automatic activation). Arrow keys move between tabs, Home and " +
          "End jump to the ends, and disabled tabs are skipped. Only the selected tab is in the " +
          "page tab order; the panel is the next tab stop.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Tabs>;

const sections = (
  <>
    <Tabs.List aria-label="Course sections">
      <Tabs.Tab value="lessons">Lessons</Tabs.Tab>
      <Tabs.Tab value="quizzes">Quizzes</Tabs.Tab>
      <Tabs.Tab value="grades">Grades</Tabs.Tab>
    </Tabs.List>
    <Tabs.Panel value="lessons">Twelve lessons, four completed.</Tabs.Panel>
    <Tabs.Panel value="quizzes">Three quizzes are due this week.</Tabs.Panel>
    <Tabs.Panel value="grades">Your current average is 87%.</Tabs.Panel>
  </>
);

export const Default: Story = { render: (args) => <Tabs {...args}>{sections}</Tabs> };

export const Vertical: Story = {
  args: { orientation: "vertical" },
  render: (args) => <Tabs {...args}>{sections}</Tabs>,
};

export const DisabledTab: Story = {
  render: (args) => (
    <Tabs {...args}>
      <Tabs.List aria-label="Course sections">
        <Tabs.Tab value="lessons">Lessons</Tabs.Tab>
        <Tabs.Tab value="quizzes" disabled>
          Quizzes
        </Tabs.Tab>
        <Tabs.Tab value="grades">Grades</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="lessons">Arrow past this tab — Quizzes is skipped.</Tabs.Panel>
      <Tabs.Panel value="quizzes">Unreachable.</Tabs.Panel>
      <Tabs.Panel value="grades">Your current average is 87%.</Tabs.Panel>
    </Tabs>
  ),
};

export const Focus: Story = {
  render: (args) => <Tabs {...args}>{sections}</Tabs>,
  play: ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>('[role="tab"]')?.focus();
  },
};

/** The Tabs component owns the selection. */
export const Uncontrolled: Story = { render: (args) => <Tabs {...args}>{sections}</Tabs> };

/** The parent owns the selection and can drive it from outside. */
export const Controlled: Story = {
  render: () => {
    const [value, setValue] = useState("lessons");
    return (
      <>
        <button type="button" onClick={() => setValue("grades")}>
          Jump to Grades
        </button>
        <Tabs defaultValue="lessons" value={value} onChange={setValue}>
          {sections}
        </Tabs>
      </>
    );
  },
};

/** Focus a tab, then try Arrow keys, Home and End. */
export const Interactive: Story = { render: (args) => <Tabs {...args}>{sections}</Tabs> };

export const DarkTheme: Story = {
  globals: { theme: "dark" },
  render: (args) => <Tabs {...args}>{sections}</Tabs>,
};
