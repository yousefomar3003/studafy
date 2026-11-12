import { Card } from "@studafy/ui";
import { Link } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";

import { useParentSummary } from "./queries";

import type { ParentSummary } from "./queries";

import "../records.css";

/** A child as "Ali Hassan (Grade 1 – A)", or the name alone when they have no class. */
export function childLabel(child: ParentSummary["children"][number]): string {
  const name = `${child.first_name} ${child.last_name}`.trim();
  return child.class_label ? `${name} (${child.class_label})` : name;
}

/**
 * A parent's contact details, Studafy ID and children, above their record. Shown to staff holding
 * `user:read` (admins, principals, finance); `studentLink` turns each child into a link to their
 * page in the caller's portal.
 */
export function ParentDetailsCard({
  parentUserId,
  studentLink,
}: {
  parentUserId: string;
  studentLink?: (studentId: string) => string;
}) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const parent = useParentSummary(parentUserId);

  return (
    <Card as="section" aria-label={t("records.parents.details.title")}>
      <Card.Header>
        <h2>{t("records.parents.details.title")}</h2>
      </Card.Header>
      <Card.Body>
        {parent.isPending ? (
          <p role="status">{t("records.panel.loading")}</p>
        ) : parent.isError ? (
          <p role="alert">{t("records.parents.details.error")}</p>
        ) : (
          <>
            <dl className="parent-details">
              <dt>{t("records.parents.columns.phone")}</dt>
              <dd>{parent.data.phone ? <span dir="ltr">{parent.data.phone}</span> : "—"}</dd>
              <dt>{t("records.parents.columns.email")}</dt>
              <dd>{parent.data.email ?? "—"}</dd>
              <dt>{t("records.parents.columns.memberId")}</dt>
              <dd>
                {parent.data.member_code ? <span dir="ltr">{parent.data.member_code}</span> : "—"}
              </dd>
              <dt>{t("records.parents.columns.status")}</dt>
              <dd>{t(`records.parents.status.${parent.data.status}`)}</dd>
              <dt>{t("records.parents.details.lastSignIn")}</dt>
              <dd>
                {parent.data.last_login_at
                  ? formatDate(new Date(parent.data.last_login_at), { dateStyle: "medium" })
                  : t("records.parents.details.never")}
              </dd>
            </dl>
            <h3>{t("records.parents.columns.children")}</h3>
            {parent.data.children.length === 0 ? (
              <p>{t("records.parents.noChildren")}</p>
            ) : (
              <ul>
                {parent.data.children.map((child) => (
                  <li key={child.student_id}>
                    {studentLink ? (
                      <Link to={studentLink(child.student_id)}>{childLabel(child)}</Link>
                    ) : (
                      childLabel(child)
                    )}{" "}
                    · {t(`records.parents.relationship.${child.relationship}`)}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Card.Body>
    </Card>
  );
}
