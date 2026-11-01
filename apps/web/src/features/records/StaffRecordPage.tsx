import { PERMISSIONS } from "@studafy/constants";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { usePermissions } from "../../lib/auth";
import { useTranslation } from "../../lib/i18n";
import { LinkedListsPanel } from "../custom-lists/LinkedListsPanel";

import { fetchStaffIdentity, staffIdentityQueryKey } from "./queries";
import { RecordsPanel } from "./RecordsPanel";

export interface StaffRecordPageProps {
  /** Which portal mounted the page: only the back link differs. */
  portal?: "admin" | "principal";
}

/**
 * A member of staff's school-defined record (`/portal/admin/staff/:staffUserId/records` and
 * `/portal/principal/staff/:staffUserId/records`), gated on `staffRecord:read`. ORG_ADMIN edits
 * it and reveals its sensitive values; a PRINCIPAL reads its non-sensitive fields only -- the API
 * leaves sensitive fields out of a principal's response altogether.
 */
export default function StaffRecordPage({ portal = "admin" }: StaffRecordPageProps) {
  const { t } = useTranslation();
  const permissions = usePermissions();
  const { staffUserId } = useParams<{ staffUserId: string }>();
  const staff = useQuery({
    queryKey: staffIdentityQueryKey(staffUserId ?? ""),
    queryFn: () => fetchStaffIdentity(staffUserId!),
    enabled: Boolean(staffUserId),
  });

  if (!staffUserId) return <p role="alert">{t("records.staff.loadError")}</p>;
  if (staff.isPending) return <p role="status">{t("records.panel.loading")}</p>;
  if (staff.isError) return <p role="alert">{t("records.staff.loadError")}</p>;

  const name = staff.data.display_name ?? staff.data.email ?? t("records.staff.fallback");
  const back =
    portal === "admin"
      ? { to: "/portal/admin/teachers", label: t("records.staff.backToTeachers") }
      : { to: "/portal/principal/records/missing", label: t("records.staff.backToMissing") };
  return (
    <>
      <p>
        <Link to={back.to}>{back.label}</Link>
      </p>
      <h1>{t("records.staff.title", { name })}</h1>
      <RecordsPanel
        subject={{ kind: "staff", id: staffUserId }}
        canEdit={permissions.has(PERMISSIONS.STAFF_RECORD_UPDATE)}
        canRevealSensitive={permissions.has(PERMISSIONS.STAFF_RECORD_READ_SENSITIVE)}
      />
      <LinkedListsPanel subject={{ kind: "staff", id: staffUserId }} />
    </>
  );
}
