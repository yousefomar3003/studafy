import { useParams } from "react-router-dom";

import { useTranslation } from "../../lib/i18n";

import { ParentRecordsView } from "./ParentRecordsView";
import { ParentDetailsCard } from "./parents/ParentDetailsCard";

/** `/portal/admin/parents/:parentUserId/records`: a parent's record, from the admin console. */
export default function AdminParentRecordsPage() {
  const { t } = useTranslation();
  const { parentUserId } = useParams<{ parentUserId: string }>();
  if (!parentUserId) return <p role="alert">{t("records.admin.parentLoadError")}</p>;
  return (
    <ParentRecordsView
      parentUserId={parentUserId}
      back="/portal/admin/users"
      copy={{
        title: "records.admin.parentTitle",
        fallback: "records.admin.parentFallback",
        loadError: "records.admin.parentLoadError",
      }}
      details={<ParentDetailsCard parentUserId={parentUserId} />}
    />
  );
}
