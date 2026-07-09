import { useCallback, useEffect, useId, useRef, useState } from "react";

import { cx } from "../../internal/cx";
import { firstEnabledIndex, lastEnabledIndex, nextEnabledIndex } from "../../internal/roving";
import { useControllableState } from "../../internal/use-controllable-state";

import type { KeyboardEvent } from "react";

export interface SelectOption<Value extends string = string> {
  value: Value;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<Value extends string = string> {
  label: string;
  options: readonly SelectOption<Value>[];
  value?: Value;
  defaultValue?: Value;
  onChange?: (value: Value) => void;
  placeholder?: string;
  helperText?: string;
  error?: string;
  disabled?: boolean;
  required?: boolean;
  /** Renders a hidden input so the value participates in native form submission. */
  name?: string;
  id?: string;
}

/**
 * An ARIA 1.2 collapsed listbox. Options are a prop rather than children so that this component
 * owns the `listbox` / `option` structure and the keyboard model — arbitrary children would let a
 * caller break `aria-required-children` without noticing.
 *
 * The popup is absolutely positioned inside a relative wrapper. That keeps the package free of a
 * positioning library, at the cost of clipping inside an `overflow: hidden` ancestor.
 */
export function Select<Value extends string = string>({
  label,
  options,
  value,
  defaultValue,
  onChange,
  placeholder = "Select an option",
  helperText,
  error,
  disabled = false,
  required = false,
  name,
  id,
}: SelectProps<Value>) {
  const generatedId = useId();
  const baseId = id ?? generatedId;
  const labelId = `${baseId}-label`;
  const listboxId = `${baseId}-listbox`;
  const helperId = `${baseId}-helper`;
  const errorId = `${baseId}-error`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  const [selected, setSelected] = useControllableState<Value | undefined>({
    value,
    defaultValue,
    onChange: onChange as ((value: Value | undefined) => void) | undefined,
  });
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLUListElement>(null);
  const typeahead = useRef({ query: "", timer: 0 });

  const selectedIndex = options.findIndex((option) => option.value === selected);
  // eslint-disable-next-line security/detect-object-injection -- `selectedIndex` comes from findIndex on `options`, and -1 is handled
  const selectedOption = selectedIndex === -1 ? undefined : options[selectedIndex];

  const describedBy =
    [helperText && helperId, error && errorId].filter(Boolean).join(" ") || undefined;

  const openListbox = useCallback(() => {
    setActiveIndex(selectedIndex === -1 ? firstEnabledIndex(options) : selectedIndex);
    setOpen(true);
  }, [options, selectedIndex]);

  const closeListbox = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const commit = useCallback(
    (index: number) => {
      // eslint-disable-next-line security/detect-object-injection -- `index` originates from the roving helpers or a rendered option, always in bounds
      const option = options[index];
      if (!option || option.disabled) {
        return;
      }
      setSelected(option.value);
      closeListbox();
    },
    [closeListbox, options, setSelected],
  );

  // Keep the active option in view. happy-dom has no layout, hence the optional call.
  useEffect(() => {
    if (!open) {
      return;
    }
    const active = listboxRef.current?.querySelector<HTMLElement>(".sf-select__option--active");
    active?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, open]);

  // Tab and outside clicks commit the active option's absence: they just close the popup.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !listboxRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const moveTo = (index: number) => setActiveIndex(index);

  const onTypeahead = (key: string) => {
    window.clearTimeout(typeahead.current.timer);
    typeahead.current.query += key.toLowerCase();
    typeahead.current.timer = window.setTimeout(() => {
      typeahead.current.query = "";
    }, 500);

    const match = options.findIndex(
      (option) =>
        !option.disabled && option.label.toLowerCase().startsWith(typeahead.current.query),
    );
    if (match !== -1) {
      setActiveIndex(match);
      if (!open) {
        setOpen(true);
      }
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) {
      return;
    }

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (open) {
          moveTo(nextEnabledIndex(options, activeIndex, 1));
        } else {
          openListbox();
        }
        return;
      case "ArrowUp":
        event.preventDefault();
        if (open) {
          moveTo(nextEnabledIndex(options, activeIndex, -1));
        } else {
          openListbox();
        }
        return;
      case "Home":
        if (open) {
          event.preventDefault();
          moveTo(firstEnabledIndex(options));
        }
        return;
      case "End":
        if (open) {
          event.preventDefault();
          moveTo(lastEnabledIndex(options));
        }
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        if (open) {
          commit(activeIndex);
        } else {
          openListbox();
        }
        return;
      case "Escape":
        if (open) {
          event.preventDefault();
          closeListbox();
        }
        return;
      case "Tab":
        // Tab moves on, it does not select. Closing keeps the popup from outliving focus.
        setOpen(false);
        return;
      default:
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          onTypeahead(event.key);
        }
    }
  };

  return (
    <div className={cx("sf-field", disabled && "sf-field--disabled")}>
      <span className="sf-field__label" id={labelId}>
        {label}
        {required ? (
          <span className="sf-field__required" aria-hidden="true">
            *
          </span>
        ) : null}
      </span>

      <div className="sf-select">
        <button
          ref={triggerRef}
          type="button"
          id={baseId}
          role="combobox"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-labelledby={`${labelId} ${baseId}`}
          aria-required={required || undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          aria-activedescendant={open ? optionId(activeIndex) : undefined}
          className={cx("sf-select__trigger", error && "sf-select__trigger--invalid")}
          onClick={() => {
            if (open) {
              setOpen(false);
            } else {
              openListbox();
            }
          }}
          onKeyDown={onKeyDown}
        >
          <span
            className={cx("sf-select__value", !selectedOption && "sf-select__value--placeholder")}
          >
            {selectedOption?.label ?? placeholder}
          </span>
          <span className="sf-select__arrow" aria-hidden="true" />
        </button>

        <ul
          ref={listboxRef}
          id={listboxId}
          role="listbox"
          aria-labelledby={labelId}
          hidden={!open}
          className="sf-select__listbox"
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              id={optionId(index)}
              role="option"
              aria-selected={option.value === selected}
              aria-disabled={option.disabled || undefined}
              className={cx(
                "sf-select__option",
                index === activeIndex && "sf-select__option--active",
                option.disabled && "sf-select__option--disabled",
              )}
              // The trigger keeps focus throughout; options are pointed at by aria-activedescendant.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => !option.disabled && setActiveIndex(index)}
              onClick={() => commit(index)}
            >
              {option.label}
            </li>
          ))}
        </ul>
      </div>

      {name ? <input type="hidden" name={name} value={selected ?? ""} /> : null}

      {helperText ? (
        <p className="sf-field__helper" id={helperId}>
          {helperText}
        </p>
      ) : null}
      {error ? (
        <p className="sf-field__error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
