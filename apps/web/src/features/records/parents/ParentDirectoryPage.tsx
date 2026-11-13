import { Button, Input, Table } from "@studafy/ui";
import { useDeferredValue, useState } from "react";
import { Link } from "react-router-dom";

import { useTranslation } from "../../../lib/i18n";

import { childLabel } from "./ParentDetailsCard";
import { useParentDirectory } from "./queries";

import "../../principal/school/principal-school.css";

const COLUMN_COUNT = 6;

/**
 * Parents (`/portal/principal/parents`): every parent of the school with their phone, email,
 * Studafy ID and children, searchable by name, email or ID. Each name opens the parent's page:
 * their contact details and their school-defined record. Gated on `user:read`.
 */
export default function ParentDirectoryPage() {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const deferred = useDeferredValue(search.trim());
  const directory = useParentDirectory(deferred);
  const parents = directory.data?.pages.flatMap((page) => page.parents) ?? [];

  return (
    <>
      <h1>{t("records.parents.title")}</h1>
      <p>{t("records.parents.description")}</p>

      <div className="principal-school__filters">
        <Input
          label={t("records.parents.search")}
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <Table caption={t("records.parents.title")} hideCaption>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("records.parents.columns.name")}</Table.HeaderCell>
            <Table.HeaderCell>{t("records.parents.columns.phone")}</Table.HeaderCell>
            <Table.HeaderCell>{t("records.parents.columns.children")}</Table.HeaderCell>
            <Table.HeaderCell>{t("records.parents.columns.email")}</Table.HeaderCell>
            <Table.HeaderCell>{t("records.parents.columns.memberId")}</Table.HeaderCell>
            <Table.HeaderCell>{t("records.parents.columns.status")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={COLUMN_COUNT}
          loading={directory.isPending}
          empty={directory.isError ? t("records.parents.error") : t("records.parents.empty")}
        >
          {parents.map((parent) => (
            <Table.Row key={parent.user_id}>
              <Table.Cell>
                <Link to={`/portal/principal/parents/${parent.user_id}`}>
                  {parent.display_name ?? parent.email ?? t("records.principal.parentFallback")}
                </Link>
              </Table.Cell>
              <Table.Cell>{parent.phone ? <span dir="ltr">{parent.phone}</span> : "—"}</Table.Cell>
              <Table.Cell>
                {parent.children.length === 0
                  ? "—"
                  : parent.children
                      .map(
                        (child) =>
                          `${childLabel(child)} · ${t(`records.parents.relationship.${child.relationship}`)}`,
                      )
                      .join(t("records.parents.listSeparator"))}
              </Table.Cell>
              <Table.Cell>{parent.email ?? "—"}</Table.Cell>
              <Table.Cell>
                {parent.member_code ? (
                  <span dir="ltr" style={{ whiteSpace: "nowrap" }}>
                    {parent.member_code}
                  </span>
                ) : (
                  "—"
                )}
              </Table.Cell>
              <Table.Cell>{t(`records.parents.status.${parent.status}`)}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>

      {directory.hasNextPage ? (
        <Button
          variant="secondary"
          loading={directory.isFetchingNextPage}
          onClick={() => void directory.fetchNextPage()}
        >
          {t("records.parents.loadMore")}
        </Button>
      ) : null}
    </>
  );
}
