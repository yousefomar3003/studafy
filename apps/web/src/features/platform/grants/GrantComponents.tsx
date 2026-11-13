import { ApiError } from "@studafy/api-client";
import { Button, DataGrid, Input, Modal, Select, useToast } from "@studafy/ui";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { useTiersQuery } from "../licensing/queries";

import {
  GIB,
  STORAGE_PRESETS,
  endAfterMonths,
  fetchGrantReceiptUrl,
  toMinor,
  useCreateGrant,
  useRevokeGrant,
} from "./queries";

import type { ManualGrant } from "./queries";
import type { DataGridColumn, SelectOption } from "@studafy/ui";

export type GrantAudience = "student" | "teacher" | "parent";

/** Who a tier grant is for: a person found through the user lookup. */
export interface TierGrantTarget {
  schoolId: string;
  schoolName: string;
  userId: string;
  userLabel: string;
  audiences: readonly GrantAudience[];
}

/** The audiences a person can hold a tier in, from their roles. */
export function audiencesFromRoles(roles: readonly string[]): GrantAudience[] {
  const audiences: GrantAudience[] = [];
  if (roles.includes("STUDENT")) audiences.push("student");
  if (roles.includes("INSTRUCTOR")) audiences.push("teacher");
  if (roles.includes("PARENT")) audiences.push("parent");
  return audiences;
}

/** "100 GB", "1 TB": storage sizes as the console shows them. */
export function useStorageSize() {
  const { formatNumber } = useFormatters();
  return (bytes: number) =>
    bytes >= 1024 * GIB && bytes % (1024 * GIB) === 0
      ? `${formatNumber(bytes / (1024 * GIB))} TB`
      : `${formatNumber(Math.round((bytes / GIB) * 10) / 10)} GB`;
}

function errorDetail(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.detail ?? error.title) : undefined;
}

type SizeChoice = keyof typeof STORAGE_PRESETS | "custom";

/**
 * Grant storage to a school, or a paid tier to one person. Both record why and, optionally, what was
 * paid and the receipt. The grant starts now and runs for the chosen number of months.
 */
export function GrantDialog({
  open,
  onClose,
  schoolId,
  schoolName,
  tierTarget,
}: {
  open: boolean;
  onClose: () => void;
  schoolId: string;
  schoolName: string;
  /** Set for a tier grant; storage otherwise. */
  tierTarget?: TierGrantTarget | null;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const create = useCreateGrant();
  const tiers = useTiersQuery();
  const size = useStorageSize();
  const isTier = Boolean(tierTarget);

  const [sizeChoice, setSizeChoice] = useState<SizeChoice>("100gb");
  const [customGb, setCustomGb] = useState("20");
  const [planCode, setPlanCode] = useState("");
  const [months, setMonths] = useState("12");
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [receipt, setReceipt] = useState<File | null>(null);

  const tierOptions: SelectOption[] = useMemo(
    () =>
      (tiers.data ?? [])
        .filter((tier) => tier.isActive && tierTarget?.audiences.includes(tier.audience))
        .map((tier) => ({
          value: tier.code,
          label: `${tier.displayName} · ${t(`platformLicensing.audience.${tier.audience}`)}`,
        })),
    [tiers.data, tierTarget, t],
  );

  const monthsValue = Number(months);
  const monthsValid = Number.isInteger(monthsValue) && monthsValue >= 1 && monthsValue <= 120;
  const customBytes = Math.round(Number(customGb) * GIB);
  const capBytes = sizeChoice === "custom" ? customBytes : STORAGE_PRESETS[sizeChoice];
  const capValid =
    sizeChoice !== "custom" || (Number(customGb) > 0 && Number.isFinite(customBytes));
  const amountMinor = amount.trim() === "" ? null : toMinor(amount);
  const amountValid = amount.trim() === "" || amountMinor !== null;
  const currencyValid = amount.trim() === "" || /^[A-Z]{3}$/.test(currency.trim());
  const canSubmit =
    reason.trim().length >= 3 &&
    monthsValid &&
    amountValid &&
    currencyValid &&
    (isTier ? planCode !== "" : capValid);

  function close() {
    setSizeChoice("100gb");
    setCustomGb("20");
    setPlanCode("");
    setMonths("12");
    setReason("");
    setAmount("");
    setCurrency("USD");
    setReceipt(null);
    onClose();
  }

  function submit() {
    if (!canSubmit) return;
    const payment =
      amountMinor !== null ? { amountMinor, currencyCode: currency.trim().toUpperCase() } : {};
    create.mutate(
      {
        schoolId,
        receipt,
        body: {
          ...(isTier
            ? { kind: "tier" as const, userId: tierTarget!.userId, planCode }
            : { kind: "storage" as const, capBytes }),
          endsAt: endAfterMonths(monthsValue),
          reason: reason.trim(),
          ...payment,
        },
      },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("platformLicensing.grants.created") });
          close();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("platformLicensing.grants.createError"),
            description: errorDetail(error),
          }),
      },
    );
  }

  const sizeOptions: SelectOption<SizeChoice>[] = [
    { value: "100gb", label: size(STORAGE_PRESETS["100gb"]) },
    { value: "1tb", label: size(STORAGE_PRESETS["1tb"]) },
    { value: "custom", label: t("platformLicensing.grants.customSize") },
  ];

  return (
    <Modal
      open={open}
      onClose={close}
      title={
        isTier
          ? t("platformLicensing.grants.tierTitle")
          : t("platformLicensing.grants.storageTitle")
      }
      description={isTier ? `${tierTarget!.userLabel} · ${schoolName}` : schoolName}
    >
      <Modal.Body>
        <p className="platform-muted">
          {isTier
            ? t("platformLicensing.grants.tierExplain")
            : t("platformLicensing.grants.storageExplain")}
        </p>
        {isTier ? (
          tierOptions.length === 0 && !tiers.isPending ? (
            <p role="alert">{t("platformLicensing.grants.noTiers")}</p>
          ) : (
            <Select
              label={t("platformLicensing.grants.tierLabel")}
              options={tierOptions}
              value={planCode || undefined}
              placeholder={t("platformLicensing.grants.tierPlaceholder")}
              onChange={setPlanCode}
              required
            />
          )
        ) : (
          <>
            <Select
              label={t("platformLicensing.grants.sizeLabel")}
              options={sizeOptions}
              value={sizeChoice}
              onChange={setSizeChoice}
            />
            {sizeChoice === "custom" ? (
              <Input
                label={t("platformLicensing.grants.customGbLabel")}
                type="number"
                min={1}
                value={customGb}
                onChange={(event) => setCustomGb(event.target.value)}
                error={capValid ? undefined : t("platformLicensing.grants.customGbError")}
              />
            ) : null}
          </>
        )}
        <Input
          label={t("platformLicensing.grants.monthsLabel")}
          helperText={t("platformLicensing.grants.monthsHelp")}
          type="number"
          min={1}
          max={120}
          value={months}
          onChange={(event) => setMonths(event.target.value)}
          error={monthsValid ? undefined : t("platformLicensing.grants.monthsError")}
        />
        <Input
          label={t("platformLicensing.grants.reasonLabel")}
          helperText={t("platformLicensing.grants.reasonHelp")}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          required
        />
        <div className="platform-actions">
          <Input
            label={t("platformLicensing.grants.amountLabel")}
            helperText={t("platformLicensing.grants.amountHelp")}
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            error={amountValid ? undefined : t("platformLicensing.grants.amountError")}
          />
          <Input
            label={t("platformLicensing.grants.currencyLabel")}
            value={currency}
            maxLength={3}
            onChange={(event) => setCurrency(event.target.value.toUpperCase())}
            error={currencyValid ? undefined : t("platformLicensing.grants.currencyError")}
          />
        </div>
        <label className="platform-file">
          <span>{t("platformLicensing.grants.receiptLabel")}</span>
          <input
            type="file"
            accept="application/pdf,image/jpeg,image/png"
            onChange={(event) => setReceipt(event.target.files?.[0] ?? null)}
          />
        </label>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={close}>
          {t("platform.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={!canSubmit}
          loading={create.isPending}
          onClick={submit}
        >
          {t("platformLicensing.grants.confirm")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

/** Revoke a grant now, with a reason. */
export function RevokeGrantDialog({
  grant,
  onClose,
}: {
  grant: ManualGrant | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const revoke = useRevokeGrant();
  const [reason, setReason] = useState("");

  function close() {
    setReason("");
    onClose();
  }

  function submit() {
    if (!grant || reason.trim().length < 3) return;
    revoke.mutate(
      { schoolId: grant.schoolId, grantId: grant.id, reason: reason.trim() },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("platformLicensing.grants.revoked") });
          close();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("platformLicensing.grants.revokeError"),
            description: errorDetail(error),
          }),
      },
    );
  }

  return (
    <Modal
      open={grant !== null}
      onClose={close}
      title={t("platformLicensing.grants.revokeTitle")}
      description={grant?.schoolName}
    >
      <Modal.Body>
        <p>{t("platformLicensing.grants.revokeExplain")}</p>
        <Input
          label={t("platformLicensing.grants.reasonLabel")}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          required
        />
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={close}>
          {t("platform.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={reason.trim().length < 3}
          loading={revoke.isPending}
          onClick={submit}
        >
          {t("platformLicensing.grants.revoke")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

/** The grants table, shared by a school's card and the Manual grants page. */
export function GrantsTable({
  grants,
  loading,
  empty,
  caption,
  showSchool,
}: {
  grants: readonly ManualGrant[];
  loading: boolean;
  empty: string;
  caption: string;
  showSchool: boolean;
}) {
  const { t } = useTranslation();
  const { formatCurrency, formatDate } = useFormatters();
  const { show } = useToast();
  const size = useStorageSize();
  const [revoking, setRevoking] = useState<ManualGrant | null>(null);
  const day = (value: string) => formatDate(new Date(value), { dateStyle: "medium" });

  async function openReceipt(grant: ManualGrant) {
    try {
      window.open(await fetchGrantReceiptUrl(grant.schoolId, grant.id), "_blank", "noopener");
    } catch (error) {
      show({
        variant: "error",
        title: t("platformLicensing.grants.receiptError"),
        description: errorDetail(error),
      });
    }
  }

  const columns: DataGridColumn<ManualGrant>[] = [
    ...(showSchool
      ? [
          {
            id: "school",
            header: t("platformLicensing.grants.columns.school"),
            renderCell: (grant: ManualGrant) => (
              <Link to={`/portal/platform/schools/${grant.schoolId}`}>{grant.schoolName}</Link>
            ),
          },
        ]
      : []),
    {
      id: "what",
      header: t("platformLicensing.grants.columns.what"),
      renderCell: (grant) =>
        grant.kind === "storage" ? (
          t("platformLicensing.grants.storageWhat", { size: size(grant.capBytes ?? 0) })
        ) : (
          <div className="platform-cell-stack">
            <span>{grant.planName ?? grant.planCode}</span>
            <span className="platform-muted">{grant.userName ?? grant.userEmail ?? "—"}</span>
          </div>
        ),
    },
    {
      id: "period",
      header: t("platformLicensing.grants.columns.period"),
      renderCell: (grant) =>
        t("platformLicensing.grants.period", {
          start: day(grant.startsAt),
          end: day(grant.endsAt),
        }),
    },
    {
      id: "state",
      header: t("platformLicensing.grants.columns.state"),
      renderCell: (grant) => (
        <span
          className="platform-pill"
          data-status={grant.state === "active" ? "active" : "archived"}
        >
          {t(`platformLicensing.grants.state.${grant.state}`)}
        </span>
      ),
    },
    {
      id: "paid",
      header: t("platformLicensing.grants.columns.paid"),
      renderCell: (grant) =>
        grant.amountMinor !== null && grant.currencyCode
          ? formatCurrency(grant.amountMinor / 10 ** (grant.minorUnit ?? 2), grant.currencyCode)
          : t("platformLicensing.grants.free"),
    },
    {
      id: "reason",
      header: t("platformLicensing.grants.columns.reason"),
      renderCell: (grant) => (
        <div className="platform-cell-stack">
          <span>{grant.reason}</span>
          {grant.revokeReason ? (
            <span className="platform-muted">
              {t("platformLicensing.grants.revokedBecause", { reason: grant.revokeReason })}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      id: "actions",
      header: t("platformLicensing.grants.columns.actions"),
      renderCell: (grant) => (
        <div className="platform-actions">
          {grant.hasReceipt ? (
            <Button type="button" variant="tertiary" onClick={() => void openReceipt(grant)}>
              {t("platformLicensing.grants.receipt")}
            </Button>
          ) : null}
          {grant.state === "active" || grant.state === "scheduled" ? (
            <Button type="button" variant="secondary" onClick={() => setRevoking(grant)}>
              {t("platformLicensing.grants.revoke")}
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <>
      <DataGrid
        caption={caption}
        columns={columns}
        rows={grants}
        getRowId={(grant) => grant.id}
        getRowLabel={(grant) => `${grant.schoolName} · ${grant.kind}`}
        loading={loading}
        empty={empty}
      />
      <RevokeGrantDialog grant={revoking} onClose={() => setRevoking(null)} />
    </>
  );
}
