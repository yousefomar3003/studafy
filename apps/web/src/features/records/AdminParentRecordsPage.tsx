import { useParams } from "react-router-dom";

import { useTranslation } from "../../lib/i18n";

import { ParentRecordsView } from "./ParentRecordsView";

/** `/portal/admin/parents/:parentUserId/records`: a parent's record, from the admin console. */
export default function AdminParentRecordsPage() {
  const { t } = useTranslation();
  const { parentUserId } = useParams<{ parentUserId: string }>();
  if (!parentUserId) return <p role="alert">{t("records.admin.parentLoadError")}</p>;
  return (
    <ParentRecordsView
      parentUserId={parentUserId}
      back={{ to: "/portal/admin/users", label: t("records.admin.backToUsers") }}
      copy={{
        title: "records.admin.parentTitle",
        fallback: "records.admin.parentFallback",
        loadError: "records.admin.parentLoadError",
      }}
    />
  );
}
