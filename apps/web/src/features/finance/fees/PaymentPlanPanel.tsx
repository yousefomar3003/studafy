import { ApiError } from "@studafy/api-client";
import { Button, Card, Input, Select, useToast } from "@studafy/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../../../lib/api";
import { useTranslation } from "../../../lib/i18n";

import type { FeeStructure } from "./queries";
import type { StudentIdentity } from "../students/FinanceStudentPicker";
import type { SelectOption } from "@studafy/ui";
import type { FormEvent } from "react";

type ScheduleType = "monthly" | "quarterly" | "term_wise" | "yearly";

const SCHEDULE_TYPES: ScheduleType[] = ["term_wise", "monthly", "quarterly", "yearly"];
const MAX_DUE_DATES = 12;

export interface PaymentPlanPanelProps {
  structure: FeeStructure;
}

/**
 * Splits a submitted fee structure into installments for the students it is for
 * (`POST /api/finance/fee-schedules/generate`, `billing:update`). ERPNext divides the total over
 * the due dates by the schedule type; the installments then show on each student's account, the
 * overdue list and the dashboard. Only a submitted structure can be scheduled, and only for the
 * students saved on it, so the panel says so instead of offering a request ERPNext would refuse.
 */
export function PaymentPlanPanel({ structure }: PaymentPlanPanelProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const queryClient = useQueryClient();
  const [scheduleType, setScheduleType] = useState<ScheduleType>("term_wise");
  const [dueDates, setDueDates] = useState<string[]>([""]);
  const [created, setCreated] = useState<number | null>(null);

  const students = useQuery({
    queryKey: ["finance", "fee-structures", structure.erpnext_name, "students"],
    queryFn: async () => {
      const { data } = await api.GET("/api/finance/fee-structures/{feeStructureId}/students", {
        params: { path: { feeStructureId: structure.erpnext_name } },
      });
      return (data?.students ?? []) as StudentIdentity[];
    },
  });
  const studentIds = (students.data ?? []).map((student) => student.id);

  const generate = useMutation({
    mutationFn: async () => {
      const { data } = await api.POST("/api/finance/fee-schedules/generate", {
        body: {
          fee_structure: structure.erpnext_name,
          student_ids: studentIds,
          due_dates: [...dueDates].sort(),
          schedule_type: scheduleType,
          academic_year_id: structure.academic_year_id ?? undefined,
          program: structure.program ?? undefined,
        },
      });
      if (!data) throw new Error("Generating the plan returned no data.");
      return data.total;
    },
    onSuccess: (total) => {
      setCreated(total);
      show({ variant: "success", title: t("finance.fees.plan.createdToast", { count: total }) });
      void queryClient.invalidateQueries({ queryKey: ["finance", "students"] });
    },
    onError: (error) =>
      show({
        variant: "error",
        title: t("finance.fees.plan.error"),
        description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
      }),
  });

  const filledDates = dueDates.filter((date) => date !== "");
  const duplicate = new Set(filledDates).size !== filledDates.length;
  const canGenerate =
    structure.erpnext_status === "submitted" &&
    studentIds.length > 0 &&
    filledDates.length === dueDates.length &&
    !duplicate;

  const typeOptions: SelectOption<ScheduleType>[] = SCHEDULE_TYPES.map((value) => ({
    value,
    label: t(`finance.fees.plan.scheduleType.${value}`),
  }));

  function setDate(index: number, value: string) {
    setDueDates((dates) => dates.map((date, i) => (i === index ? value : date)));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (canGenerate) generate.mutate();
  }

  return (
    <div className="fee-builder__plan">
      <Card as="section" aria-label={t("finance.fees.plan.title")}>
        <Card.Body>
          <h2>{t("finance.fees.plan.title")}</h2>
          <p>{t("finance.fees.plan.intro")}</p>

          {structure.erpnext_status !== "submitted" ? (
            <p role="note">{t("finance.fees.plan.notSubmitted")}</p>
          ) : students.isSuccess && studentIds.length === 0 ? (
            <p role="note">{t("finance.fees.plan.noStudents")}</p>
          ) : (
            <form onSubmit={handleSubmit} className="fee-builder__plan-form">
              <p>{t("finance.fees.plan.forStudents", { count: studentIds.length })}</p>
              <Select
                label={t("finance.fees.plan.scheduleTypeLabel")}
                options={typeOptions}
                value={scheduleType}
                onChange={setScheduleType}
              />
              <fieldset className="fee-builder__plan-dates">
                <legend>{t("finance.fees.plan.dueDates")}</legend>
                {dueDates.map((date, index) => (
                  <div key={index} className="fee-builder__plan-date">
                    <Input
                      type="date"
                      label={t("finance.fees.plan.dueDate", { number: index + 1 })}
                      value={date}
                      onChange={(event) => setDate(index, event.target.value)}
                      required
                    />
                    {dueDates.length > 1 ? (
                      <Button
                        type="button"
                        variant="tertiary"
                        onClick={() => setDueDates((dates) => dates.filter((_, i) => i !== index))}
                      >
                        {t("finance.fees.plan.removeDate")}
                      </Button>
                    ) : null}
                  </div>
                ))}
                {dueDates.length < MAX_DUE_DATES ? (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setDueDates((dates) => [...dates, ""])}
                  >
                    {t("finance.fees.plan.addDate")}
                  </Button>
                ) : null}
                {duplicate ? (
                  <p className="sf-field__error" role="alert">
                    {t("finance.fees.plan.duplicateDate")}
                  </p>
                ) : null}
              </fieldset>
              <Button type="submit" loading={generate.isPending} disabled={!canGenerate}>
                {t("finance.fees.plan.generate")}
              </Button>
            </form>
          )}

          {created !== null ? (
            <p role="status">
              {t("finance.fees.plan.created", { count: created })}{" "}
              <Link to="/portal/finance/overdue">{t("finance.fees.plan.viewOverdue")}</Link>
            </p>
          ) : null}
        </Card.Body>
      </Card>
    </div>
  );
}
