import { contrastRatio } from "./internal/contrast";
import { color, elevation, font, radius, space, textContrastPairs } from "./theme";

import type { Meta, StoryObj } from "@storybook/react-vite";
import type { CSSProperties } from "react";

const sectionStyle: CSSProperties = {
  marginBottom: "3rem",
};

const sectionTitleStyle: CSSProperties = {
  fontFamily: "var(--font-family-sans)",
  fontSize: "var(--font-size-xl)",
  fontWeight: "var(--font-weight-semibold)",
  marginBottom: "1rem",
  color: "var(--color-foreground)",
};

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
  gap: "1rem",
};

function ContrastPairCard({ pair }: { pair: (typeof textContrastPairs)[number] }) {
  const ratio = contrastRatio(pair.fg, pair.bg);
  const passes = ratio >= pair.minRatio;

  return (
    <div style={{ border: "1px solid #d0d0d0", borderRadius: "8px", overflow: "hidden" }}>
      <div
        style={{
          background: pair.bg,
          color: pair.fg,
          padding: "1rem",
          fontFamily: "var(--font-family-sans)",
          fontWeight: 600,
        }}
      >
        Ag — {pair.name}
      </div>
      <div style={{ padding: "0.5rem 1rem", fontSize: "0.8rem", fontFamily: "monospace" }}>
        {ratio.toFixed(2)}:1 (needs {pair.minRatio}:1) — {passes ? "PASS" : "FAIL"}
      </div>
    </div>
  );
}

function ColorScaleRow({ name, scale }: { name: string; scale: Record<string, string> }) {
  return (
    <div style={{ marginBottom: "0.75rem" }}>
      <div
        style={{
          fontFamily: "var(--font-family-sans)",
          fontSize: "var(--font-size-sm)",
          color: "var(--color-muted-foreground)",
          marginBottom: "0.25rem",
        }}
      >
        {name}
      </div>
      <div style={{ display: "flex" }}>
        {Object.entries(scale).map(([step, hex]) => (
          <div
            key={step}
            title={`${name}-${step}: ${hex}`}
            style={{
              background: hex,
              width: "48px",
              height: "48px",
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "center",
              fontSize: "9px",
              fontFamily: "monospace",
              color: Number(step) >= 500 ? "#fff" : "#000",
              paddingBottom: "2px",
            }}
          >
            {step}
          </div>
        ))}
      </div>
    </div>
  );
}

function DesignTokensReference() {
  return (
    <div
      style={{
        background: "var(--color-background)",
        color: "var(--color-foreground)",
        padding: "2rem",
        minHeight: "100vh",
        fontFamily: "var(--font-family-sans)",
      }}
    >
      <p style={{ color: "var(--color-muted-foreground)", marginBottom: "2rem" }}>
        Use the toolbar&apos;s theme switcher above to compare light and dark. Every value below is
        read live from tokens.css / theme.ts — nothing here is hand-copied.
      </p>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>Semantic color — WCAG AA text pairs</h2>
        <div style={gridStyle}>
          {textContrastPairs
            .filter((pair) => pair.name.startsWith("light:"))
            .map((pair) => (
              <ContrastPairCard key={pair.name} pair={pair} />
            ))}
        </div>
        <h3 style={{ ...sectionTitleStyle, fontSize: "var(--font-size-lg)", marginTop: "1.5rem" }}>
          Dark scheme
        </h3>
        <div style={gridStyle}>
          {textContrastPairs
            .filter((pair) => pair.name.startsWith("dark:"))
            .map((pair) => (
              <ContrastPairCard key={pair.name} pair={pair} />
            ))}
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>Color scales</h2>
        <ColorScaleRow name="neutral" scale={color.neutral} />
        <ColorScaleRow name="accent" scale={color.accent} />
        <ColorScaleRow name="success" scale={color.success} />
        <ColorScaleRow name="danger" scale={color.danger} />
        <ColorScaleRow name="warning" scale={color.warning} />
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>Type scale — Inter</h2>
        {Object.entries(font.size).map(([key, size]) => (
          <div
            key={key}
            style={{
              fontSize: size,
              lineHeight: font.lineHeight[key as keyof typeof font.lineHeight],
              fontWeight: font.weight.regular,
              marginBottom: "0.5rem",
            }}
          >
            {key} ({size}) — The quick brown fox jumps over the lazy dog
          </div>
        ))}
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>Spacing — 4px scale</h2>
        {Object.entries(space).map(([key, value]) => (
          <div key={key} style={{ display: "flex", alignItems: "center", marginBottom: "0.25rem" }}>
            <div style={{ width: "80px", fontFamily: "monospace", fontSize: "0.8rem" }}>
              space-{key}
            </div>
            <div style={{ background: "var(--color-accent)", height: "12px", width: value }} />
          </div>
        ))}
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>Radius</h2>
        <div style={{ display: "flex", gap: "1rem" }}>
          {Object.entries(radius).map(([key, value]) => (
            <div key={key} style={{ textAlign: "center" }}>
              <div
                style={{
                  width: "64px",
                  height: "64px",
                  background: "var(--color-accent)",
                  borderRadius: value,
                }}
              />
              <div style={{ fontSize: "0.75rem", fontFamily: "monospace", marginTop: "0.25rem" }}>
                {key}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>Elevation</h2>
        <div style={{ display: "flex", gap: "2rem" }}>
          {Object.keys(elevation.light).map((key) => (
            <div key={key} style={{ textAlign: "center" }}>
              <div
                style={{
                  width: "72px",
                  height: "72px",
                  background: "var(--color-surface)",
                  borderRadius: "8px",
                  boxShadow: `var(--elevation-${key})`,
                }}
              />
              <div style={{ fontSize: "0.75rem", fontFamily: "monospace", marginTop: "0.5rem" }}>
                elevation-{key}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

const meta: Meta<typeof DesignTokensReference> = {
  title: "Foundations/Design Tokens",
  component: DesignTokensReference,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;

type Story = StoryObj<typeof DesignTokensReference>;

export const Overview: Story = {};
