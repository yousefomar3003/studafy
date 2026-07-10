import { useControllableState } from "../../internal/use-controllable-state";
import { Button } from "../button";
import { Chip } from "../chip";
import { Input } from "../input";

import type { DateRangeValue } from "./filter-bar-params";

export interface FilterBarChip {
  id: string;
  label: string;
}

export interface FilterBarProps {
  searchLabel?: string;
  searchPlaceholder?: string;
  search?: string;
  defaultSearch?: string;
  onSearchChange?: (value: string) => void;

  dateRangeLabel?: string;
  dateRange?: DateRangeValue;
  defaultDateRange?: DateRangeValue;
  onDateRangeChange?: (range: DateRangeValue) => void;

  /** Active, removable filters — e.g. selected facets from elsewhere on the page. FilterBar only
   * renders them; it does not know what a chip represents. */
  chips?: readonly FilterBarChip[];
  onRemoveChip?: (id: string) => void;

  clearAllLabel?: string;
  /** Rendered next to the chips whenever provided. Pass it only when some filter is active. */
  onClearAll?: () => void;
}

const EMPTY_DATE_RANGE: DateRangeValue = {};

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" focusable="false">
      <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * A search + date-range + active-filter-chips toolbar. FilterBar holds UI state only — it does not
 * read or write the URL. Pair it with `serializeFilterBarState` / `parseFilterBarState` in your
 * router to make the filtered view bookmarkable.
 */
export function FilterBar({
  searchLabel = "Search",
  searchPlaceholder,
  search,
  defaultSearch = "",
  onSearchChange,
  dateRangeLabel = "Date range",
  dateRange,
  defaultDateRange = EMPTY_DATE_RANGE,
  onDateRangeChange,
  chips = [],
  onRemoveChip,
  clearAllLabel = "Clear all",
  onClearAll,
}: FilterBarProps) {
  const [resolvedSearch, setSearch] = useControllableState<string>({
    value: search,
    defaultValue: defaultSearch,
    onChange: onSearchChange,
  });
  const [resolvedDateRange, setDateRange] = useControllableState<DateRangeValue>({
    value: dateRange,
    defaultValue: defaultDateRange,
    onChange: onDateRangeChange,
  });

  return (
    <div className="sf-filter-bar" role="search">
      <Input
        label={searchLabel}
        type="search"
        placeholder={searchPlaceholder}
        value={resolvedSearch}
        onChange={(event) => setSearch(event.target.value)}
        prefix={<SearchIcon />}
      />

      <fieldset className="sf-filter-bar__date-range">
        <legend className="sf-field__label">{dateRangeLabel}</legend>
        <div className="sf-filter-bar__date-inputs">
          <Input
            label="From"
            type="date"
            value={resolvedDateRange.from ?? ""}
            max={resolvedDateRange.to || undefined}
            onChange={(event) =>
              setDateRange({ ...resolvedDateRange, from: event.target.value || undefined })
            }
          />
          <Input
            label="To"
            type="date"
            value={resolvedDateRange.to ?? ""}
            min={resolvedDateRange.from || undefined}
            onChange={(event) =>
              setDateRange({ ...resolvedDateRange, to: event.target.value || undefined })
            }
          />
        </div>
      </fieldset>

      {chips.length > 0 || onClearAll ? (
        <div className="sf-filter-bar__chips">
          {chips.map((chip) => (
            <Chip key={chip.id} onRemove={onRemoveChip ? () => onRemoveChip(chip.id) : undefined}>
              {chip.label}
            </Chip>
          ))}
          {onClearAll ? (
            <Button variant="tertiary" onClick={onClearAll}>
              {clearAllLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
