import { PERMISSIONS } from "@studafy/constants";
import { Card } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { usePermissions } from "../../../lib/auth";
import { useTranslation } from "../../../lib/i18n";
import {
  fetchStudent,
  fetchStudentGuardians,
  studentGuardiansQueryKey,
  studentQueryKey,
} from "../../admin/students/queries";
import { RecordsPanel } from "../../records/RecordsPanel";
import { studentDisplayName } from "../school/queries";

import "../school/principal-school.css";

/**
 * One student from Principal > Students (`/portal/principal/students/:studentId`): who they are,
 * their school-defined record (which a principal fills in and corrects, and whose sensitive values
 * they may reveal), and their guardians, each opening that parent's record. Everything else stays
 * read-only as on the roll: no admission data, no enrolment changes — those are the admin's.
 */
export default function PrincipalStudentPage() {
  const { t } = useTranslation();
  const { studentId } = useParams<{ studentId: string }>();
  const permissions = usePermissions();
  const canReadRecords = permissions.has(PERMISSIONS.STUDENT_RECORD_READ);

  const student = useQuery({
    queryKey: studentQueryKey(studentId ?? ""),
    queryFn: () => fetchStudent(studentId!),
    enabled: Boolean(studentId),
  });
  const guardians = useQuery({
    queryKey: studentGuardiansQueryKey(studentId ?? ""),
    queryFn: () => fetchStudentGuardians(studentId!),
    enabled: Boolean(studentId),
  });

  if (!studentId) return <p role="alert">{t("records.principal.studentLoadError")}</p>;
  if (student.isPending) return <p role="status">{t("principal.common.loading")}</p>;
  if (student.isError) return <p role="alert">{t("records.principal.studentLoadError")}</p>;

  const profile = student.data;
  return (
    <>
      <p>
        <Link to="/portal/principal/students">{t("records.principal.backToStudents")}</Link>
      </p>
      <h1>{studentDisplayName(profile) || t("records.principal.studentFallback")}</h1>
      <p>
        {t("records.principal.statusLabel")}:{" "}
        {t(`principal.students.status.${profile.status}`, profile.status)}
      </p>

      <div className="records-page__sections">
        {canReadRecords ? (
          <RecordsPanel
            subject={{ kind: "student", id: profile.id }}
            canEdit={permissions.has(PERMISSIONS.STUDENT_RECORD_UPDATE)}
            canRevealSensitive={permissions.has(PERMISSIONS.STUDENT_RECORD_READ_SENSITIVE)}
          />
        ) : null}

        <Card as="section" aria-label={t("records.principal.guardians")}>
          <Card.Header>
            <h2>{t("records.principal.guardians")}</h2>
          </Card.Header>
          <Card.Body>
            {guardians.isPending ? (
              <p role="status">{t("principal.common.loading")}</p>
            ) : guardians.isError ? (
              <p role="alert">{t("records.principal.guardiansLoadError")}</p>
            ) : guardians.data.length === 0 ? (
              <p>{t("records.principal.noGuardians")}</p>
            ) : (
              <ul>
                {guardians.data.map((guardian) => {
                  const name =
                    guardian.user?.display_name ??
                    guardian.user?.email ??
                    t("records.principal.parentFallback");
                  return (
                    <li key={guardian.parent_user_id}>
                      {canReadRecords ? (
                        <Link
                          to={`/portal/principal/parents/${guardian.parent_user_id}?student=${profile.id}`}
                          aria-label={t("records.principal.openParentRecords", { name })}
                        >
                          {name}
                        </Link>
                      ) : (
                        name
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card.Body>
        </Card>
      </div>
    </>
  );
}
