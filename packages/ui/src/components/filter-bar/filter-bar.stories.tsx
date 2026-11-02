import { useState } from "react";

import { FilterBar } from "./filter-bar";
import { parseFilterBarState, serializeFilterBarState } from "./filter-bar-params";

import type { FilterBarChip } from "./filter-bar";
import type { DateRangeValue } from "./filter-bar-params";
import type { Meta, StoryObj } from "@storybook/react-vite";

const meta: Meta<typeof FilterBar> = {
  title: "Components/FilterBar",
  component: FilterBar,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Search, date range, and removable filter chips. FilterBar holds UI state only — pair it " +
          "with `serializeFilterBarState` / `parseFilterBarState` to sync it to the URL, as the " +
          "interactive story below does.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof FilterBar>;

export const Default: Story = {
  render: () => <FilterBar />,
};

export const WithChips: Story = {
  render: () => {
    const [chips, setChips] = useState<FilterBarChip[]>([
      { id: "active", label: "Status: Active" },
      { id: "overdue", label: "Overdue" },
    ]);

    return (
      <FilterBar
        chips={chips}
        onRemoveChip={(id) => setChips((current) => current.filter((chip) => chip.id !== id))}
        onClearAll={() => setChips([])}
      />
    );
  },
};

/** Everything wired to `useState`, so you can see the values change as you interact. */
export const Interactive: Story = {
  render: () => {
    const [search, setSearch] = useState("");
    const [dateRange, setDateRange] = useState<DateRangeValue>({});
    const [chips, setChips] = useState<FilterBarChip[]>([
      { id: "active", label: "Status: Active" },
    ]);

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <FilterBar
          search={search}
          onSearchChange={setSearch}
          dateRange={dateRange}
          onDateRangeChange={setDateRange}
          chips={chips}
          onRemoveChip={(id) => setChips((current) => current.filter((chip) => chip.id !== id))}
          onClearAll={
            chips.length > 0 || search || dateRange.from || dateRange.to
              ? () => {
                  setSearch("");
                  setDateRange({});
                  setChips([]);
                }
              : undefined
          }
        />
        <pre style={{ fontSize: 12 }}>
          {JSON.stringify({ search, dateRange, chipIds: chips.map((c) => c.id) }, null, 2)}
        </pre>
      </div>
    );
  },
};

/** The state above serialized to a query string, and parsed back — what a page's router would do. */
export const UrlSerialization: Story = {
  render: () => {
    const state = {
      search: "algebra",
      dateRange: { from: "2026-01-01", to: "2026-01-31" },
      chipIds: ["active", "overdue"],
    };
    const params = serializeFilterBarState(state);

    return (
      <pre style={{ fontSize: 12 }}>
        {`?${params.toString()}\n\n${JSON.stringify(parseFilterBarState(params), null, 2)}`}
      </pre>
    );
  },
};

export const DarkTheme: Story = { ...WithChips, globals: { theme: "dark" } };
