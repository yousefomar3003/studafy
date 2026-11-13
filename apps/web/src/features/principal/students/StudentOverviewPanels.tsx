import { PERMISSIONS } from "@studafy/constants";
import { Card, Table } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { api } from "../../../lib/api";
import { usePermissions } from "../../../lib/auth";
import { useFormatters, useTranslation } from "../../../lib/i18n";
import { ResultValue } from "../academic-setup/components";
import {
  DISCIPLINE_SEVERITY_LABEL_KEYS,
  DISCIPLINE_STATUS_LABEL_KEYS,
  DISCIPLINE_TYPE_LABEL_KEYS,
} from "../discipline/labels";

import { TranscriptPanel } from "./transcripts/TranscriptPanel";

import type { DisciplineIncident } from "../discipline/queries";
import type { components } from "@studafy/api-client";

type FinalizedResult = components["schemas"]["GradingStudentResultsResult"];
type Certificate = components["schemas"]["AcademicCertificate"];

const RECENT_INCIDENTS = 10;

/** One student's finalized results, newest first (`GET /api/grading/students/{id}/results`). */
function useStudentResults(studentId: string) {
  return useQuery({
    queryKey: ["principal-student", studentId, "results"],
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/students/{studentId}/results", {
        params: { path: { studentId } },
      });
      return [...((data?.results ?? []) as FinalizedResult[])].sort((a, b) =>
        b.finalized_at.localeCompare(a.finalized_at),
      );
    },
  });
}

function useStudentCertificates(studentId: string) {
  return useQuery({
    queryKey: ["principal-student", studentId, "certificates"],
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/students/{studentId}/certificates", {
        params: { path: { studentId } },
      });
      return [...((data?.certificates ?? []) as Certificate[])].sort((a, b) =>
        b.issued_at.localeCompare(a.issued_at),
      );
    },
  });
}

function useStudentIncidents(studentId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["discipline-incidents", "student", studentId],
    enabled,
    queryFn: async () => {
      const { data } = await api.GET("/api/discipline/incidents", {
        params: { query: { student_id: studentId, limit: RECENT_INCIDENTS, offset: 0 } },
      });
      return {
        incidents: (data?.incidents ?? []) as DisciplineIncident[],
        total: data?.total ?? 0,
      };
    },
  });
}

/**
 * The parts of one student's school life a principal oversees, beside their record and guardians
 * on `PrincipalStudentPage`: finalized results, issued report cards and certificates, discipline
 * history, and a link to their attendance. Each reads its own endpoint, so one failing never hides
 * the others; a panel the session has no permission for is not shown.
 */
export function StudentOverviewPanels({ studentId }: { studentId: string }) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const permissions = usePermissions();
  const canReadDiscipline = permissions.has(PERMISSIONS.DISCIPLINE_INCIDENT_READ);
  const canOpenAttendance = permissions.has(PERMISSIONS.ATTENDANCE_DASHBOARD_VIEW);
  const canOpenCertificates = permissions.has(PERMISSIONS.ACADEMIC_CONFIG_READ);
  const results = useStudentResults(studentId);
  const certificates = useStudentCertificates(studentId);
  const incidents = useStudentIncidents(studentId, canReadDiscipline);

  const day = (iso: string) => formatDate(new Date(iso), { dateStyle: "medium" });

  return (
    <>
      <Card as="section" aria-labelledby="student-results-heading">
        <Card.Header>
          <h2 id="student-results-heading">{t("principal.students.overview.results.heading")}</h2>
        </Card.Header>
        <Card.Body>
          <Table caption={t("principal.students.overview.results.caption")} hideCaption>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>
                  {t("principal.students.overview.results.period")}
                </Table.HeaderCell>
                <Table.HeaderCell>
                  {t("principal.students.overview.results.section")}
                </Table.HeaderCell>
                <Table.HeaderCell>
                  {t("principal.students.overview.results.average")}
                </Table.HeaderCell>
                <Table.HeaderCell>
                  {t("principal.students.overview.results.grade")}
                </Table.HeaderCell>
                <Table.HeaderCell>
                  {t("principal.students.overview.results.outcome")}
                </Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body
              columnCount={5}
              loading={results.isPending}
              empty={
                results.isError
                  ? t("principal.students.overview.results.error")
                  : t("principal.students.overview.results.empty")
              }
            >
              {(results.data ?? []).map((row) => (
                <Table.Row key={row.finalization_id}>
                  <Table.Cell>
                    {row.term_name
                      ? t("principal.students.overview.results.termOf", {
                          term: row.term_name,
                          year: row.academic_year_name,
                        })
                      : t("principal.students.overview.results.annualOf", {
                          year: row.academic_year_name,
                        })}
                  </Table.Cell>
                  <Table.Cell>{`${row.grade_level_name} – ${row.section_name}`}</Table.Cell>
                  <Table.Cell>
                    <ResultValue
                      display={row.result.result_display}
                      percentage={row.result.average_percentage}
                    />
                  </Table.Cell>
                  <Table.Cell>{row.result.grade_label ?? "—"}</Table.Cell>
                  <Table.Cell>
                    {t(`academicGrading.academicStatus.${row.result.academic_status}`)}
                    {row.result.subjects_failed > 0
                      ? ` · ${t("principal.students.overview.results.failed", {
                          count: row.result.subjects_failed,
                        })}`
                      : ""}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </Card.Body>
      </Card>

      <Card as="section" aria-labelledby="student-certificates-heading">
        <Card.Header>
          <h2 id="student-certificates-heading">
            {t("principal.students.overview.certificates.heading")}
          </h2>
        </Card.Header>
        <Card.Body>
          {certificates.isPending ? (
            <p role="status">{t("principal.common.loading")}</p>
          ) : certificates.isError ? (
            <p role="alert">{t("principal.students.overview.certificates.error")}</p>
          ) : certificates.data.length === 0 ? (
            <p>{t("principal.students.overview.certificates.empty")}</p>
          ) : (
            <ul>
              {certificates.data.map((certificate) => {
                const label = t(
                  `principal.students.overview.certificates.kind.${certificate.kind}`,
                  {
                    serial: certificate.serial_number,
                    date: day(certificate.issued_at),
                  },
                );
                const status =
                  certificate.status === "issued"
                    ? ""
                    : ` (${t(`principal.students.overview.certificates.status.${certificate.status}`)})`;
                return (
                  <li key={certificate.id}>
                    {canOpenCertificates ? (
                      <Link
                        to={`/portal/principal/academic-setup/certificates/${certificate.id}?year=${certificate.academic_year_id}`}
                      >
                        {label}
                      </Link>
                    ) : (
                      label
                    )}
                    {status}
                  </li>
                );
              })}
            </ul>
          )}
        </Card.Body>
      </Card>

      <TranscriptPanel studentId={studentId} />

      {canReadDiscipline ? (
        <Card as="section" aria-labelledby="student-discipline-heading">
          <Card.Header>
            <h2 id="student-discipline-heading">
              {t("principal.students.overview.discipline.heading")}
            </h2>
          </Card.Header>
          <Card.Body>
            {incidents.isPending ? (
              <p role="status">{t("principal.common.loading")}</p>
            ) : incidents.isError ? (
              <p role="alert">{t("principal.students.overview.discipline.error")}</p>
            ) : incidents.data.incidents.length === 0 ? (
              <p>{t("principal.students.overview.discipline.empty")}</p>
            ) : (
              <>
                <ul>
                  {incidents.data.incidents.map((incident) => (
                    <li key={incident.id}>
                      <Link to={`/portal/principal/discipline/${incident.id}`}>
                        {incident.title}
                      </Link>
                      {` · ${t(DISCIPLINE_TYPE_LABEL_KEYS[incident.incident_type])} · ${t(
                        DISCIPLINE_SEVERITY_LABEL_KEYS[incident.severity],
                      )} · ${t(DISCIPLINE_STATUS_LABEL_KEYS[incident.status])} · ${day(
                        incident.incident_at,
                      )}`}
                    </li>
                  ))}
                </ul>
                {incidents.data.total > incidents.data.incidents.length ? (
                  <p>
                    {t("principal.students.overview.discipline.more", {
                      count: incidents.data.total - incidents.data.incidents.length,
                    })}
                  </p>
                ) : null}
              </>
            )}
          </Card.Body>
        </Card>
      ) : null}

      {canOpenAttendance ? (
        <Card as="section" aria-labelledby="student-attendance-heading">
          <Card.Header>
            <h2 id="student-attendance-heading">
              {t("principal.students.overview.attendance.heading")}
            </h2>
          </Card.Header>
          <Card.Body>
            <Link to={`/portal/attendance/students/${studentId}`}>
              {t("principal.students.overview.attendance.open")}
            </Link>
          </Card.Body>
        </Card>
      ) : null}
    </>
  );
}
