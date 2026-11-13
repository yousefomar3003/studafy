import { createContext, useContext } from "react";

export interface TabsContextValue {
  baseId: string;
  value: string;
  select: (value: string) => void;
  orientation: "horizontal" | "vertical";
}

const TabsContext = createContext<TabsContextValue | null>(null);

export const TabsProvider = TabsContext.Provider;

export function useTabs(): TabsContextValue {
  const context = useContext(TabsContext);
  if (!context) {
    throw new Error("Tabs.List, Tabs.Tab and Tabs.Panel must be rendered inside <Tabs>.");
  }
  return context;
}

/** Ids are derived, not registered, so a Tab and its Panel always agree without a lookup table. */
export const tabId = (baseId: string, value: string) => `${baseId}-tab-${value}`;
export const panelId = (baseId: string, value: string) => `${baseId}-panel-${value}`;
