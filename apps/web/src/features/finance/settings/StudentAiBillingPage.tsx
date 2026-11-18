import { ApiError } from "@studafy/api-client";
import { PERMISSIONS } from "@studafy/constants";
import { Button, Card, Checkbox, Table, useToast } from "@studafy/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";
import { usePermissions } from "../../../lib/auth";
import { useFormatters, useTranslation } from "../../../lib/i18n";

import "./tax-settings.css";

import type { components } from "@studafy/api-client";

type Settings = components["schemas"]["StudentAiBillingSettings"];
type Line = components["schemas"]["StudentAiFinanceLine"];
type SyncSummary = components["schemas"]["StudentAiSyncSummary"];

export const STUDENT_AI_SETTINGS_KEY = ["finance", "student-ai", "settings"] as const;
export const STUDENT_AI_LINES_KEY = ["finance", "student-ai", "lines"] as const;

const COLUMN_COUNT = 5;

/**
 * The Student AI line on tuition (`/portal/finance/settings/student-ai`, `billing:read`): each
 * opted-in student's "Student AI" fee (parent price per month x months to the end of the academic
 * year), and the school's auto-billing switch (`billing:update`). On, the line is spread over the
 * student's tuition instalments and invoiced with them; off, the school bills it itself and parents
 * still see it, paid with tuition. Either way only what is not yet invoiced changes.
 */
export default function StudentAiBillingPage() {
  const { t } = useTranslation();
  const { show } = useToast();
  const { formatCurrency } = useFormatters();
  const queryClient = useQueryClient();
  const canEdit = usePermissions().has(PERMISSIONS.BILLING_UPDATE);

  const settings = useQuery({
    queryKey: STUDENT_AI_SETTINGS_KEY,
    queryFn: async () => {
      const { data } = await api.GET("/api/finance/student-ai/settings");
      if (!data) throw new Error("Student AI settings returned no data.");
      return data as Settings;
    },
  });

  const lines = useQuery({
    queryKey: STUDENT_AI_LINES_KEY,
    queryFn: async () => {
      const { data } = await api.GET("/api/finance/student-ai/lines", { params: { query: {} } });
      if (!data) throw new Error("Student AI lines returned no data.");
      return (data as { lines: Line[] }).lines;
    },
  });

  const toast = (summary: SyncSummary, title: string) =>
    show({
      variant: "success",
      title,
      description: t("finance.studentAi.syncSummary", {
        created: summary.created,
        updated: summary.updated,
        removed: summary.removed,
      }),
    });

  const onError = (title: string) => (error: unknown) =>
    show({
      variant: "error",
      title,
      description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
    });

  const save = useMutation({
    mutationFn: async (autoBilling: boolean) => {
      const { data } = await api.PUT("/api/finance/student-ai/settings", {
        body: { auto_billing: autoBilling },
      });
      if (!data) throw new Error("Saving Student AI settings returned no data.");
      return data as { settings: Settings; sync: SyncSummary };
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(STUDENT_AI_SETTINGS_KEY, saved.settings);
      void queryClient.invalidateQueries({ queryKey: STUDENT_AI_LINES_KEY });
      toast(saved.sync, t("finance.studentAi.savedToast"));
    },
    onError: onError(t("finance.studentAi.saveError")),
  });

  const recalculate = useMutation({
    mutationFn: async () => {
      const { data } = await api.POST("/api/finance/student-ai/sync");
      if (!data) throw new Error("Recalculating Student AI lines returned no data.");
      return data as SyncSummary;
    },
    onSuccess: (summary) => {
      void queryClient.invalidateQueries({ queryKey: STUDENT_AI_LINES_KEY });
      toast(summary, t("finance.studentAi.recalculatedToast"));
    },
    onError: onError(t("finance.studentAi.recalculateError")),
  });

  if (settings.isPending) return <p role="status">{t("finance.common.loading")}</p>;
  if (settings.isError) return <p role="alert">{t("finance.studentAi.loadError")}</p>;

  const money = (minor: number, line: Line) =>
    formatCurrency(minor / 10 ** line.currency_minor_unit, line.currency);

  return (
    <div className="tax-settings student-ai-billing">
      <div>
        <h1>{t("finance.studentAi.title")}</h1>
        <p>{t("finance.studentAi.intro")}</p>
      </div>

      <Card as="section" aria-label={t("finance.studentAi.billingTitle")}>
        <Card.Body>
          <div className="tax-settings__form">
            <Checkbox
              disabled={!canEdit || save.isPending}
              label={t("finance.studentAi.autoBilling")}
              checked={settings.data.auto_billing}
              onChange={(event) => save.mutate(event.target.checked)}
            />
            <p className="tax-settings__note">
              {settings.data.auto_billing
                ? t("finance.studentAi.autoOn")
                : t("finance.studentAi.autoOff")}
            </p>
            <p className="tax-settings__note">{t("finance.studentAi.notRetroactive")}</p>
            {!canEdit ? <p role="note">{t("finance.studentAi.readOnly")}</p> : null}
            {canEdit ? (
              <div>
                <Button
                  variant="secondary"
                  loading={recalculate.isPending}
                  onClick={() => recalculate.mutate()}
                >
                  {t("finance.studentAi.recalculate")}
                </Button>
              </div>
            ) : null}
          </div>
        </Card.Body>
      </Card>

      <Table caption={t("finance.studentAi.linesTitle")}>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("finance.studentAi.columns.student")}</Table.HeaderCell>
            <Table.HeaderCell>{t("finance.studentAi.columns.line")}</Table.HeaderCell>
            <Table.HeaderCell>{t("finance.studentAi.columns.period")}</Table.HeaderCell>
            <Table.HeaderCell>{t("finance.studentAi.columns.invoiced")}</Table.HeaderCell>
            <Table.HeaderCell>{t("finance.studentAi.columns.planned")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={COLUMN_COUNT}
          loading={lines.isPending}
          empty={lines.isError ? t("finance.studentAi.linesError") : t("finance.studentAi.empty")}
        >
          {(lines.data ?? []).map((line) => (
            <Table.Row key={`${line.student_id}-${line.academic_year_id}`}>
              <Table.Cell>
                {line.student_name}
                {line.admission_number ? ` (${line.admission_number})` : ""}
              </Table.Cell>
              <Table.Cell>
                {t("finance.studentAi.line", {
                  price: money(line.monthly_price_minor, line),
                  count: line.months,
                  total: money(line.total_minor, line),
                })}
              </Table.Cell>
              <Table.Cell>
                {line.stopped_from
                  ? t("finance.studentAi.stoppedFrom", {
                      start: line.start_month,
                      stop: line.stopped_from,
                    })
                  : t("finance.studentAi.period", { start: line.start_month, end: line.end_month })}
              </Table.Cell>
              <Table.Cell>{money(line.invoiced_minor, line)}</Table.Cell>
              <Table.Cell>
                {line.billing === "outside"
                  ? t("finance.studentAi.billedBySchool")
                  : money(line.planned_minor, line)}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
}
