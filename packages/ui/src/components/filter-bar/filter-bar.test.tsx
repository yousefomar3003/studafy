import { fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, mock, test } from "bun:test";
import { useState } from "react";

import { expectNoA11yViolations } from "../../internal/test/axe";

import { FilterBar } from "./filter-bar";

import type { FilterBarChip } from "./filter-bar";
import type { DateRangeValue } from "./filter-bar-params";

describe("FilterBar", () => {
  test("renders a labelled search field", () => {
    render(<FilterBar />);

    expect(screen.getByLabelText("Search")).toBeInstanceOf(HTMLInputElement);
  });

  test("search works uncontrolled via defaultSearch", () => {
    render(<FilterBar defaultSearch="algebra" />);
    const input = screen.getByLabelText("Search") as HTMLInputElement;
    expect(input.value).toBe("algebra");

    fireEvent.change(input, { target: { value: "geometry" } });

    expect(input.value).toBe("geometry");
  });

  test("search works controlled: value only changes when the owner updates it", () => {
    const onSearchChange = mock();
    function Controlled() {
      const [value, setValue] = useState("start");
      return (
        <FilterBar
          search={value}
          onSearchChange={(next) => {
            onSearchChange(next);
            setValue(next);
          }}
        />
      );
    }
    render(<Controlled />);
    const input = screen.getByLabelText("Search") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "next" } });

    expect(onSearchChange).toHaveBeenCalledWith("next");
    expect(input.value).toBe("next");
  });

  test("groups the date range under a legend naming it", () => {
    render(<FilterBar dateRangeLabel="Enrolled between" />);

    expect(screen.getByRole("group", { name: "Enrolled between" })).toBeDefined();
    expect(screen.getByLabelText("From")).toBeInstanceOf(HTMLInputElement);
    expect(screen.getByLabelText("To")).toBeInstanceOf(HTMLInputElement);
  });

  test("changing the from date reports the whole range, keeping to intact", () => {
    const onDateRangeChange = mock();
    render(<FilterBar dateRange={{ to: "2026-01-31" }} onDateRangeChange={onDateRangeChange} />);

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-01-01" } });

    expect(onDateRangeChange).toHaveBeenCalledWith({ to: "2026-01-31", from: "2026-01-01" });
  });

  test("the from field's max is bounded by the current to value", () => {
    render(<FilterBar dateRange={{ to: "2026-01-31" }} />);

    expect(screen.getByLabelText("From").getAttribute("max")).toBe("2026-01-31");
  });

  test("the to field's min is bounded by the current from value", () => {
    render(<FilterBar dateRange={{ from: "2026-01-01" }} />);

    expect(screen.getByLabelText("To").getAttribute("min")).toBe("2026-01-01");
  });

  test("renders no chip row when there are no chips and no onClearAll", () => {
    const { container } = render(<FilterBar />);

    expect(container.querySelector(".sf-filter-bar__chips")).toBeNull();
  });

  test("renders each chip's label and wires its remove button", () => {
    const chips: FilterBarChip[] = [
      { id: "active", label: "Status: Active" },
      { id: "overdue", label: "Overdue" },
    ];
    const onRemoveChip = mock();
    render(<FilterBar chips={chips} onRemoveChip={onRemoveChip} />);

    expect(screen.getByText("Status: Active")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Remove Overdue" }));

    expect(onRemoveChip).toHaveBeenCalledWith("overdue");
  });

  test("renders Clear all whenever onClearAll is provided, even with no chips", () => {
    const onClearAll = mock();
    render(<FilterBar onClearAll={onClearAll} clearAllLabel="Reset filters" />);

    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));

    expect(onClearAll).toHaveBeenCalledTimes(1);
  });

  test("has no accessibility violations", async () => {
    const chips: FilterBarChip[] = [{ id: "active", label: "Status: Active" }];
    const { container } = render(
      <FilterBar
        chips={chips}
        onRemoveChip={() => undefined}
        onClearAll={() => undefined}
        dateRange={{ from: "2026-01-01", to: "2026-01-31" } as DateRangeValue}
      />,
    );

    await expectNoA11yViolations(container);
  });
});
