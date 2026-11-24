import { Button, Input, Modal, useToast } from "@studafy/ui";
import { useState } from "react";

import { apiErrorDescription } from "../../../lib/api-error";
import { useTranslation } from "../../../lib/i18n";

import { useUpdateScholarship } from "./scholarships-api";

import type { Scholarship } from "./scholarships-api";
import type { FormEvent } from "react";

/**
 * Renames or re-describes a scholarship. The discount (type, value, currency, fee category) is
 * fixed once created, since approved awards already discount invoices with it; the dialog says so.
 */
export function ScholarshipEditModal({
  scholarship,
  onClose,
}: {
  scholarship: Scholarship;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const update = useUpdateScholarship();
  const [name, setName] = useState(scholarship.name);
  const [description, setDescription] = useState(scholarship.description ?? "");
  const [nameError, setNameError] = useState<string>();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setNameError(t("financeReports.adjustments.scholarships.form.nameRequired"));
      return;
    }
    update.mutate(
      { id: scholarship.id, name: name.trim(), description: description.trim() },
      {
        onSuccess: () => {
          show({
            variant: "success",
            title: t("financeReports.adjustments.scholarships.savedToast"),
          });
          onClose();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("financeReports.adjustments.scholarships.saveError"),
            description: apiErrorDescription(error, t),
          }),
      },
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t("financeReports.adjustments.scholarships.editTitle")}
      description={t("financeReports.adjustments.scholarships.editNote")}
    >
      <form onSubmit={handleSubmit} noValidate>
        <Modal.Body>
          <div className="adjustments-form">
            <Input
              label={t("financeReports.adjustments.scholarships.form.name")}
              value={name}
              required
              maxLength={120}
              error={nameError}
              onChange={(event) => {
                setName(event.target.value);
                setNameError(undefined);
              }}
            />
            <Input
              label={t("financeReports.adjustments.scholarships.descriptionLabel")}
              value={description}
              maxLength={1000}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={onClose}>
            {t("financeReports.adjustments.common.cancel")}
          </Button>
          <Button type="submit" loading={update.isPending}>
            {t("financeReports.adjustments.scholarships.save")}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
