import { Button, Card, DataGrid, Input, Select, useToast } from "@studafy/ui";
import { useEffect, useState } from "react";

import { useFormatters, useTranslation } from "../../lib/i18n";

import { SCHOOL_MEMBERS_PAGE_SIZE, useSchoolMembersQuery } from "./queries";

import type {
  PlatformMemberRole,
  PlatformMemberStatus,
  PlatformSchoolDetail,
  PlatformSchoolMember,
} from "./queries";
import type { DataGridColumn, SelectOption } from "@studafy/ui";

const SEARCH_DEBOUNCE_MS = 300;
const STATUSES: readonly PlatformMemberStatus[] = ["invited", "active", "suspended", "archived"];

/** Chips always shown, in this order; any other role appears only once the school has one. */
const PRIMARY_ROLES: readonly PlatformMemberRole[] = [
  "STUDENT",
  "INSTRUCTOR",
  "PARENT",
  "ORG_ADMIN",
  "PRINCIPAL",
  "ATTENDANCE_OFFICER",
  "FINANCE",
];
const OTHER_ROLES: readonly PlatformMemberRole[] = ["SUPPORT_AGENT", "GUEST", "SUPER_ADMIN"];

/**
 * One school's accounts on its platform page: role chips with counts, a search, a status filter and
 * a paged table with each account's member codes (STU/TCH/PAR) and role-specific records. Every page fetched is audited by the API.
 *
 * No CSV export: a large school's roster spans many pages and each page is an audited read, so an
 * export belongs on the server, not stitched together here.
 */
export function SchoolMembersCard({ school }: { school: PlatformSchoolDetail }) {
  const { t } = useTranslation();
  const { formatDate, formatNumber } = useFormatters();
  const { show } = useToast();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [role, setRole] = useState<PlatformMemberRole | "">("");
  const [status, setStatus] = useState<PlatformMemberStatus | "">("");
  const [page, setPage] = useState(0);

  useEffect(() => {
    const handle = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  // A new filter always starts back at page one.
  useEffect(() => setPage(0), [search, role, status]);

  const { data, isPending, isError } = useSchoolMembersQuery(school.id, {
    role,
    status,
    search,
    page,
  });
  const total = data?.total ?? 0;
  const lastPage = Math.max(0, Math.ceil(total / SCHOOL_MEMBERS_PAGE_SIZE) - 1);
  const roleCounts = new Map(Object.entries(data?.roleCounts ?? school.roleCounts));
  const chipRoles = [
    ...PRIMARY_ROLES,
    ...OTHER_ROLES.filter((value) => (roleCounts.get(value) ?? 0) > 0 || value === role),
  ];

  const roleLabel = (value: string) => t(`platform.roles.${value}`, { defaultValue: value });
  const nameOf = (member: PlatformSchoolMember) =>
    member.displayName ?? member.memberCodes[0] ?? member.email ?? member.userId;

  const statusOptions: SelectOption<PlatformMemberStatus | "">[] = [
    { value: "", label: t("platform.school.members.allStatuses") },
    ...STATUSES.map((value) => ({ value, label: t(`platform.userStatus.${value}`) })),
  ];

  async function copyId(member: PlatformSchoolMember) {
    try {
      await navigator.clipboard.writeText(member.userId);
      show({ variant: "success", title: t("platform.school.members.copied") });
    } catch {
      show({ variant: "error", title: t("platform.school.members.copyError") });
    }
  }

  const columns: DataGridColumn<PlatformSchoolMember>[] = [
    {
      id: "name",
      header: t("platform.school.members.columns.name"),
      renderCell: (member) => member.displayName ?? "—",
    },
    {
      id: "memberCode",
      header: t("platform.school.members.columns.memberCode"),
      renderCell: (member) =>
        member.memberCodes.length > 0 ? (
          <div className="platform-cell-stack">
            {member.memberCodes.map((code) => (
              <code key={code}>{code}</code>
            ))}
          </div>
        ) : (
          <span className="platform-muted">—</span>
        ),
    },
    {
      id: "id",
      header: t("platform.school.members.columns.id"),
      renderCell: (member) => (
        <div className="platform-member-id">
          <code title={member.userId}>{member.userId.slice(0, 8)}</code>
          <Button
            type="button"
            variant="tertiary"
            aria-label={t("platform.school.members.copyId", { name: nameOf(member) })}
            onClick={() => void copyId(member)}
          >
            {t("platform.school.members.copy")}
          </Button>
        </div>
      ),
    },
    {
      id: "email",
      header: t("platform.school.members.columns.email"),
      renderCell: (member) => member.email ?? "—",
    },
    {
      id: "roles",
      header: t("platform.school.members.columns.roles"),
      renderCell: (member) => member.roles.map(roleLabel).join(", ") || "—",
    },
    {
      id: "status",
      header: t("platform.school.members.columns.status"),
      renderCell: (member) => (
        <span className="platform-pill" data-status={member.status}>
          {t(`platform.userStatus.${member.status}`, { defaultValue: member.status })}
        </span>
      ),
    },
    {
      id: "details",
      header: t("platform.school.members.columns.details"),
      renderCell: (member) => <MemberDetails member={member} />,
    },
    {
      id: "lastLogin",
      header: t("platform.school.members.columns.lastLogin"),
      renderCell: (member) =>
        member.lastLoginAt
          ? formatDate(new Date(member.lastLoginAt), { dateStyle: "medium" })
          : t("platform.common.never"),
    },
  ];

  return (
    <Card as="section" aria-labelledby="platform-members-title">
      <Card.Header>
        <h2 id="platform-members-title">{t("platform.school.members.title")}</h2>
      </Card.Header>
      <Card.Body>
        <p className="platform-muted">{t("platform.school.members.description")}</p>

        <div
          className="platform-chips"
          role="group"
          aria-label={t("platform.school.members.roleFilterLabel")}
        >
          <Button
            type="button"
            variant={role === "" ? "primary" : "tertiary"}
            aria-pressed={role === ""}
            onClick={() => setRole("")}
          >
            {data
              ? t("platform.school.members.chip", {
                  label: t("platform.school.members.all"),
                  total: formatNumber(data.memberCount),
                })
              : t("platform.school.members.all")}
          </Button>
          {chipRoles.map((value) => (
            <Button
              key={value}
              type="button"
              variant={role === value ? "primary" : "tertiary"}
              aria-pressed={role === value}
              onClick={() => setRole(value)}
            >
              {t("platform.school.members.chip", {
                label: roleLabel(value),
                total: formatNumber(roleCounts.get(value) ?? 0),
              })}
            </Button>
          ))}
        </div>

        <div className="platform-toolbar">
          <Input
            label={t("platform.school.members.searchLabel")}
            placeholder={t("platform.school.members.searchPlaceholder")}
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            type="search"
          />
          <Select
            label={t("platform.school.members.statusFilter")}
            options={statusOptions}
            value={status}
            onChange={(value) => setStatus(value)}
          />
        </div>

        <DataGrid
          caption={t("platform.school.members.caption", { school: school.name })}
          columns={columns}
          rows={data?.members ?? []}
          getRowId={(member) => member.userId}
          getRowLabel={nameOf}
          loading={isPending}
          empty={
            isError ? t("platform.school.members.loadError") : t("platform.school.members.empty")
          }
        />

        <div className="platform-pagination">
          <span className="platform-muted">
            {t("platform.school.members.pageSummary", {
              page: formatNumber(page + 1),
              pages: formatNumber(lastPage + 1),
              total: formatNumber(total),
            })}
          </span>
          <Button variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>
            {t("platform.common.previous")}
          </Button>
          <Button variant="secondary" disabled={page >= lastPage} onClick={() => setPage(page + 1)}>
            {t("platform.common.next")}
          </Button>
        </div>
      </Card.Body>
    </Card>
  );
}

/** The role-specific records: a student's admission number, classes and guardians; a parent's
 * children; a teacher's employee number. */
function MemberDetails({ member }: { member: PlatformSchoolMember }) {
  const { t } = useTranslation();
  const lines: string[] = [];

  if (member.student) {
    lines.push(t("platform.school.members.admission", { number: member.student.admissionNumber }));
    lines.push(
      member.student.classes.length > 0
        ? t("platform.school.members.classes", { classes: member.student.classes.join(", ") })
        : t("platform.school.members.noClasses"),
    );
    if (member.student.guardians.length > 0) {
      const names = member.student.guardians.map((g) => g.displayName ?? g.userId.slice(0, 8));
      lines.push(t("platform.school.members.guardians", { names: names.join(", ") }));
    }
  }
  if (member.children.length > 0) {
    const names = member.children.map((child) => `${child.name} (${child.admissionNumber})`);
    lines.push(t("platform.school.members.children", { names: names.join(", ") }));
  }
  if (member.teacher) {
    lines.push(t("platform.school.members.employee", { number: member.teacher.employeeNumber }));
  }

  if (lines.length === 0) return <span className="platform-muted">—</span>;
  return (
    <div className="platform-cell-stack">
      {lines.map((line) => (
        <span key={line} className="platform-muted">
          {line}
        </span>
      ))}
    </div>
  );
}
