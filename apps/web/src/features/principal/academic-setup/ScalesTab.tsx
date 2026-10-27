import { validateGradeScale } from "@studafy/grading-engine";
import { Button, Input, Table, useToast } from "@studafy/ui";
import { useMemo, useState } from "react";

import { useFormatters, useTranslation } from "../../../lib/i18n";

import { ConfirmModal, SeverityBadge } from "./components";
import { newKey } from "./config-form";
import { problemMessage } from "./errors";
import { useDeleteGradeScale, useSaveGradeScale } from "./mutations";
import { useGradeScales } from "./queries";

import type { SetupContext } from "./context";
import type { GradeScale } from "./queries";

interface BandDraft {
  key: string;
  label: string;
  min: string;
  gpa: string;
}

const DEFAULT_BANDS: readonly [string, string][] = [
  ["A", "90"],
  ["B", "80"],
  ["C", "70"],
  ["D", "60"],
  ["F", "0"],
];

/**
 * The year's grading scales. A band's percentage is its lower bound — it runs up to the next band —
 * so one band must start at 0. Changes are checked with the grading engine as they are typed.
 */
export function ScalesTab({ ctx }: { ctx: SetupContext }) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const { show } = useToast();
  const scales = useGradeScales(ctx.year.id);
  const remove = useDeleteGradeScale();
  const [editing, setEditing] = useState<{ scale: GradeScale | null } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<GradeScale | null>(null);
  const canEdit = ctx.can.manage && ctx.configEditable;

  if (editing) {
    return <ScaleEditor ctx={ctx} scale={editing.scale} onClose={() => setEditing(null)} />;
  }

  return (
    <section className="ag-block" aria-labelledby="ag-scales-heading">
      <div className="ag-head">
        <h2 id="ag-scales-heading">{t("academicGrading.scales.heading")}</h2>
        {canEdit ? (
          <Button type="button" onClick={() => setEditing({ scale: null })}>
            {t("academicGrading.scales.add")}
          </Button>
        ) : null}
      </div>
      <p className="ag-muted">{t("academicGrading.scales.help")}</p>
      <Table caption={t("academicGrading.scales.caption")} hideCaption>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("academicGrading.scales.columns.name")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.scales.columns.bands")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.scales.columns.issues")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.scales.columns.actions")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={4}
          loading={scales.isPending}
          empty={
            scales.isError ? problemMessage(scales.error, t) : t("academicGrading.scales.empty")
          }
        >
          {(scales.data ?? []).map((scale) => (
            <Table.Row key={scale.id}>
              <Table.Cell>{scale.name}</Table.Cell>
              <Table.Cell>
                {[...scale.bands]
                  .sort((a, b) => b.min_percentage - a.min_percentage)
                  .map((band) =>
                    t("academicGrading.scales.band", {
                      label: band.label,
                      min: formatNumber(band.min_percentage),
                    }),
                  )
                  .join(" · ")}
              </Table.Cell>
              <Table.Cell>
                {scale.issues.length === 0 ? (
                  t("academicGrading.scales.noIssues")
                ) : (
                  <ul className="ag-issues">
                    {scale.issues.map((issue, index) => (
                      <li key={`${issue.code}-${index}`} className="ag-issues__item">
                        <SeverityBadge severity={issue.severity} /> <span>{issue.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Table.Cell>
              <Table.Cell>
                <div className="sections-page__row-actions">
                  <Button
                    type="button"
                    variant="secondary"
                    aria-label={t("academicGrading.scales.editLabel", { name: scale.name })}
                    onClick={() => setEditing({ scale })}
                  >
                    {canEdit ? t("academicGrading.common.edit") : t("academicGrading.common.view")}
                  </Button>
                  {canEdit ? (
                    <Button
                      type="button"
                      variant="tertiary"
                      aria-label={t("academicGrading.scales.deleteLabel", { name: scale.name })}
                      onClick={() => setPendingDelete(scale)}
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
        title={t("academicGrading.scales.deleteTitle", { name: pendingDelete?.name ?? "" })}
        description={t("academicGrading.scales.deleteDescription")}
        confirmLabel={t("academicGrading.common.remove")}
        submitting={remove.isPending}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() =>
          pendingDelete &&
          remove.mutate(pendingDelete.id, {
            onSuccess: () => {
              show({ variant: "success", title: t("academicGrading.scales.deleted") });
              setPendingDelete(null);
            },
            onError: (error) => {
              show({
                variant: "error",
                title: t("academicGrading.scales.deleteFailed"),
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

function ScaleEditor({
  ctx,
  scale,
  onClose,
}: {
  ctx: SetupContext;
  scale: GradeScale | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const save = useSaveGradeScale();
  const readOnly = !ctx.can.manage || !ctx.configEditable;
  const [name, setName] = useState(scale?.name ?? "");
  const [bands, setBands] = useState<BandDraft[]>(() =>
    scale
      ? [...scale.bands]
          .sort((a, b) => b.min_percentage - a.min_percentage)
          .map((band) => ({
            key: newKey("band"),
            label: band.label,
            min: String(band.min_percentage),
            gpa: band.gpa_points === null ? "" : String(band.gpa_points),
          }))
      : DEFAULT_BANDS.map(([label, min]) => ({ key: newKey("band"), label, min, gpa: "" })),
  );
  const issues = useMemo(
    () =>
      validateGradeScale(
        bands.map((band) => ({
          label: band.label,
          minPercentage: band.min.trim() === "" ? Number.NaN : Number(band.min),
          gpaPoints: band.gpa.trim() === "" ? null : Number(band.gpa),
        })),
      ),
    [bands],
  );
  const incomplete =
    name.trim() === "" ||
    bands.some(
      (band) =>
        band.label.trim() === "" || !Number.isFinite(Number(band.min)) || band.min.trim() === "",
    );

  const patchBand = (key: string, changes: Partial<BandDraft>) =>
    setBands((prev) => prev.map((band) => (band.key === key ? { ...band, ...changes } : band)));

  function submit() {
    save.mutate(
      {
        yearId: ctx.year.id,
        scaleId: scale?.id ?? null,
        body: {
          name: name.trim(),
          bands: bands.map((band) => ({
            label: band.label.trim(),
            min_percentage: Number(band.min),
            gpa_points: band.gpa.trim() === "" ? null : Number(band.gpa),
          })),
        },
      },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("academicGrading.scales.saved") });
          onClose();
        },
      },
    );
  }

  return (
    <section className="ag-editor" aria-labelledby="ag-scale-editor-heading">
      <div className="ag-head">
        <h2 id="ag-scale-editor-heading">
          {scale
            ? t("academicGrading.scales.editTitle", { name: scale.name })
            : t("academicGrading.scales.add")}
        </h2>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("academicGrading.editor.back")}
        </Button>
      </div>
      <fieldset className="ag-fieldset" disabled={readOnly}>
        <legend>{t("academicGrading.scales.bands")}</legend>
        <Input
          label={t("academicGrading.scales.name")}
          value={name}
          required
          onChange={(event) => setName(event.target.value)}
        />
        <p className="ag-muted">{t("academicGrading.scales.bandsHelp")}</p>
        {bands.map((band, index) => (
          <div
            key={band.key}
            className="ag-row ag-grid ag-grid--dense"
            role="group"
            aria-label={t("academicGrading.scales.bandN", { n: index + 1 })}
          >
            <Input
              label={t("academicGrading.scales.label")}
              value={band.label}
              required
              onChange={(event) => patchBand(band.key, { label: event.target.value })}
            />
            <Input
              label={t("academicGrading.scales.min")}
              type="number"
              min={0}
              max={100}
              suffix="%"
              value={band.min}
              required
              onChange={(event) => patchBand(band.key, { min: event.target.value })}
            />
            <Input
              label={t("academicGrading.scales.gpa")}
              type="number"
              min={0}
              value={band.gpa}
              onChange={(event) => patchBand(band.key, { gpa: event.target.value })}
            />
            <div className="ag-row__actions">
              <Button
                type="button"
                variant="tertiary"
                disabled={bands.length <= 1}
                aria-label={t("academicGrading.scales.removeBand", { n: index + 1 })}
                onClick={() => setBands((prev) => prev.filter((b) => b.key !== band.key))}
              >
                {t("academicGrading.common.remove")}
              </Button>
            </div>
          </div>
        ))}
        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            setBands((prev) => [...prev, { key: newKey("band"), label: "", min: "", gpa: "" }])
          }
        >
          {t("academicGrading.scales.addBand")}
        </Button>
      </fieldset>
      <section className="ag-card ag-check" aria-label={t("academicGrading.editor.check")}>
        {issues.length === 0 ? (
          <p>{t("academicGrading.scales.valid")}</p>
        ) : (
          <ul className="ag-issues">
            {issues.map((issue, index) => (
              <li key={`${issue.code}-${index}`} className="ag-issues__item">
                <SeverityBadge severity={issue.severity} /> <span>{issue.message}</span>
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
          <Button type="button" loading={save.isPending} disabled={incomplete} onClick={submit}>
            {t("academicGrading.scales.save")}
          </Button>
        )}
      </div>
    </section>
  );
}
