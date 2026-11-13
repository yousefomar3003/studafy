import { PERMISSIONS } from "@studafy/constants";
import { useQuery } from "@tanstack/react-query";

import { usePortalBack } from "../../layouts/portal/PortalBackLink";
import { usePermissions } from "../../lib/auth";
import { useTranslation } from "../../lib/i18n";
import { LinkedListsPanel } from "../custom-lists/LinkedListsPanel";

import { fetchParentIdentity, parentIdentityQueryKey } from "./queries";
import { RecordsPanel } from "./RecordsPanel";

import type { ReactNode } from "react";

export interface ParentRecordsViewProps {
  parentUserId: string;
  /** Where the shell's Back link goes. */
  back: string;
  /** Translation keys for the heading ("{{name}}: records") and its fallbacks. */
  copy: { title: string; fallback: string; loadError: string };
  /** Shown between the heading and the record, e.g. the parent's contact details. */
  details?: ReactNode;
}

/**
 * A parent's school-defined record on its own page: the admin's (`/portal/admin/parents/…`) and the
 * principal's (`/portal/principal/parents/…`). What the caller may do follows their permissions.
 */
export function ParentRecordsView({ parentUserId, back, copy, details }: ParentRecordsViewProps) {
  const { t } = useTranslation();
  const permissions = usePermissions();
  usePortalBack(back);
  const parent = useQuery({
    queryKey: parentIdentityQueryKey(parentUserId),
    queryFn: () => fetchParentIdentity(parentUserId),
  });

  if (parent.isPending) return <p role="status">{t("records.panel.loading")}</p>;
  if (parent.isError) return <p role="alert">{t(copy.loadError)}</p>;

  const name = parent.data.display_name ?? parent.data.email ?? t(copy.fallback);
  return (
    <>
      <h1>{t(copy.title, { name })}</h1>
      {details}
      <RecordsPanel
        subject={{ kind: "parent", id: parentUserId }}
        canEdit={permissions.has(PERMISSIONS.STUDENT_RECORD_UPDATE)}
        canRevealSensitive={permissions.has(PERMISSIONS.STUDENT_RECORD_READ_SENSITIVE)}
      />
      <LinkedListsPanel subject={{ kind: "parent", id: parentUserId }} />
    </>
  );
}
