import { Button, Input, Select, useToast } from "@studafy/ui";
import { useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { CertificateDocument } from "./CertificateView";
import { QueryState } from "./components";
import { documentLanguageOf } from "./document-language";
import {
  DOCUMENT_LANGUAGE_SETTINGS,
  useDocumentLanguageSettings,
  useUpdateDocumentLanguageSettings,
} from "./document-language-queries";
import { problemMessage } from "./errors";

import type { SetupContext } from "./context";
import type {
  DocumentLanguageSetting,
  DocumentLanguageSettings,
} from "./document-language-queries";
import type { CertificateContent } from "./queries";
import type { TFunction } from "i18next";

type DocumentType = "report_card" | "certificate" | "transcript";

const DOCUMENT_TYPES: readonly DocumentType[] = ["report_card", "certificate", "transcript"];

const FIELD: Record<DocumentType, keyof Omit<DocumentLanguageSettings, "school_name_ar">> = {
  report_card: "report_card_language",
  certificate: "certificate_language",
  transcript: "transcript_language",
};

/**
 * Arabic + English documents (000263): which language report cards, certificates and transcripts
 * are issued in, the school's Arabic name, and a preview of a sample document in the chosen
 * language. Issued documents keep the language they were issued with.
 */
export function DocumentLanguageCard({ ctx }: { ctx: SetupContext }) {
  const { t } = useTranslation();
  const settings = useDocumentLanguageSettings();
  return (
    <section className="ag-block ag-card" aria-labelledby="ag-document-language-heading">
      <h2 id="ag-document-language-heading">{t("academicGrading.documentLanguage.heading")}</h2>
      <p className="ag-muted">{t("academicGrading.documentLanguage.help")}</p>
      <QueryState isPending={settings.isPending} error={settings.error}>
        {settings.data ? (
          <DocumentLanguageForm
            key={JSON.stringify(settings.data)}
            settings={settings.data}
            canManage={ctx.can.manage}
          />
        ) : null}
      </QueryState>
    </section>
  );
}

function DocumentLanguageForm({
  settings,
  canManage,
}: {
  settings: DocumentLanguageSettings;
  canManage: boolean;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const update = useUpdateDocumentLanguageSettings();
  const [languages, setLanguages] = useState<Record<DocumentType, DocumentLanguageSetting>>(() => ({
    report_card: settings.report_card_language,
    certificate: settings.certificate_language,
    transcript: settings.transcript_language,
  }));
  const [schoolNameAr, setSchoolNameAr] = useState(settings.school_name_ar ?? "");
  const [previewType, setPreviewType] = useState<DocumentType>("certificate");
  const [showPreview, setShowPreview] = useState(false);

  const options = DOCUMENT_LANGUAGE_SETTINGS.map((value) => ({
    value,
    label: t(`academicGrading.documentLanguage.languages.${value}`),
  }));

  function save() {
    update.mutate(
      {
        report_card_language: languages.report_card,
        certificate_language: languages.certificate,
        transcript_language: languages.transcript,
        school_name_ar: schoolNameAr.trim() || null,
      },
      {
        onSuccess: () =>
          show({ variant: "success", title: t("academicGrading.documentLanguage.saved") }),
        onError: (error) =>
          show({
            variant: "error",
            title: t("academicGrading.documentLanguage.saveFailed"),
            description: problemMessage(error, t),
          }),
      },
    );
  }

  // eslint-disable-next-line security/detect-object-injection -- `previewType` is one of DOCUMENT_TYPES
  const previewLanguage = languages[previewType];

  return (
    <div className="ag-form">
      <div className="ag-grid">
        {DOCUMENT_TYPES.map((type) => (
          <Select
            key={type}
            label={t(`academicGrading.documentLanguage.types.${type}`)}
            options={options}
            // eslint-disable-next-line security/detect-object-injection -- `type` is one of DOCUMENT_TYPES
            value={languages[type]}
            disabled={!canManage}
            onChange={(value) =>
              setLanguages((prev) => ({ ...prev, [type]: value as DocumentLanguageSetting }))
            }
          />
        ))}
      </div>
      <Input
        label={t("academicGrading.documentLanguage.schoolNameAr")}
        helperText={t("academicGrading.documentLanguage.schoolNameArHelp")}
        value={schoolNameAr}
        maxLength={200}
        dir="rtl"
        lang="ar"
        disabled={!canManage}
        onChange={(event) => setSchoolNameAr(event.target.value)}
      />
      {canManage ? (
        <div>
          <Button type="button" loading={update.isPending} onClick={save}>
            {t("academicGrading.documentLanguage.save")}
          </Button>
        </div>
      ) : (
        <p className="ag-muted">{t("academicGrading.documentLanguage.readOnly")}</p>
      )}

      <fieldset className="ag-fieldset">
        <legend>{t("academicGrading.documentLanguage.previewHeading")}</legend>
        <p className="ag-muted">{t("academicGrading.documentLanguage.previewHelp")}</p>
        <Select
          label={t("academicGrading.documentLanguage.previewType")}
          options={DOCUMENT_TYPES.map((type) => ({
            value: type,
            label: t(`academicGrading.documentLanguage.types.${type}`),
          }))}
          value={previewType}
          onChange={(value) => setPreviewType(value as DocumentType)}
        />
        <div>
          <Button
            type="button"
            variant="secondary"
            aria-expanded={showPreview}
            onClick={() => setShowPreview((shown) => !shown)}
          >
            {showPreview
              ? t("academicGrading.documentLanguage.hidePreview")
              : t("academicGrading.documentLanguage.showPreview")}
          </Button>
        </div>
        {showPreview ? (
          <div className="ag-document-preview" data-testid="document-language-preview">
            <CertificateDocument
              content={sampleContent(t, previewType, previewLanguage, schoolNameAr.trim())}
              voided={false}
            />
          </div>
        ) : null}
      </fieldset>
    </div>
  );
}

/**
 * A made-up document for the preview: the certificate layout (a term report card for report
 * cards; a transcript shares its labels and names) with sample names in both spellings.
 */
export function sampleContent(
  t: TFunction,
  type: DocumentType,
  setting: DocumentLanguageSetting,
  schoolNameAr: string,
): CertificateContent {
  const language = documentLanguageOf(setting);
  const subject = (code: string, name: string, nameAr: string, percentage: number) => ({
    code,
    name,
    name_ar: nameAr,
    requirement: "mandatory",
    marks_obtained: percentage,
    max_marks: 100,
    percentage,
    grade_label: percentage >= 90 ? "A" : "B",
    passed: true,
    exempt: false,
    terms: [],
  });
  return {
    version: 1,
    kind: type === "report_card" ? "term_report" : "annual_certificate",
    serial_number: "2026-C-PREVIEW",
    issued_at: new Date().toISOString(),
    ...(language ? { language } : {}),
    school: {
      id: "preview",
      name: t("academicGrading.documentLanguage.sample.school"),
      ...(schoolNameAr ? { name_ar: schoolNameAr } : {}),
    },
    academic_year: { id: "preview", code: "2026-2027", name: "2026-2027" },
    term: type === "report_card" ? { id: "preview", name: "Term 1", name_ar: "الفصل الأول" } : null,
    student: {
      id: "preview",
      first_name: "Sara",
      last_name: "Ahmad",
      first_name_ar: "سارة",
      middle_name_ar: "خالد",
      last_name_ar: "أحمد",
      admission_number: "ADM-001",
    },
    grade_level_name: "Grade 9",
    grade_level_name_ar: "الصف التاسع",
    section_name: "A",
    section_name_ar: "أ",
    subjects: [
      subject("MATH", "Mathematics", "الرياضيات", 92),
      subject("ARAB", "Arabic", "اللغة العربية", 88),
      subject("SCI", "Science", "العلوم", 85),
    ],
    overall: {
      average_percentage: 88.33,
      total_obtained: 265,
      total_max: 300,
      grade_label: "B",
      display: { format: "percentage", value: 88.33, max: 100 },
      subjects_failed: 0,
      academic_status: "promoted",
    },
    finalization: { id: "preview", version: 1, finalized_at: new Date().toISOString() },
    issued_by: { user_id: "preview", name: null },
    reissue: null,
  };
}
