import { PERMISSIONS } from "@studafy/constants";
import { Card } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { usePermissions } from "../../lib/auth";
import { useTranslation } from "../../lib/i18n";

import { cellText, columnLabel, listName } from "./cells";
import { fetchLinkedRows, linkedRowsQueryKey, listHref } from "./queries";

import "./custom-lists.css";

import type { CustomListLinkKind } from "./queries";

export interface LinkedListsPanelProps {
  subject: { kind: CustomListLinkKind; id: string };
}

/**
 * The custom-list rows linked to one student, parent, member of staff or class, shown on their
 * page for anyone holding `customList:use`. The API returns only lists whose audience reaches the
 * caller, sensitive cells as their mask. Nothing is shown when no list links here.
 */
export function LinkedListsPanel({ subject }: LinkedListsPanelProps) {
  const permissions = usePermissions();
  if (!permissions.has(PERMISSIONS.CUSTOM_LIST_USE)) return null;
  return <LinkedLists subject={subject} />;
}

function LinkedLists({ subject }: LinkedListsPanelProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const words = { yes: t("records.lists.yes"), no: t("records.lists.no") };
  const query = useQuery({
    queryKey: linkedRowsQueryKey(subject.kind, subject.id),
    queryFn: () => fetchLinkedRows(subject.kind, subject.id),
  });

  if (!query.data || query.data.lists.length === 0) return null;

  return (
    <Card as="section" aria-label={t("records.lists.title")}>
      <Card.Header>
        <h2>{t("records.lists.title")}</h2>
      </Card.Header>
      <Card.Body>
        {query.data.lists.map((entry) => (
          <div key={entry.list.id} className="custom-lists__panel-list">
            <h3>
              <Link to={listHref(entry.list.id)}>{listName(entry.list, language)}</Link>
            </h3>
            {entry.rows.map((row) => (
              <dl key={row.id} className="custom-lists__panel-row">
                {entry.columns.map((column) => {
                  const cell = row.cells.find((candidate) => candidate.column_id === column.id);
                  if (!cell) return null;
                  return (
                    <div key={column.id}>
                      <dt>{columnLabel(column, language)}</dt>
                      <dd>
                        {cell.masked ? cell.mask : cellText(column, cell.value, language, words)}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            ))}
            {entry.total > entry.rows.length ? (
              <p className="custom-lists__muted">
                {t("records.lists.more", { count: entry.total - entry.rows.length })}
              </p>
            ) : null}
          </div>
        ))}
      </Card.Body>
    </Card>
  );
}
