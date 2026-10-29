import { PERMISSIONS } from "@studafy/constants";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { usePermissions } from "../../lib/auth";
import { useTranslation } from "../../lib/i18n";

import { fetchParentIdentity, parentIdentityQueryKey } from "./queries";
import { RecordsPanel } from "./RecordsPanel";

export interface ParentRecordsViewProps {
  parentUserId: string;
  /** Where the back link goes, and what it says. */
  back: { to: string; label: string };
  /** Translation keys for the heading ("{{name}}: records") and its fallbacks. */
  copy: { title: string; fallback: string; loadError: string };
}

/**
 * A parent's school-defined record on its own page: the admin's (`/portal/admin/parents/…`) and the
 * principal's (`/portal/principal/parents/…`). What the caller may do follows their permissions.
 */
export function ParentRecordsView({ parentUserId, back, copy }: ParentRecordsViewProps) {
  const { t } = useTranslation();
  const permissions = usePermissions();
  const parent = useQuery({
    queryKey: parentIdentityQueryKey(parentUserId),
    queryFn: () => fetchParentIdentity(parentUserId),
  });

  if (parent.isPending) return <p role="status">{t("records.panel.loading")}</p>;
  if (parent.isError) return <p role="alert">{t(copy.loadError)}</p>;

  const name = parent.data.display_name ?? parent.data.email ?? t(copy.fallback);
  return (
    <>
      <p>
        <Link to={back.to}>{back.label}</Link>
      </p>
      <h1>{t(copy.title, { name })}</h1>
      <RecordsPanel
        subject={{ kind: "parent", id: parentUserId }}
        canEdit={permissions.has(PERMISSIONS.STUDENT_RECORD_UPDATE)}
        canRevealSensitive={permissions.has(PERMISSIONS.STUDENT_RECORD_READ_SENSITIVE)}
      />
    </>
  );
}
