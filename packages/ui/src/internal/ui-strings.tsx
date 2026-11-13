import { createContext, useContext, useMemo } from "react";

import type { ReactNode } from "react";

/**
 * Every built-in string the components render themselves (screen-reader labels, placeholders,
 * empty/loading states). The kit has no i18n dependency: an app supplies translations through
 * {@link UiStringsProvider}, and anything it leaves out keeps the English default below.
 */
export interface UiStrings {
  closeDialog: string;
  dismissToast: (title: string) => string;
  removeChip: (label: string) => string;
  removeItem: string;
  selectRow: (label: string) => string;
  selectRowFallback: string;
  selectAllRows: string;
  selectPlaceholder: string;
  tableLoading: string;
  tableEmpty: string;
  filterSearch: string;
  filterDateRange: string;
  filterDateFrom: string;
  filterDateTo: string;
  filterClearAll: string;
}

export const DEFAULT_UI_STRINGS: UiStrings = {
  closeDialog: "Close dialog",
  dismissToast: (title) => `Dismiss ${title}`,
  removeChip: (label) => `Remove ${label}`,
  removeItem: "Remove item",
  selectRow: (label) => `Select ${label}`,
  selectRowFallback: "Select row",
  selectAllRows: "Select all rows",
  selectPlaceholder: "Select an option",
  tableLoading: "Loading",
  tableEmpty: "No results.",
  filterSearch: "Search",
  filterDateRange: "Date range",
  filterDateFrom: "From",
  filterDateTo: "To",
  filterClearAll: "Clear all",
};

const UiStringsContext = createContext<UiStrings>(DEFAULT_UI_STRINGS);

export interface UiStringsProviderProps {
  /** Overrides for the defaults; typically rebuilt whenever the app's active language changes. */
  strings: Partial<UiStrings>;
  children?: ReactNode;
}

export function UiStringsProvider({ strings, children }: UiStringsProviderProps) {
  const value = useMemo(() => ({ ...DEFAULT_UI_STRINGS, ...strings }), [strings]);
  return <UiStringsContext.Provider value={value}>{children}</UiStringsContext.Provider>;
}

export function useUiStrings(): UiStrings {
  return useContext(UiStringsContext);
}
