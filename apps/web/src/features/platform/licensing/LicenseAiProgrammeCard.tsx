import { ApiError } from "@studafy/api-client";
import { Button, Card, Input, Modal, useToast } from "@studafy/ui";
import { useState } from "react";
import { Link } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";

import { useFormatProgrammeValue } from "./ai-programme-format";
import { useReapplyLicenseAiProgramme } from "./mutations";
import { useLicenseAiProgrammeQuery } from "./queries";

import type { PlatformLicense } from "./queries";

const P = "platformLicensing.aiProgramme";

/** Statuses whose programme values can still be replaced (the API refuses the others). */
const REAPPLICABLE = new Set(["draft", "awaiting_payment", "active", "suspended"]);

/**
 * The Student AI programme values a licence was signed with (000234): the global version and the
 * school's override version, when they were attached, the grace period they give, and whether newer
 * values exist. "Apply current settings" moves the licence onto the values in force, with a reason.
 */
export function LicenseAiProgrammeCard({
  schoolId,
  license,
}: {
  schoolId: string;
  license: PlatformLicense;
}) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const [applying, setApplying] = useState(false);
  const stamp = license.aiProgramme;
  const canApply = !stamp.current && REAPPLICABLE.has(license.status);

  return (
    <Card as="section" aria-labelledby="license-ai-programme">
      <Card.Header>
        <div className="platform-header__row">
          <h3 id="license-ai-programme">{t(`${P}.licenseTitle`)}</h3>
          <span
            className="platform-pill"
            data-status={stamp.current ? "active" : "pending"}
            data-testid="programme-current"
          >
            {stamp.current ? t(`${P}.upToDate`) : t(`${P}.newerAvailable`)}
          </span>
        </div>
      </Card.Header>
      <Card.Body>
        <dl className="platform-dl">
          <dt>{t(`${P}.signedWith`)}</dt>
          <dd data-testid="programme-version">
            {stamp.overrideVersionNumber === null
              ? t(`${P}.signedVersion`, { version: stamp.versionNumber })
              : t(`${P}.signedVersionWithOverride`, {
                  version: stamp.versionNumber,
                  override: stamp.overrideVersionNumber,
                })}
          </dd>
          <dt>{t(`${P}.appliedAt`)}</dt>
          <dd>{formatDate(new Date(stamp.appliedAt), { dateStyle: "medium" })}</dd>
          <dt>{t(`${P}.field.nonpaymentGraceDays`)}</dt>
          <dd>{t(`${P}.days`, { count: stamp.nonpaymentGraceDays })}</dd>
        </dl>
        <p className="platform-muted">{t(`${P}.licenseHelp`)}</p>
      </Card.Body>
      <Card.Footer>
        <div className="platform-actions">
          <Link to={`/portal/platform/ai-programme?schoolId=${schoolId}`}>
            {t(`${P}.editSchoolSettings`)}
          </Link>
          {canApply ? (
            <Button variant="secondary" onClick={() => setApplying(true)}>
              {t(`${P}.applyCurrent`)}
            </Button>
          ) : null}
        </div>
      </Card.Footer>
      {applying ? (
        <ApplyCurrentModal
          schoolId={schoolId}
          licenseId={license.id}
          onClose={() => setApplying(false)}
        />
      ) : null}
    </Card>
  );
}

function ApplyCurrentModal({
  schoolId,
  licenseId,
  onClose,
}: {
  schoolId: string;
  licenseId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const format = useFormatProgrammeValue();
  const detail = useLicenseAiProgrammeQuery(schoolId, licenseId);
  const reapply = useReapplyLicenseAiProgramme();
  const [reason, setReason] = useState("");
  const data = detail.data;

  function confirm() {
    if (reason.trim() === "") return;
    reapply.mutate(
      { schoolId, licenseId, reason: reason.trim() },
      {
        onSuccess: () => {
          show({ variant: "success", title: t(`${P}.applied`) });
          onClose();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("platformLicensing.common.saveError"),
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          }),
      },
    );
  }

  return (
    <Modal open onClose={onClose} title={t(`${P}.applyTitle`)} description={t(`${P}.applyHelp`)}>
      <Modal.Body>
        {detail.isPending ? <p role="status">{t("site.common.loading")}</p> : null}
        {data ? (
          <>
            <p>
              {t(`${P}.applyFromTo`, {
                from: data.stamp.versionNumber,
                to: data.currentVersionNumber,
              })}
            </p>
            {data.changes.length === 0 ? (
              <p className="platform-muted">{t(`${P}.diff.none`)}</p>
            ) : (
              <table className="platform-table" data-testid="apply-changes">
                <thead>
                  <tr>
                    <th scope="col">{t(`${P}.diff.setting`)}</th>
                    <th scope="col">{t(`${P}.diff.signed`)}</th>
                    <th scope="col">{t(`${P}.diff.current`)}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.changes.map((field) => (
                    <tr key={field}>
                      <td>{t(`${P}.field.${field}`)}</td>
                      <td>{format(field, data.signed[field], data.signed.currencyCode)}</td>
                      <td>{format(field, data.current[field], data.current.currencyCode)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : null}
        <Input
          label={t(`${P}.reasonLabel`)}
          value={reason}
          maxLength={1000}
          onChange={(event) => setReason(event.target.value)}
        />
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("platform.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={reason.trim() === "" || !data}
          loading={reapply.isPending}
          onClick={confirm}
        >
          {t(`${P}.applyConfirm`)}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
