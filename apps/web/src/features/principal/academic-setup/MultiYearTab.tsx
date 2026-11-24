import { MULTI_YEAR_LIMITS, validateMultiYearYears } from "@studafy/grading-engine";
import { Button, Checkbox, Input, Select, Table, useToast } from "@studafy/ui";
import { useMemo, useState } from "react";

import { useTranslation } from "../../../lib/i18n";
import { useGradeLevels } from "../sections/queries";

import { Badge, ConfirmModal, SeverityBadge } from "./components";
import { newKey } from "./config-form";
import {
  useDeleteMultiYearConfig,
  useMultiYearConfigs,
  useSaveMultiYearConfig,
} from "./equivalency";
import { problemMessage } from "./errors";

import type { SetupContext } from "./context";
import type { MultiYearConfig, MultiYearConfigBody } from "./equivalency";
import type { ValidationIssue } from "@studafy/grading-engine";

interface YearDraft {
  key: string;
  gradeLevelId: string | undefined;
  weight: string;
}

interface ConfigDraft {
  name: string;
  isActive: boolean;
  visible: boolean;
  years: YearDraft[];
}

const year = (gradeLevelId: string | undefined, weight: string): YearDraft => ({
  key: newKey("year"),
  gradeLevelId,
  weight,
});

function draftFrom(config: MultiYearConfig | null): ConfigDraft {
  if (!config) {
    return {
      name: "",
      isActive: true,
      visible: false,
      years: [year(undefined, "40"), year(undefined, "60")],
    };
  }
  return {
    name: config.name,
    isActive: config.is_active,
    visible: config.visible_to_students_and_parents,
    years: config.years.map((entry) => year(entry.grade_level.id, String(entry.weight))),
  };
}

function bodyOf(draft: ConfigDraft): MultiYearConfigBody {
  return {
    name: draft.name.trim(),
    is_active: draft.isActive,
    visible_to_students_and_parents: draft.visible,
    years: draft.years.map((entry) => ({
      grade_level_id: entry.gradeLevelId ?? "",
      weight: entry.weight.trim() === "" ? Number.NaN : Number(entry.weight),
    })),
  };
}

/**
 * Multi-year results: a result weighted across several grade levels ("Grade 11 40% + Grade 12
 * 60%"), per subject and overall, from each year's finalized annual result (not tied to the
 * selected year). Shown on the student page, and to students and parents when the school chooses.
 */
export function MultiYearTab({ ctx }: { ctx: SetupContext }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const canEdit = ctx.can.manage;
  const configs = useMultiYearConfigs();
  const remove = useDeleteMultiYearConfig();
  const [editing, setEditing] = useState<{ config: MultiYearConfig | null } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MultiYearConfig | null>(null);

  if (editing) {
    return (
      <MultiYearEditor
        config={editing.config}
        readOnly={!canEdit}
        onClose={() => setEditing(null)}
      />
    );
  }

  return (
    <section className="ag-block" aria-labelledby="ag-multi-year-heading">
      <div className="ag-head">
        <h2 id="ag-multi-year-heading">{t("academicGrading.multiYear.heading")}</h2>
        {canEdit ? (
          <Button type="button" variant="secondary" onClick={() => setEditing({ config: null })}>
            {t("academicGrading.multiYear.add")}
          </Button>
        ) : null}
      </div>
      <p className="ag-muted">{t("academicGrading.multiYear.help")}</p>
      <Table caption={t("academicGrading.multiYear.caption")} hideCaption>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("academicGrading.multiYear.columns.name")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.multiYear.columns.years")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.multiYear.columns.actions")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={3}
          loading={configs.isPending}
          empty={
            configs.isError
              ? problemMessage(configs.error, t)
              : t("academicGrading.multiYear.empty")
          }
        >
          {(configs.data ?? []).map((config) => (
            <Table.Row key={config.id}>
              <Table.Cell>
                <strong>{config.name}</strong>
                <div>
                  {config.is_active ? null : (
                    <Badge tone="neutral">{t("academicGrading.multiYear.inactive")}</Badge>
                  )}{" "}
                  {config.visible_to_students_and_parents ? (
                    <Badge tone="info">{t("academicGrading.multiYear.visible")}</Badge>
                  ) : null}
                </div>
              </Table.Cell>
              <Table.Cell>
                {config.years
                  .map((entry) =>
                    t("academicGrading.multiYear.yearWeight", {
                      grade: entry.grade_level.name,
                      weight: entry.weight,
                    }),
                  )
                  .join(" + ")}
              </Table.Cell>
              <Table.Cell>
                <div className="sections-page__row-actions">
                  <Button
                    type="button"
                    variant="secondary"
                    aria-label={t("academicGrading.multiYear.editLabel", { name: config.name })}
                    onClick={() => setEditing({ config })}
                  >
                    {canEdit ? t("academicGrading.common.edit") : t("academicGrading.common.view")}
                  </Button>
                  {canEdit ? (
                    <Button
                      type="button"
                      variant="tertiary"
                      aria-label={t("academicGrading.multiYear.deleteLabel", { name: config.name })}
                      onClick={() => setPendingDelete(config)}
                    >
                      {t("academicGrading.common.remove")}
                    </Button>
                  ) : null}
                </div>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
      <ConfirmModal
        open={pendingDelete !== null}
        title={t("academicGrading.multiYear.deleteTitle", { name: pendingDelete?.name ?? "" })}
        description={t("academicGrading.multiYear.deleteDescription")}
        confirmLabel={t("academicGrading.common.remove")}
        submitting={remove.isPending}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() =>
          pendingDelete &&
          remove.mutate(pendingDelete.id, {
            onSuccess: () => {
              show({ variant: "success", title: t("academicGrading.multiYear.deleted") });
              setPendingDelete(null);
            },
            onError: (error) => {
              show({
                variant: "error",
                title: t("academicGrading.multiYear.deleteFailed"),
                description: problemMessage(error, t),
              });
              setPendingDelete(null);
            },
          })
        }
      />
    </section>
  );
}

function MultiYearEditor({
  config,
  readOnly,
  onClose,
}: {
  config: MultiYearConfig | null;
  readOnly: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const save = useSaveMultiYearConfig();
  const grades = useGradeLevels();
  const [draft, setDraft] = useState<ConfigDraft>(() => draftFrom(config));

  const issues = useMemo(() => {
    const found: (ValidationIssue & { key: string })[] = [];
    if (draft.name.trim() === "") {
      found.push({
        key: "name",
        code: "NAME",
        severity: "error",
        message: t("academicGrading.multiYear.nameRequired"),
      });
    }
    if (draft.years.some((entry) => entry.gradeLevelId === undefined)) {
      found.push({
        key: "grade",
        code: "GRADE",
        severity: "error",
        message: t("academicGrading.multiYear.gradeRequired"),
      });
    }
    const body = bodyOf(draft);
    for (const issue of validateMultiYearYears(
      body.years.map((entry) => ({ key: entry.grade_level_id, weight: entry.weight })),
    )) {
      found.push({
        ...issue,
        key: issue.code,
        message: t(`academicGrading.multiYear.issue.${issue.code}`, {
          defaultValue: issue.message,
          min: MULTI_YEAR_LIMITS.minYears,
          max: MULTI_YEAR_LIMITS.maxYears,
        }),
      });
    }
    return found;
  }, [draft, t]);

  const patch = (changes: Partial<ConfigDraft>) => setDraft((prev) => ({ ...prev, ...changes }));
  const patchYear = (key: string, changes: Partial<YearDraft>) =>
    setDraft((prev) => ({
      ...prev,
      years: prev.years.map((entry) => (entry.key === key ? { ...entry, ...changes } : entry)),
    }));

  function submit() {
    save.mutate(
      { configId: config?.id ?? null, body: bodyOf(draft) },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("academicGrading.multiYear.saved") });
          onClose();
        },
      },
    );
  }

  return (
    <section className="ag-editor" aria-labelledby="ag-multi-year-editor-heading">
      <div className="ag-head">
        <h2 id="ag-multi-year-editor-heading">
          {config
            ? t("academicGrading.multiYear.editTitle", { name: config.name })
            : t("academicGrading.multiYear.add")}
        </h2>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("academicGrading.editor.back")}
        </Button>
      </div>
      <fieldset className="ag-fieldset" disabled={readOnly}>
        <legend>{t("academicGrading.multiYear.details")}</legend>
        <Input
          label={t("academicGrading.multiYear.name")}
          value={draft.name}
          required
          maxLength={120}
          onChange={(event) => patch({ name: event.target.value })}
        />
        <Checkbox
          label={t("academicGrading.multiYear.activeLabel")}
          checked={draft.isActive}
          onChange={(event) => patch({ isActive: event.target.checked })}
        />
        <Checkbox
          label={t("academicGrading.multiYear.visibleLabel")}
          checked={draft.visible}
          onChange={(event) => patch({ visible: event.target.checked })}
        />
      </fieldset>
      <fieldset className="ag-fieldset" disabled={readOnly}>
        <legend>{t("academicGrading.multiYear.yearsLegend")}</legend>
        <p className="ag-muted">{t("academicGrading.multiYear.yearsHelp")}</p>
        {draft.years.map((entry, index) => (
          <div
            key={entry.key}
            className="ag-row ag-grid ag-grid--dense"
            role="group"
            aria-label={t("academicGrading.multiYear.yearN", { n: index + 1 })}
          >
            <Select
              label={t("academicGrading.multiYear.gradeLabel", { n: index + 1 })}
              placeholder={t("academicGrading.multiYear.gradePlaceholder")}
              options={(grades.data ?? []).map((grade) => ({ value: grade.id, label: grade.name }))}
              value={entry.gradeLevelId}
              disabled={grades.isPending}
              onChange={(gradeLevelId) => patchYear(entry.key, { gradeLevelId })}
            />
            <Input
              label={t("academicGrading.multiYear.weightLabel", { n: index + 1 })}
              type="number"
              min={0}
              max={100}
              step="any"
              value={entry.weight}
              onChange={(event) => patchYear(entry.key, { weight: event.target.value })}
            />
            <Button
              type="button"
              variant="tertiary"
              aria-label={t("academicGrading.multiYear.removeYear", { n: index + 1 })}
              onClick={() =>
                setDraft((prev) => ({
                  ...prev,
                  years: prev.years.filter((candidate) => candidate.key !== entry.key),
                }))
              }
            >
              {t("academicGrading.common.remove")}
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="secondary"
          disabled={draft.years.length >= MULTI_YEAR_LIMITS.maxYears}
          onClick={() =>
            setDraft((prev) => ({ ...prev, years: [...prev.years, year(undefined, "")] }))
          }
        >
          {t("academicGrading.multiYear.addYear")}
        </Button>
      </fieldset>
      <section className="ag-card ag-check" aria-label={t("academicGrading.editor.check")}>
        {issues.length === 0 ? (
          <p>{t("academicGrading.multiYear.valid")}</p>
        ) : (
          <ul className="ag-issues">
            {issues.map((issue) => (
              <li key={issue.key} className="ag-issues__item">
                <SeverityBadge severity="error" /> <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {save.isError ? (
        <p className="ag-error" role="alert">
          {problemMessage(save.error, t)}
        </p>
      ) : null}
      <div className="ag-actions">
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("academicGrading.common.cancel")}
        </Button>
        {readOnly ? null : (
          <Button
            type="button"
            loading={save.isPending}
            disabled={issues.length > 0}
            onClick={submit}
          >
            {t("academicGrading.multiYear.save")}
          </Button>
        )}
      </div>
    </section>
  );
}
