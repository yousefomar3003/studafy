import { Button } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";

import { api } from "../../../lib/api";
import { useTranslation } from "../../../lib/i18n";

import "./finance-student-picker.css";

import type { components } from "@studafy/api-client";
import type { KeyboardEvent } from "react";

export type StudentIdentity = components["schemas"]["FinanceStudentList"]["students"][number];

const SEARCH_DEBOUNCE_MS = 250;
const LIST_LIMIT = 100;

async function listFinanceStudents(search: string): Promise<StudentIdentity[]> {
  const { data } = await api.GET("/api/finance/students", {
    params: { query: { search, limit: LIST_LIMIT } },
  });
  return (data?.students ?? []) as StudentIdentity[];
}

export interface FinanceStudentPickerProps {
  label: string;
  helperText?: string;
  error?: string;
  required?: boolean;
  /** Pick several (each shown as a removable chip) rather than exactly one. */
  multiple?: boolean;
  selected: readonly StudentIdentity[];
  onChange: (selected: StudentIdentity[]) => void;
}

/**
 * Student field for every finance screen: open it to pick from the list of the school's students,
 * or type part of a name to narrow the list. Names only. It reads `GET /api/finance/students`,
 * which needs just `billing:read` — unlike `/api/students`, which needs `student:read` and so never
 * worked for a FINANCE-only user.
 */
export function FinanceStudentPicker({
  label,
  helperText,
  error,
  required,
  multiple = false,
  selected,
  onChange,
}: FinanceStudentPickerProps) {
  const { t } = useTranslation();
  const inputId = useId();
  const listId = `${inputId}-list`;
  const hintId = `${inputId}-hint`;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [search]);

  const single = !multiple ? (selected[0] ?? null) : null;
  const students = useQuery({
    queryKey: ["finance", "students", "list", debounced],
    queryFn: () => listFinanceStudents(debounced),
    enabled: open && single === null,
  });
  const chosenIds = new Set(selected.map((s) => s.id));
  const options = (students.data ?? []).filter((s) => !chosenIds.has(s.id));

  function pick(student: StudentIdentity) {
    onChange(multiple ? [...selected, student] : [student]);
    setSearch("");
    setDebounced("");
    if (!multiple) setOpen(false);
  }

  // Any press outside the field closes the list — however it was opened (typing, the input, or
  // the arrow, which never focuses the input and so would leave no blur to close on).
  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, [open]);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape" && open) {
      // Close just the list, not a dialog the field sits in.
      event.stopPropagation();
      setOpen(false);
    }
    if (event.key === "Tab") setOpen(false);
    if (event.key === "ArrowDown") setOpen(true);
  }

  if (single) {
    return (
      <div className="finance-student-picker__selected">
        <div>
          <span className="sf-field__label">{label}</span>
          <p>{single.name}</p>
        </div>
        <Button type="button" variant="tertiary" onClick={() => onChange([])}>
          {t("finance.studentPicker.change")}
        </Button>
      </div>
    );
  }

  return (
    <div className="sf-field finance-student-picker" ref={rootRef}>
      <label className="sf-field__label" htmlFor={inputId}>
        {label}
        {required ? (
          <span className="sf-field__required" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      <div className="finance-student-picker__anchor">
        <div className="sf-input finance-student-picker__control">
          <input
            ref={inputRef}
            id={inputId}
            className="sf-input__control"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-describedby={hintId}
            aria-invalid={error ? true : undefined}
            autoComplete="off"
            placeholder={t("finance.studentPicker.placeholder")}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onKeyDown={onKeyDown}
          />
          <button
            type="button"
            className="finance-student-picker__toggle"
            aria-label={t("finance.studentPicker.showList")}
            tabIndex={-1}
            // Keeps focus in the input, so its blur doesn't close the list this button opens.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setOpen((current) => !current);
              inputRef.current?.focus();
            }}
          >
            ▾
          </button>
        </div>
        {open ? (
          <ul
            id={listId}
            role="listbox"
            aria-label={label}
            className="finance-student-picker__results"
            // Picking happens on click; stop the input's blur from closing the list first.
            onMouseDown={(event) => event.preventDefault()}
          >
            {options.map((student) => (
              <li
                key={student.id}
                role="option"
                aria-selected={false}
                className="finance-student-picker__result"
                onClick={() => pick(student)}
              >
                {student.name}
              </li>
            ))}
            {students.isPending ? (
              <li className="finance-student-picker__empty">
                {t("finance.studentPicker.loading")}
              </li>
            ) : options.length === 0 ? (
              <li className="finance-student-picker__empty">
                {t("finance.studentPicker.noMatches")}
              </li>
            ) : null}
          </ul>
        ) : null}
      </div>
      {error ? (
        <p className="sf-field__error" role="alert">
          {error}
        </p>
      ) : (
        <p className="sf-field__helper" id={hintId}>
          {helperText ?? t("finance.studentPicker.helper")}
        </p>
      )}
      {multiple && selected.length > 0 ? (
        <ul
          className="finance-student-picker__chips"
          aria-label={t("finance.studentPicker.selected", { count: selected.length })}
        >
          {selected.map((student) => (
            <li key={student.id}>
              {student.name}
              <button
                type="button"
                aria-label={t("finance.studentPicker.remove", { name: student.name })}
                onClick={() => onChange(selected.filter((s) => s.id !== student.id))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
