import { Input } from "@studafy/ui";

import { useTranslation } from "../../../lib/i18n";

export type ArabicNameField = "first_name_ar" | "middle_name_ar" | "last_name_ar";

const FIELDS: readonly { field: ArabicNameField; labelKey: string }[] = [
  { field: "first_name_ar", labelKey: "adminPeople.students.form.firstNameAr" },
  { field: "middle_name_ar", labelKey: "adminPeople.students.form.middleNameAr" },
  { field: "last_name_ar", labelKey: "adminPeople.students.form.lastNameAr" },
];

/**
 * The optional Arabic spelling of a student's name, shown on Arabic and bilingual report cards,
 * certificates and transcripts and in the app in Arabic. Typed right to left whatever the page's
 * own direction.
 */
export function ArabicNameInputs({
  values,
  errors,
  onChange,
}: {
  values: Partial<Record<ArabicNameField, string>>;
  errors: Partial<Record<string, string>>;
  onChange: (field: ArabicNameField, value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <fieldset className="students-form__arabic-names">
      <legend>{t("adminPeople.students.form.arabicNames")}</legend>
      <p className="students-form__hint">{t("adminPeople.students.form.arabicNamesHelper")}</p>
      {FIELDS.map(({ field, labelKey }) => (
        <Input
          key={field}
          label={t(labelKey)}
          // eslint-disable-next-line security/detect-object-injection -- `field` is one of this module's three literal keys
          value={values[field] ?? ""}
          onChange={(event) => onChange(field, event.target.value)}
          // eslint-disable-next-line security/detect-object-injection -- as above
          error={errors[field] && t(errors[field])}
          dir="rtl"
          lang="ar"
          autoComplete="off"
        />
      ))}
    </fieldset>
  );
}
