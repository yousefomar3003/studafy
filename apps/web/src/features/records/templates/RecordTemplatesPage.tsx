import { PERMISSIONS } from "@studafy/constants";
import { Tabs } from "@studafy/ui";
import { Link } from "react-router-dom";

import { usePermissions } from "../../../lib/auth";
import { useTranslation } from "../../../lib/i18n";

import { RecordTemplateEditor } from "./RecordTemplateEditor";

import "./record-templates.css";

export interface RecordTemplatesPageProps {
  /** Which portal mounted the page: only the back link differs. */
  portal?: "admin" | "principal";
}

/**
 * "Student and parent records" (`/portal/admin/settings/records` and
 * `/portal/principal/school/records`). Both routes are gated on `recordTemplate:manage` rather than
 * their portal's usual permission, so ORG_ADMIN and PRINCIPAL reach the same editor; a principal
 * holds no `organization:manageSettings` and still builds the school's forms here.
 */
export default function RecordTemplatesPage({ portal = "admin" }: RecordTemplatesPageProps) {
  const { t } = useTranslation();
  const permissions = usePermissions();
  const canManage = permissions.has(PERMISSIONS.RECORD_TEMPLATE_MANAGE);
  const back = portal === "admin" ? "/portal/admin/settings" : "/portal/principal";

  return (
    <>
      <div className="record-templates__header">
        <div>
          <h1>{t("recordTemplates.page.title")}</h1>
          <p>{t("recordTemplates.page.intro")}</p>
        </div>
        <Link to={back}>
          {t(
            portal === "admin"
              ? "recordTemplates.page.backToSettings"
              : "recordTemplates.page.backToDashboard",
          )}
        </Link>
      </div>
      <Tabs defaultValue="student">
        <Tabs.List aria-label={t("recordTemplates.page.subjects")}>
          <Tabs.Tab value="student">{t("recordTemplates.page.student")}</Tabs.Tab>
          <Tabs.Tab value="parent">{t("recordTemplates.page.parent")}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="student">
          <RecordTemplateEditor kind="student" canManage={canManage} />
        </Tabs.Panel>
        <Tabs.Panel value="parent">
          <RecordTemplateEditor kind="parent" canManage={canManage} />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}
