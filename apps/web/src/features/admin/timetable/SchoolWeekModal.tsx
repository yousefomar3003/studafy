import { ApiError } from "@studafy/api-client";
import { Button, Checkbox, Input, Modal, useToast } from "@studafy/ui";
import { useEffect, useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { WEEKDAYS } from "./constants";
import { useUpdateTimetableSettings } from "./mutations";

import type { TimetableSettings } from "./queries";

export interface SchoolWeekModalProps {
  open: boolean;
  onClose: () => void;
  settings: TimetableSettings;
}

/** Common teaching weeks, offered as one-click presets. 1=Mon..7=Sun. */
const PRESETS = [
  { key: "sunThu", days: [7, 1, 2, 3, 4] },
  { key: "monFri", days: [1, 2, 3, 4, 5] },
] as const;

/** Picker order: the week as most of the product's schools live it, starting on Sunday. */
const PICKER_ORDER = [7, 1, 2, 3, 4, 5, 6];

const MAX_PERIODS = 16;

/**
 * Edits the school's teaching week — which days the timetable shows and how many periods a day has.
 * Only shapes the grid: lessons already scheduled on a day that's removed are kept, and the grid
 * keeps showing that day while it still has any.
 */
export function SchoolWeekModal({ open, onClose, settings }: SchoolWeekModalProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const update = useUpdateTimetableSettings();
  const [days, setDays] = useState<number[]>([...settings.school_days]);
  const [periods, setPeriods] = useState(String(settings.periods_per_day));

  useEffect(() => {
    if (open) {
      setDays([...settings.school_days]);
      setPeriods(String(settings.periods_per_day));
    }
  }, [open, settings]);

  const periodCount = Number(periods);
  const periodsValid =
    Number.isInteger(periodCount) && periodCount >= 1 && periodCount <= MAX_PERIODS;
  const valid = days.length > 0 && periodsValid;

  function toggleDay(day: number, checked: boolean) {
    setDays((current) =>
      checked
        ? PICKER_ORDER.filter((candidate) => candidate === day || current.includes(candidate))
        : current.filter((candidate) => candidate !== day),
    );
  }

  function handleSave() {
    if (!valid) return;
    update.mutate(
      { school_days: days, periods_per_day: periodCount },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("adminSchool.timetable.schoolWeek.saved") });
          onClose();
        },
        onError: (err) =>
          show({
            variant: "error",
            title: t("adminSchool.timetable.schoolWeek.saveFailed"),
            description: err instanceof ApiError ? (err.detail ?? err.title) : undefined,
          }),
      },
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("adminSchool.timetable.schoolWeek.title")}
      description={t("adminSchool.timetable.schoolWeek.description")}
    >
      <Modal.Body>
        <div className="timetable-week-form">
          <fieldset className="timetable-week-form__days">
            <legend>{t("adminSchool.timetable.schoolWeek.days")}</legend>
            <div className="timetable-week-form__presets">
              {PRESETS.map((preset) => (
                <Button
                  key={preset.key}
                  type="button"
                  variant="tertiary"
                  onClick={() => setDays([...preset.days])}
                >
                  {t(`adminSchool.timetable.schoolWeek.presets.${preset.key}`)}
                </Button>
              ))}
            </div>
            <div className="timetable-week-form__day-list">
              {PICKER_ORDER.map((value) => {
                const day = WEEKDAYS.find((candidate) => candidate.value === value)!;
                return (
                  <Checkbox
                    key={value}
                    label={t(day.labelKey)}
                    checked={days.includes(value)}
                    onChange={(event) => toggleDay(value, event.target.checked)}
                  />
                );
              })}
            </div>
            {days.length === 0 ? (
              <p role="alert" className="timetable-week-form__error">
                {t("adminSchool.timetable.schoolWeek.daysRequired")}
              </p>
            ) : null}
          </fieldset>
          <Input
            label={t("adminSchool.timetable.schoolWeek.periods")}
            type="number"
            min={1}
            max={MAX_PERIODS}
            value={periods}
            onChange={(event) => setPeriods(event.target.value)}
            error={
              periodsValid
                ? undefined
                : t("adminSchool.timetable.schoolWeek.periodsInvalid", { max: MAX_PERIODS })
            }
          />
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("adminSchool.timetable.editModal.cancel")}
        </Button>
        <Button type="button" loading={update.isPending} disabled={!valid} onClick={handleSave}>
          {t("adminSchool.timetable.schoolWeek.save")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
