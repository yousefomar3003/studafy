import { Button, Card } from "@studafy/ui";
import { useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { GrantDialog, GrantsTable } from "./GrantComponents";
import { useSchoolGrantsQuery } from "./queries";

import "./grants.css";

/**
 * A school's manual grants on its platform page: storage given by hand (a cash payment, a pilot),
 * and the paid tiers given to its people from the user lookup. Grant storage here; revoke either.
 */
export function SchoolGrantsCard({
  schoolId,
  schoolName,
}: {
  schoolId: string;
  schoolName: string;
}) {
  const { t } = useTranslation();
  const grants = useSchoolGrantsQuery(schoolId);
  const [granting, setGranting] = useState(false);

  return (
    <Card as="section" aria-labelledby="platform-grants-title">
      <Card.Header>
        <h2 id="platform-grants-title">{t("platformLicensing.grants.cardTitle")}</h2>
      </Card.Header>
      <Card.Body>
        <p className="platform-muted">{t("platformLicensing.grants.cardDescription")}</p>
        <div className="platform-actions">
          <Button type="button" variant="primary" onClick={() => setGranting(true)}>
            {t("platformLicensing.grants.grantStorage")}
          </Button>
        </div>
        <GrantsTable
          grants={grants.data ?? []}
          loading={grants.isPending}
          empty={
            grants.isError
              ? t("platformLicensing.grants.loadError")
              : t("platformLicensing.grants.emptySchool")
          }
          caption={t("platformLicensing.grants.cardTitle")}
          showSchool={false}
        />
      </Card.Body>
      {granting ? (
        <GrantDialog
          open
          onClose={() => setGranting(false)}
          schoolId={schoolId}
          schoolName={schoolName}
        />
      ) : null}
    </Card>
  );
}
