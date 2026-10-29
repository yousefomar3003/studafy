import { useParams, useSearchParams } from "react-router-dom";

import { useTranslation } from "../../../lib/i18n";
import { ParentRecordsView } from "../../records/ParentRecordsView";

/**
 * `/portal/principal/parents/:parentUserId`: a guardian's record, reached from a student's page in
 * Principal > Students (`?student=` brings the back link home to that student).
 */
export default function PrincipalParentPage() {
  const { t } = useTranslation();
  const { parentUserId } = useParams<{ parentUserId: string }>();
  const [searchParams] = useSearchParams();
  const studentId = searchParams.get("student");
  if (!parentUserId) return <p role="alert">{t("records.principal.parentLoadError")}</p>;
  return (
    <ParentRecordsView
      parentUserId={parentUserId}
      back={
        studentId
          ? {
              to: `/portal/principal/students/${studentId}`,
              label: t("records.principal.backToStudent"),
            }
          : { to: "/portal/principal/students", label: t("records.principal.backToStudents") }
      }
      copy={{
        title: "records.principal.parentTitle",
        fallback: "records.principal.parentFallback",
        loadError: "records.principal.parentLoadError",
      }}
    />
  );
}
