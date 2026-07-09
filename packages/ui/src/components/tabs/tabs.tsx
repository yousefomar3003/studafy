import { forwardRef, useId, useRef } from "react";

import { cx } from "../../internal/cx";
import { mergeRefs } from "../../internal/merge-refs";
import { firstEnabledIndex, lastEnabledIndex, nextEnabledIndex } from "../../internal/roving";
import { useControllableState } from "../../internal/use-controllable-state";

import { panelId, tabId, TabsProvider, useTabs } from "./tabs-context";

import type { HTMLAttributes, KeyboardEvent, ReactNode } from "react";

export type TabsOrientation = "horizontal" | "vertical";

export interface TabsProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "onChange"> {
  value?: string;
  defaultValue: string;
  onChange?: (value: string) => void;
  orientation?: TabsOrientation;
  children: ReactNode;
}

const TabsRoot = forwardRef<HTMLDivElement, TabsProps>(function Tabs(
  { value, defaultValue, onChange, orientation = "horizontal", children, ...rest },
  ref,
) {
  const baseId = useId();
  const [selected, select] = useControllableState({ value, defaultValue, onChange });

  return (
    <TabsProvider value={{ baseId, value: selected, select, orientation }}>
      <div {...rest} ref={ref} className={cx("sf-tabs", `sf-tabs--${orientation}`)}>
        {children}
      </div>
    </TabsProvider>
  );
});

export type TabListProps = Omit<HTMLAttributes<HTMLDivElement>, "className">;

export const TabList = forwardRef<HTMLDivElement, TabListProps>(function TabList(
  { children, ...rest },
  ref,
) {
  const { orientation, select } = useTabs();
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = listRef.current;
    if (!list) {
      return;
    }

    // Read the tabs from the DOM rather than a registry: what is rendered is the source of truth,
    // and a disabled <button> reports its own state.
    const tabs = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const items = tabs.map((tab) => ({ disabled: tab.disabled }));
    const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (current === -1) {
      return;
    }

    const [previousKey, nextKey] =
      orientation === "horizontal" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];

    let target: number | undefined;
    if (event.key === nextKey) {
      target = nextEnabledIndex(items, current, 1);
    } else if (event.key === previousKey) {
      target = nextEnabledIndex(items, current, -1);
    } else if (event.key === "Home") {
      target = firstEnabledIndex(items);
    } else if (event.key === "End") {
      target = lastEnabledIndex(items);
    }

    if (target === undefined) {
      return;
    }
    event.preventDefault();

    // eslint-disable-next-line security/detect-object-injection -- `target` comes from the roving helpers, always a valid index into `tabs`
    const tab = tabs[target];
    tab.focus();
    // Automatic activation: selection follows focus, which is the default for the ARIA tabs pattern.
    select(tab.dataset.value as string);
  };

  return (
    <div
      {...rest}
      ref={mergeRefs(listRef, ref)}
      role="tablist"
      aria-orientation={orientation}
      className="sf-tabs__list"
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
});

export interface TabProps extends Omit<HTMLAttributes<HTMLButtonElement>, "className" | "value"> {
  value: string;
  disabled?: boolean;
  children: ReactNode;
}

export const Tab = forwardRef<HTMLButtonElement, TabProps>(function Tab(
  { value, disabled = false, children, ...rest },
  ref,
) {
  const { baseId, value: selected, select } = useTabs();
  const isSelected = selected === value;

  return (
    <button
      {...rest}
      ref={ref}
      type="button"
      role="tab"
      id={tabId(baseId, value)}
      data-value={value}
      disabled={disabled}
      aria-selected={isSelected}
      aria-controls={panelId(baseId, value)}
      // Roving tabindex: only the selected tab is in the page's tab order.
      tabIndex={isSelected ? 0 : -1}
      className={cx("sf-tabs__tab", isSelected && "sf-tabs__tab--selected")}
      onClick={() => select(value)}
    >
      {children}
    </button>
  );
});

export interface TabPanelProps extends Omit<HTMLAttributes<HTMLDivElement>, "className"> {
  value: string;
  children: ReactNode;
}

export const TabPanel = forwardRef<HTMLDivElement, TabPanelProps>(function TabPanel(
  { value, children, ...rest },
  ref,
) {
  const { baseId, value: selected } = useTabs();
  const isSelected = selected === value;

  return (
    <div
      {...rest}
      ref={ref}
      role="tabpanel"
      id={panelId(baseId, value)}
      aria-labelledby={tabId(baseId, value)}
      // Always rendered, hidden when inactive: a tab's aria-controls must point at a real element.
      hidden={!isSelected}
      // The panel is the next tab stop after the tablist, so its content is reachable.
      tabIndex={isSelected ? 0 : undefined}
      className="sf-tabs__panel"
    >
      {isSelected ? children : null}
    </div>
  );
});

export const Tabs = Object.assign(TabsRoot, {
  List: TabList,
  Tab,
  Panel: TabPanel,
});
