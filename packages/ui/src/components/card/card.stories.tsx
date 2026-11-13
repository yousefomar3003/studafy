import { Button } from "../button/button";

import { Card } from "./card";

import type { Meta, StoryObj } from "@storybook/react-vite";

const meta: Meta<typeof Card> = {
  title: "Components/Card",
  component: Card,
  tags: ["autodocs"],
  argTypes: { elevation: { control: "inline-radio", options: [0, 1, 2, 3, 4] } },
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "An interactive card is still a plain container. Put one control inside and give it " +
          "`sf-card__action`: its ::after covers the card, so the whole surface is clickable with " +
          "a single tab stop. Making the card itself a button would swallow every control inside " +
          "it and break screen-reader output.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Card>;

const Content = () => (
  <>
    <Card.Header>
      <h3 style={{ margin: 0, fontSize: "var(--font-size-lg)" }}>Algebra I</h3>
    </Card.Header>
    <Card.Body>Twelve lessons covering linear equations, factoring and inequalities.</Card.Body>
    <Card.Footer>
      <Button variant="tertiary">Details</Button>
      <Button>Start</Button>
    </Card.Footer>
  </>
);

export const Default: Story = {
  render: (args) => (
    <Card {...args} style={{ maxWidth: 360 }}>
      <Content />
    </Card>
  ),
};

export const Static: Story = { ...Default };

/** Tonal elevation, driven entirely by the elevation tokens. */
export const Elevations: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--space-24)", flexWrap: "wrap" }}>
      {([0, 1, 2, 3, 4] as const).map((elevation) => (
        <Card key={elevation} elevation={elevation} style={{ width: 160 }}>
          <Card.Body>Elevation {elevation}</Card.Body>
        </Card>
      ))}
    </div>
  ),
};

/** Hover or tab to the card: the whole surface responds, but there is only one tab stop. */
export const Interactive: Story = {
  render: () => (
    <Card interactive style={{ maxWidth: 360 }}>
      <Card.Header>
        <h3 style={{ margin: 0, fontSize: "var(--font-size-lg)" }}>
          <a className="sf-card__action" href="#algebra">
            Algebra I
          </a>
        </h3>
      </Card.Header>
      <Card.Body>Twelve lessons covering linear equations, factoring and inequalities.</Card.Body>
    </Card>
  ),
};

export const Focus: Story = {
  ...Interactive,
  play: ({ canvasElement }) => {
    canvasElement.querySelector("a")?.focus();
  },
};

export const DarkTheme: Story = {
  globals: { theme: "dark" },
  render: (args) => (
    <Card {...args} style={{ maxWidth: 360 }}>
      <Content />
    </Card>
  ),
};
