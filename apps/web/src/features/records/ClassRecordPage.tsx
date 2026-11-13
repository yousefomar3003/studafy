import { PERMISSIONS } from "@studafy/constants";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { usePermissions } from "../../lib/auth";
import { useTranslation } from "../../lib/i18n";
import { LinkedListsPanel } from "../custom-lists/LinkedListsPanel";

import { classIdentityQueryKey, fetchClassIdentity } from "./queries";
import { RecordsPanel } from "./RecordsPanel";

export interface ClassRecordPageProps {
  /** Which portal mounted the page. Both go back to the shared Classes page. */
  portal?: "admin" | "principal";
}

/**
 * A class's school-defined record (`/portal/principal/classes/:classId/records` and
 * `/portal/admin/classes/:classId/records`), gated on `classRecord:read`. Whoever keeps the classes
 * (`timetable:manage`) edits it. A class field is never sensitive, so there is nothing to reveal.
 */
export default function ClassRecordPage(_props: ClassRecordPageProps) {
  const { t } = useTranslation();
  const permissions = usePermissions();
  const { classId } = useParams<{ classId: string }>();
  const cls = useQuery({
    queryKey: classIdentityQueryKey(classId ?? ""),
    queryFn: () => fetchClassIdentity(classId!),
    enabled: Boolean(classId),
  });

  if (!classId) return <p role="alert">{t("records.class.loadError")}</p>;
  if (cls.isPending) return <p role="status">{t("records.panel.loading")}</p>;
  if (cls.isError) return <p role="alert">{t("records.class.loadError")}</p>;

  // Both portals' class list is the shared Classes page (ORG_ADMIN holds principalDashboard:view).
  const back = { to: "/portal/principal/classes", label: t("records.class.backToClasses") };
  return (
    <>
      <p>
        <Link to={back.to}>{back.label}</Link>
      </p>
      <h1>{t("records.class.title", { code: cls.data.code })}</h1>
      <RecordsPanel
        subject={{ kind: "class", id: classId }}
        canEdit={permissions.has(PERMISSIONS.TIMETABLE_MANAGE)}
        canRevealSensitive={false}
      />
      <LinkedListsPanel subject={{ kind: "class", id: classId }} />
    </>
  );
}
