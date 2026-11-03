import { ApiError } from "@studafy/api-client";
import { Button, Card, DataGrid, Input, Modal, useToast } from "@studafy/ui";
import { useEffect, useState } from "react";

import { buildCsv, downloadCsv } from "../../../lib/csv";
import { useFormatters, useTranslation } from "../../../lib/i18n";
import { STATUS_LABEL_KEYS } from "../users/schema";

import { AddMemberModal } from "./AddMemberModal";
import { useIssueUnclaimedSetupCodes, useResetMemberPassword } from "./mutations";
import { MEMBER_KINDS, useMemberSummaryQuery, useMembersPageQuery } from "./queries";
import { SetupCodeDetails } from "./SetupCodeDetails";

import "../users/users.css";
import "./members.css";

import type { IssuedMember } from "./mutations";
import type { MemberListItem, MemberRole } from "./queries";
import type { DataGridColumn } from "@studafy/ui";

const SEARCH_DEBOUNCE_MS = 300;

/**
 * School members (`/portal/members`, the sidebar item under "Admin"), gated by
 * `organization:manageSettings`. How many students, teachers, parents and attendance officers the
 * school has, each with their member ID — STU/TCH/PAR/ATT, then the school number and a sequence —
 * which is also their username. Adds members without an email, and issues one-time setup codes
 * (QA-11) — to one member as a password reset, or to every member of a role who cannot sign in yet
 * as a downloaded sheet.
 */
export default function SchoolMembersPage() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const { show } = useToast();
  const summary = useMemberSummaryQuery();
  const reset = useResetMemberPassword();
  const issueCodes = useIssueUnclaimedSetupCodes();
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<MemberListItem | null>(null);
  const [issued, setIssued] = useState<IssuedMember | null>(null);

  const [role, setRole] = useState<MemberRole>("STUDENT");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>([]);

  useEffect(() => {
    const handle = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  // A new role or search always starts back at page one.
  useEffect(() => {
    setCursor(undefined);
    setCursorHistory([]);
  }, [role, search]);

  const { data, isPending, isError } = useMembersPageQuery(role, search, cursor);
  const prefix = (kindPrefix: string) =>
    summary.data ? `${kindPrefix}-${summary.data.school_number}` : kindPrefix;

  const columns: DataGridColumn<MemberListItem>[] = [
    {
      id: "memberId",
      header: t("adminPeople.members.columns.memberId"),
      renderCell: (user) =>
        user.member_codes.length > 0 ? (
          <div className="members-codes">
            {user.member_codes.map((code) => (
              <code key={code}>{code}</code>
            ))}
          </div>
        ) : (
          "—"
        ),
    },
    {
      id: "name",
      header: t("adminPeople.members.columns.name"),
      renderCell: (user) => user.display_name ?? "—",
    },
    // Students sign in with their member ID only, so their list has no email column.
    ...(role === "STUDENT"
      ? []
      : [
          {
            id: "email",
            header: t("adminPeople.members.columns.email"),
            renderCell: (user: MemberListItem) => user.email ?? "—",
          },
        ]),
    {
      id: "status",
      header: t("adminPeople.members.columns.status"),
      renderCell: (user) => (
        <span className="users-list__status-pill" data-status={user.status}>
          {t(STATUS_LABEL_KEYS[user.status as keyof typeof STATUS_LABEL_KEYS] ?? user.status)}
        </span>
      ),
    },
    {
      id: "actions",
      header: t("adminPeople.members.columns.actions"),
      renderCell: (user) => (
        <Button variant="tertiary" onClick={() => setResetting(user)}>
          {t("adminPeople.members.reset.action")}
        </Button>
      ),
    },
  ];

  function closeReset() {
    setResetting(null);
    setIssued(null);
  }

  function confirmReset() {
    if (!resetting) return;
    reset.mutate(resetting.id, {
      // Shown in the dialog rather than a toast: the code cannot be fetched again.
      onSuccess: (result) => setIssued(result),
      onError: (error) =>
        show({
          variant: "error",
          title: t("adminPeople.members.reset.error"),
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        }),
    });
  }

  function issueRoleCodes() {
    const target = role;
    issueCodes.mutate(target, {
      onSuccess: (rows) => {
        if (rows.length === 0) {
          show({ variant: "success", title: t("adminPeople.members.codes.none") });
          return;
        }
        const csv = buildCsv(
          [
            t("adminPeople.members.columns.name"),
            t("adminPeople.members.username"),
            t("adminPeople.members.setupCode"),
            t("adminPeople.members.setupCodeExpires"),
          ],
          rows.map((row) => [
            row.displayName,
            row.usernames.join(" "),
            row.setupCode,
            row.expiresAt.slice(0, 10),
          ]),
        );
        const today = new Date().toISOString().slice(0, 10);
        downloadCsv(`setup-codes-${target.toLowerCase()}-${today}.csv`, csv);
        show({
          variant: "success",
          title: t("adminPeople.members.codes.done", { count: rows.length }),
          description: t("adminPeople.members.codes.keepSafe"),
        });
      },
      onError: (error) =>
        show({
          variant: "error",
          title: t("adminPeople.members.codes.error"),
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        }),
    });
  }

  return (
    <>
      <div className="users-list__header">
        <div>
          <h1>{t("adminPeople.members.title")}</h1>
          <p>{t("adminPeople.members.description")}</p>
        </div>
        <div className="users-list__header-actions">
          <Button variant="secondary" loading={issueCodes.isPending} onClick={issueRoleCodes}>
            {t(`adminPeople.members.codes.issue.${role}`)}
          </Button>
          <Button onClick={() => setAdding(true)}>{t("adminPeople.members.add.open")}</Button>
        </div>
      </div>

      <p className="members-signin-note">{t("adminPeople.members.signInNote")}</p>

      <div className="members-summary" role="group" aria-label={t("adminPeople.members.summary")}>
        {MEMBER_KINDS.map((kind) => (
          <Card
            key={kind.role}
            as="section"
            aria-label={t(`adminPeople.members.kinds.${kind.role}`)}
          >
            <Card.Body>
              <p className="members-summary__label">
                {t(`adminPeople.members.kinds.${kind.role}`)}
              </p>
              <p className="members-summary__count">
                {summary.data ? formatNumber(summary.data[kind.countKey]) : "—"}
              </p>
              <p className="members-summary__prefix">
                {t("adminPeople.members.idRange", { prefix: prefix(kind.prefix) })}
              </p>
              <Button
                variant={role === kind.role ? "primary" : "tertiary"}
                aria-pressed={role === kind.role}
                onClick={() => setRole(kind.role)}
              >
                {t(`adminPeople.members.show.${kind.role}`)}
              </Button>
            </Card.Body>
          </Card>
        ))}
      </div>

      <div className="users-list__toolbar">
        <Input
          label={t("adminPeople.members.searchLabel")}
          placeholder={t("adminPeople.members.searchPlaceholder")}
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          type="search"
        />
      </div>

      <DataGrid
        caption={t(`adminPeople.members.caption.${role}`)}
        columns={columns}
        rows={data?.users ?? []}
        getRowId={(user) => user.id}
        getRowLabel={(user) => user.display_name ?? user.member_codes[0] ?? user.email ?? user.id}
        loading={isPending}
        empty={isError ? t("adminPeople.members.loadError") : t("adminPeople.members.empty")}
      />

      <div className="users-list__pagination">
        <Button
          variant="secondary"
          disabled={cursorHistory.length === 0}
          onClick={() => {
            const next = [...cursorHistory];
            const previous = next.pop();
            setCursorHistory(next);
            setCursor(previous);
          }}
        >
          {t("adminPeople.common.previous")}
        </Button>
        <Button
          variant="secondary"
          disabled={!data?.next_cursor}
          onClick={() => {
            const nextCursor = data?.next_cursor;
            if (!nextCursor) return;
            setCursorHistory([...cursorHistory, cursor]);
            setCursor(nextCursor);
          }}
        >
          {t("adminPeople.common.next")}
        </Button>
      </div>

      <AddMemberModal open={adding} defaultRole={role} onClose={() => setAdding(false)} />

      <Modal
        open={resetting !== null}
        onClose={closeReset}
        title={t("adminPeople.members.reset.title")}
        description={resetting ? (resetting.display_name ?? resetting.member_codes[0]) : undefined}
      >
        {issued ? (
          <>
            <Modal.Body>
              <p role="status">{t("adminPeople.members.reset.done")}</p>
              <SetupCodeDetails
                usernames={issued.usernames}
                setup={{ setupCode: issued.setupCode, expiresAt: issued.expiresAt }}
              />
            </Modal.Body>
            <Modal.Footer>
              <Button type="button" onClick={closeReset}>
                {t("adminPeople.members.add.done")}
              </Button>
            </Modal.Footer>
          </>
        ) : (
          <>
            <Modal.Body>
              <p>{t("adminPeople.members.reset.explain")}</p>
            </Modal.Body>
            <Modal.Footer>
              <Button type="button" variant="tertiary" onClick={closeReset}>
                {t("adminPeople.common.cancel")}
              </Button>
              <Button type="button" loading={reset.isPending} onClick={confirmReset}>
                {t("adminPeople.members.reset.confirm")}
              </Button>
            </Modal.Footer>
          </>
        )}
      </Modal>
    </>
  );
}
