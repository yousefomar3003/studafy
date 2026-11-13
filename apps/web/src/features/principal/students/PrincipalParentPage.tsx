import { PERMISSIONS } from "@studafy/constants";
import { useParams, useSearchParams } from "react-router-dom";

import { usePermissions } from "../../../lib/auth";
import { useTranslation } from "../../../lib/i18n";
import { ParentRecordsView } from "../../records/ParentRecordsView";
import { ParentDetailsCard } from "../../records/parents/ParentDetailsCard";

/**
 * `/portal/principal/parents/:parentUserId`: a guardian's contact details, children and record,
 * reached from Parents or from a student's page in Principal > Students (`?student=` brings the
 * back link home to that student). The contact details need `user:read`.
 */
export default function PrincipalParentPage() {
  const { t } = useTranslation();
  const { parentUserId } = useParams<{ parentUserId: string }>();
  const [searchParams] = useSearchParams();
  const studentId = searchParams.get("student");
  const permissions = usePermissions();
  if (!parentUserId) return <p role="alert">{t("records.principal.parentLoadError")}</p>;
  return (
    <ParentRecordsView
      parentUserId={parentUserId}
      back={studentId ? `/portal/principal/students/${studentId}` : "/portal/principal/parents"}
      details={
        permissions.has(PERMISSIONS.USER_READ) ? (
          <ParentDetailsCard
            parentUserId={parentUserId}
            studentLink={(id) => `/portal/principal/students/${id}`}
          />
        ) : null
      }
      copy={{
        title: "records.principal.parentTitle",
        fallback: "records.principal.parentFallback",
        loadError: "records.principal.parentLoadError",
      }}
    />
  );
}
