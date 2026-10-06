import { Table } from "@studafy/ui";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import {
  useClassesForTerm,
  useEnrollmentCounts,
  useRooms,
  useTeacherContacts,
} from "../school/queries";
import { TermPicker, useTermSelection } from "../school/TermPicker";

import "../school/principal-school.css";

const COLUMN_COUNT = 5;

/**
 * Classes (`/portal/principal/classes`): every class running in the chosen term with its lead
 * teacher, room, and how full it is (active enrolments against capacity). Read-only; classes are
 * set up by the admin.
 */
export default function PrincipalClassesPage() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const selection = useTermSelection();
  const classes = useClassesForTerm(selection.term?.id);
  const teachers = useTeacherContacts();
  const rooms = useRooms();

  const classList = [...(classes.data ?? [])].sort((a, b) => a.code.localeCompare(b.code));
  const enrolled = useEnrollmentCounts(classList.map((klass) => klass.id));
  const teacherName = new Map(
    (teachers.data ?? []).map((teacher) => [teacher.id, teacher.display_name]),
  );
  const roomName = new Map((rooms.data ?? []).map((room) => [room.id, room.name]));

  return (
    <>
      <h1>{t("principal.classes.title")}</h1>
      <p>{t("principal.classes.description")}</p>

      <div className="principal-school__filters">
        <TermPicker selection={selection} />
      </div>

      <Table caption={t("principal.classes.caption")}>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("principal.classes.columns.class")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.classes.columns.teacher")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.classes.columns.room")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.classes.columns.enrolled")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.classes.columns.status")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={COLUMN_COUNT}
          loading={selection.isPending || classes.isPending}
          empty={classes.isError ? t("principal.classes.error") : t("principal.school.noClasses")}
        >
          {classList.map((klass) => {
            const count = enrolled.get(klass.id);
            const countText = count === undefined ? "…" : formatNumber(count);
            return (
              <Table.Row key={klass.id}>
                <Table.Cell>{klass.code}</Table.Cell>
                <Table.Cell>{teacherName.get(klass.lead_teacher_id) ?? "—"}</Table.Cell>
                <Table.Cell>{roomName.get(klass.room_id) ?? "—"}</Table.Cell>
                <Table.Cell>
                  {klass.capacity === null
                    ? countText
                    : t("principal.classes.ofCapacity", {
                        enrolled: countText,
                        capacity: formatNumber(klass.capacity),
                      })}
                </Table.Cell>
                <Table.Cell>
                  {t(`principal.classes.status.${klass.status}`, klass.status)}
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table>
    </>
  );
}
