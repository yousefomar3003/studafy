import { useTranslation } from "../../../lib/i18n";
import { FinanceStudentPicker } from "../students/FinanceStudentPicker";

import type { StudentIdentity } from "../students/FinanceStudentPicker";

export interface StudentPickerFieldProps {
  value: StudentIdentity | null;
  onChange: (student: StudentIdentity | null) => void;
}

/**
 * Optional single-student scope for a report run, on the shared finance picker. Scoped to at most
 * one student: the report endpoints themselves accept many (`student_ids`), but narrowing a report
 * to "this household's kid" is the report center's actual use case, and a multi-select adds real UI
 * weight for a filter most runs leave off entirely.
 */
export function StudentPickerField({ value, onChange }: StudentPickerFieldProps) {
  const { t } = useTranslation();
  return (
    <FinanceStudentPicker
      label={
        value
          ? t("financeReports.reports.studentPicker.student")
          : t("financeReports.reports.studentPicker.studentOptional")
      }
      helperText={t("financeReports.reports.studentPicker.helper")}
      selected={value ? [value] : []}
      onChange={(next) => onChange(next[0] ?? null)}
    />
  );
}
