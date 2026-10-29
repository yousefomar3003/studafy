import { ApiError } from "@studafy/api-client";
import { Button, useToast } from "@studafy/ui";
import { useState } from "react";

import { useFormatters, useTranslation } from "../../../lib/i18n";

import { FieldEditorModal } from "./FieldEditorModal";
import { FormPreview } from "./FormPreview";
import {
  usePublishRecordTemplate,
  useReorderRecordFields,
  useUpdateRecordField,
} from "./mutations";
import { useRecordTemplateQuery } from "./queries";

import type { RecordSubjectKind, RecordTemplateField } from "./queries";
import type { Locale } from "../../../lib/i18n";

export interface RecordTemplateEditorProps {
  kind: RecordSubjectKind;
  /** `recordTemplate:manage`. Without it the draft is shown read-only. */
  canManage: boolean;
}

/**
 * One school's record template for students or parents: the draft fields in order, with add, edit,
 * reorder, archive/restore and publish, and a preview of the form in English and Arabic. Mounted
 * as-is by both portals (Admin > School settings and the principal's school tools); the routes gate
 * it on `recordTemplate:manage`, which ORG_ADMIN and PRINCIPAL both hold.
 *
 * Every change is a draft until published. Publishing makes a new version; answers already given
 * keep the field definition they were given under, and archiving a field drops it from the next
 * version without deleting a single answer.
 */
export function RecordTemplateEditor({ kind, canManage }: RecordTemplateEditorProps) {
  const { t, i18n } = useTranslation();
  const { formatNumber, formatDate } = useFormatters();
  const { show } = useToast();
  const template = useRecordTemplateQuery(kind);
  const updateField = useUpdateRecordField(kind);
  const reorder = useReorderRecordFields(kind);
  const publish = usePublishRecordTemplate(kind);
  const [editing, setEditing] = useState<RecordTemplateField | null>(null);
  const [adding, setAdding] = useState(false);
  const [previewLanguage, setPreviewLanguage] = useState<Locale>("en");

  if (template.isPending) {
    return <p className="record-templates__muted">{t("recordTemplates.common.loading")}</p>;
  }
  if (template.isError) {
    return (
      <p className="record-templates__error" role="alert">
        {t("recordTemplates.editor.loadError")}
      </p>
    );
  }

  const fields = template.data.fields;
  const live = fields.filter((field) => !field.archived);
  const archived = fields.filter((field) => field.archived);
  const labelOf = (field: RecordTemplateField) =>
    i18n.language === "ar" ? field.label_ar : field.label_en;

  function errorToast(error: Error, title: string) {
    show({
      variant: "error",
      title,
      description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
    });
  }

  function move(field: RecordTemplateField, offset: -1 | 1) {
    const order = live.map((item) => item.id);
    const from = order.indexOf(field.id);
    const to = from + offset;
    if (to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to]!, order[from]!];
    reorder.mutate(order, {
      onError: (error) => errorToast(error, t("recordTemplates.editor.reorderError")),
    });
  }

  function setArchived(field: RecordTemplateField, value: boolean) {
    updateField.mutate(
      { fieldId: field.id, body: { archived: value } },
      {
        onSuccess: () =>
          show({
            variant: "success",
            title: t(
              value ? "recordTemplates.editor.archived" : "recordTemplates.editor.restored",
              {
                label: labelOf(field),
              },
            ),
          }),
        onError: (error) => errorToast(error, t("recordTemplates.field.saveError")),
      },
    );
  }

  function handlePublish() {
    publish.mutate(undefined, {
      onSuccess: (version) =>
        show({
          variant: "success",
          title: t("recordTemplates.editor.published", {
            version: formatNumber(version.version),
          }),
        }),
      onError: (error) =>
        errorToast(
          error,
          t(
            error instanceof ApiError && error.code === "RECORD_NOTHING_TO_PUBLISH"
              ? "recordTemplates.editor.nothingToPublish"
              : "recordTemplates.editor.publishError",
          ),
        ),
    });
  }

  const { published_version: version, published_at: publishedAt } = template.data;

  return (
    <div className="record-templates">
      <div className="record-templates__status">
        <p>
          {version === 0
            ? t("recordTemplates.editor.neverPublished")
            : t("recordTemplates.editor.publishedVersion", {
                version: formatNumber(version),
                date: publishedAt ? formatDate(new Date(publishedAt), { dateStyle: "medium" }) : "",
              })}{" "}
          {template.data.has_unpublished_changes ? (
            <span className="record-templates__badge" data-tone="warning">
              {t("recordTemplates.editor.unpublishedChanges")}
            </span>
          ) : null}
        </p>
        <p className="record-templates__muted">{t("recordTemplates.editor.versionsNote")}</p>
        {canManage ? (
          <div className="record-templates__actions">
            <Button variant="secondary" onClick={() => setAdding(true)}>
              {t("recordTemplates.editor.addField")}
            </Button>
            <Button
              onClick={handlePublish}
              loading={publish.isPending}
              disabled={!template.data.has_unpublished_changes}
            >
              {t("recordTemplates.editor.publish")}
            </Button>
          </div>
        ) : null}
      </div>

      <section aria-labelledby={`record-fields-${kind}`}>
        <h3 id={`record-fields-${kind}`}>
          {t("recordTemplates.editor.fieldsHeading", { count: live.length })}
        </h3>
        {live.length === 0 ? (
          <p className="record-templates__muted">{t("recordTemplates.editor.empty")}</p>
        ) : (
          <ol className="record-templates__fields">
            {live.map((field, index) => (
              <FieldRow
                key={field.id}
                field={field}
                label={labelOf(field)}
                canManage={canManage}
                first={index === 0}
                last={index === live.length - 1}
                onUp={() => move(field, -1)}
                onDown={() => move(field, 1)}
                onEdit={() => setEditing(field)}
                onArchive={() => setArchived(field, true)}
              />
            ))}
          </ol>
        )}
      </section>

      {archived.length > 0 ? (
        <section aria-labelledby={`record-archived-${kind}`}>
          <h3 id={`record-archived-${kind}`}>
            {t("recordTemplates.editor.archivedHeading", { count: archived.length })}
          </h3>
          <p className="record-templates__muted">{t("recordTemplates.editor.archivedNote")}</p>
          <ul className="record-templates__fields">
            {archived.map((field) => (
              <li key={field.id} className="record-templates__field">
                <span className="record-templates__field-label">{labelOf(field)}</span>
                {canManage ? (
                  <Button variant="tertiary" onClick={() => setArchived(field, false)}>
                    {t("recordTemplates.editor.restore", { label: labelOf(field) })}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby={`record-preview-${kind}`}>
        <h3 id={`record-preview-${kind}`}>{t("recordTemplates.preview.heading")}</h3>
        <div
          className="record-templates__actions"
          role="group"
          aria-label={t("recordTemplates.preview.language")}
        >
          {(["en", "ar"] as const).map((language) => (
            <Button
              key={language}
              variant={previewLanguage === language ? "primary" : "secondary"}
              aria-pressed={previewLanguage === language}
              onClick={() => setPreviewLanguage(language)}
            >
              {t(`recordTemplates.preview.${language}`)}
            </Button>
          ))}
        </div>
        <FormPreview fields={live} language={previewLanguage} />
      </section>

      {canManage ? (
        <FieldEditorModal
          open={adding || editing !== null}
          kind={kind}
          field={editing}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}

interface FieldRowProps {
  field: RecordTemplateField;
  label: string;
  canManage: boolean;
  first: boolean;
  last: boolean;
  onUp: () => void;
  onDown: () => void;
  onEdit: () => void;
  onArchive: () => void;
}

function FieldRow({
  field,
  label,
  canManage,
  first,
  last,
  onUp,
  onDown,
  onEdit,
  onArchive,
}: FieldRowProps) {
  const { t } = useTranslation();
  return (
    <li className="record-templates__field">
      <div>
        <span className="record-templates__field-label">{label}</span>{" "}
        <span className="record-templates__muted">
          {t(`recordTemplates.types.${field.field_type}`)}
        </span>
        <div className="record-templates__badges">
          {field.required ? (
            <span className="record-templates__badge">{t("recordTemplates.badges.required")}</span>
          ) : null}
          <span className="record-templates__badge">
            {t(`recordTemplates.visibility.${field.visibility}`)}
          </span>
          {field.sensitivity === "sensitive" ? (
            <span className="record-templates__badge" data-tone="warning">
              {t("recordTemplates.badges.sensitive")}
            </span>
          ) : field.label_suggests_sensitive ? (
            <span className="record-templates__badge" data-tone="info">
              {t("recordTemplates.badges.looksSensitive")}
            </span>
          ) : null}
          {!field.published ? (
            <span className="record-templates__badge">{t("recordTemplates.badges.draft")}</span>
          ) : null}
        </div>
      </div>
      {canManage ? (
        <div className="record-templates__row-actions">
          <Button variant="tertiary" disabled={first} onClick={onUp}>
            {t("recordTemplates.editor.moveUp", { label })}
          </Button>
          <Button variant="tertiary" disabled={last} onClick={onDown}>
            {t("recordTemplates.editor.moveDown", { label })}
          </Button>
          <Button variant="secondary" onClick={onEdit}>
            {t("recordTemplates.editor.edit", { label })}
          </Button>
          <Button variant="tertiary" onClick={onArchive}>
            {t("recordTemplates.editor.archive", { label })}
          </Button>
        </div>
      ) : null}
    </li>
  );
}
