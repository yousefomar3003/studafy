import { Table } from "./table";

import type { Meta, StoryObj } from "@storybook/react-vite";

const meta: Meta<typeof Table> = {
  title: "Components/Table",
  component: Table,
  tags: ["autodocs"],
  args: { caption: "Quiz results" },
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Real `<table>` semantics with scoped headers. The scroll container is a labelled, " +
          "focusable region so a keyboard user can scroll a wide table without a pointer.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Table>;

const rows = [
  { id: 1, topic: "Algebra", attempts: 2, score: "92%" },
  { id: 2, topic: "Geometry", attempts: 1, score: "78%" },
  { id: 3, topic: "Calculus", attempts: 3, score: "85%" },
];

const header = (
  <Table.Header>
    <Table.Row>
      <Table.HeaderCell>Topic</Table.HeaderCell>
      <Table.HeaderCell>Attempts</Table.HeaderCell>
      <Table.HeaderCell>Score</Table.HeaderCell>
    </Table.Row>
  </Table.Header>
);

export const Default: Story = {
  render: (args) => (
    <Table {...args}>
      {header}
      <Table.Body columnCount={3}>
        {rows.map((row) => (
          <Table.Row key={row.id}>
            <Table.Cell>{row.topic}</Table.Cell>
            <Table.Cell>{row.attempts}</Table.Cell>
            <Table.Cell>{row.score}</Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  ),
};

export const WithFooter: Story = {
  render: (args) => (
    <Table {...args}>
      {header}
      <Table.Body columnCount={3}>
        {rows.map((row) => (
          <Table.Row key={row.id}>
            <Table.Cell>{row.topic}</Table.Cell>
            <Table.Cell>{row.attempts}</Table.Cell>
            <Table.Cell>{row.score}</Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
      <Table.Footer>
        <Table.Row>
          <Table.HeaderCell scope="row">Average</Table.HeaderCell>
          <Table.Cell>2</Table.Cell>
          <Table.Cell>85%</Table.Cell>
        </Table.Row>
      </Table.Footer>
    </Table>
  ),
};

export const Loading: Story = {
  render: (args) => (
    <Table {...args}>
      {header}
      <Table.Body columnCount={3} loading>
        {null}
      </Table.Body>
    </Table>
  ),
};

export const Empty: Story = {
  render: (args) => (
    <Table {...args}>
      {header}
      <Table.Body columnCount={3} empty="You have not taken any quizzes yet.">
        {[]}
      </Table.Body>
    </Table>
  ),
};

/** Narrow the viewport: the container scrolls and can be focused with the keyboard. */
export const Responsive: Story = {
  render: (args) => (
    <div style={{ maxWidth: 320 }}>
      <Table {...args}>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>Topic</Table.HeaderCell>
            <Table.HeaderCell>Attempts</Table.HeaderCell>
            <Table.HeaderCell>Score</Table.HeaderCell>
            <Table.HeaderCell>Last attempt</Table.HeaderCell>
            <Table.HeaderCell>Instructor</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body columnCount={5}>
          {rows.map((row) => (
            <Table.Row key={row.id}>
              <Table.Cell>{row.topic}</Table.Cell>
              <Table.Cell>{row.attempts}</Table.Cell>
              <Table.Cell>{row.score}</Table.Cell>
              <Table.Cell>12 May 2026</Table.Cell>
              <Table.Cell>Dr. Hassan</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  ),
};

export const HiddenCaption: Story = { ...Default, args: { hideCaption: true } };

export const DarkTheme: Story = { ...Default, globals: { theme: "dark" } };
