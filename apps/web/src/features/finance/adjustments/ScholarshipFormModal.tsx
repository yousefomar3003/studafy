import { ApiError } from "@studafy/api-client";
import { Button, Input, Modal, Select, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../../../lib/api";
import { useTranslation } from "../../../lib/i18n";
import { FinanceStudentPicker } from "../students/FinanceStudentPicker";

import { useCreateScholarship } from "./scholarships-api";

import type { CreateScholarshipBody } from "./scholarships-api";
import type { StudentIdentity } from "../students/FinanceStudentPicker";
import type { components } from "@studafy/api-client";
import type { FormEvent } from "react";

export interface ScholarshipFormModalProps {
  open: boolean;
  onClose: () => void;
}

type CurrencyOption = components["schemas"]["CurrenciesResponse"]["currencies"][number];

type Errors = Partial<Record<"name" | "value" | "currency", string>>;

/**
 * New scholarship: a percentage or a fixed amount, optionally limited to one fee category. The
 * discount is fixed once created (the API only lets it be renamed or deactivated), so an approved
 * award always means what the school admin approved. Remount with a fresh `key` to reset the form.
 */
export function ScholarshipFormModal({ open, onClose }: ScholarshipFormModalProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const create = useCreateScholarship();
  const [name, setName] = useState("");
  const [discountType, setDiscountType] = useState<"percentage" | "fixed">("percentage");
  const [value, setValue] = useState("");
  const [currency, setCurrency] = useState("");
  const [feeCategory, setFeeCategory] = useState("");
  const [students, setStudents] = useState<StudentIdentity[]>([]);
  const [errors, setErrors] = useState<Errors>({});

  const currencies = useQuery({
    queryKey: ["lookups", "currencies"],
    queryFn: async () => {
      const { data } = await api.GET("/api/lookups/currencies");
      return data?.currencies ?? [];
    },
    enabled: open && discountType === "fixed",
  });

  function validate(): Errors {
    const next: Errors = {};
    const amount = Number(value);
    if (!name.trim()) next.name = t("financeReports.adjustments.scholarships.form.nameRequired");
    if (!value.trim() || !Number.isFinite(amount) || amount <= 0) {
      next.value = t("financeReports.adjustments.scholarships.form.valueInvalid");
    } else if (discountType === "percentage" && amount > 100) {
      next.value = t("financeReports.adjustments.scholarships.form.percentageTooHigh");
    }
    if (discountType === "fixed" && !currency) {
      next.currency = t("financeReports.adjustments.scholarships.form.currencyRequired");
    }
    return next;
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const amount = Number(value);
    const body: CreateScholarshipBody = {
      name: name.trim(),
      discount_type: discountType,
      ...(discountType === "percentage"
        ? { percentage: Math.round(amount * 100) / 100 }
        : { amount, currency }),
      ...(feeCategory.trim() ? { fee_category: feeCategory.trim() } : {}),
    };
    create.mutate(
      { body, studentIds: students.map((student) => student.id) },
      {
        onSuccess: ({ requested, failed }) => {
          show({
            variant: "success",
            title: t("financeReports.adjustments.scholarships.form.createdToast"),
            description:
              requested > 0
                ? t("financeReports.adjustments.scholarships.form.awardsRequested", {
                    count: requested,
                  })
                : undefined,
          });
          if (failed > 0) {
            show({
              variant: "error",
              title: t("financeReports.adjustments.scholarships.form.awardsFailed", {
                count: failed,
              }),
            });
          }
          onClose();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("financeReports.adjustments.scholarships.form.createError"),
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          }),
      },
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("financeReports.adjustments.scholarships.form.title")}
      description={t("financeReports.adjustments.scholarships.form.description")}
    >
      <form onSubmit={handleSubmit} noValidate>
        <Modal.Body>
          <div className="adjustments-form">
            <Input
              label={t("financeReports.adjustments.scholarships.form.name")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              error={errors.name}
              required
            />
            <Select
              label={t("financeReports.adjustments.scholarships.form.type")}
              options={[
                {
                  value: "percentage",
                  label: t("financeReports.adjustments.scholarships.form.typePercentage"),
                },
                {
                  value: "fixed",
                  label: t("financeReports.adjustments.scholarships.form.typeFixed"),
                },
              ]}
              value={discountType}
              onChange={(next) => setDiscountType(next as "percentage" | "fixed")}
            />
            <Input
              label={
                discountType === "percentage"
                  ? t("financeReports.adjustments.scholarships.form.percentage")
                  : t("financeReports.adjustments.scholarships.form.amount")
              }
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              error={errors.value}
              required
            />
            {discountType === "fixed" ? (
              <Select
                label={t("financeReports.adjustments.scholarships.form.currency")}
                placeholder={t("financeReports.adjustments.scholarships.form.selectCurrency")}
                options={((currencies.data as readonly CurrencyOption[] | undefined) ?? []).map(
                  (c) => ({
                    value: c.code,
                    label: c.code,
                  }),
                )}
                value={currency || undefined}
                onChange={setCurrency}
                disabled={currencies.isPending}
                error={errors.currency}
                required
              />
            ) : null}
            <Input
              label={t("financeReports.adjustments.scholarships.form.feeCategory")}
              value={feeCategory}
              onChange={(e) => setFeeCategory(e.target.value)}
              helperText={t("financeReports.adjustments.scholarships.form.feeCategoryHelper")}
            />
            <FinanceStudentPicker
              multiple
              label={t("financeReports.adjustments.scholarships.form.students")}
              helperText={t("financeReports.adjustments.scholarships.form.studentsHelper")}
              selected={students}
              onChange={setStudents}
            />
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={onClose}>
            {t("financeReports.adjustments.common.cancel")}
          </Button>
          <Button type="submit" loading={create.isPending}>
            {t("financeReports.adjustments.scholarships.form.submit")}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
