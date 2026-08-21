import { Tabs } from "@studafy/ui";

import ArAgingReportPanel from "./ArAgingReportPanel";
import CollectionsVsDueReportPanel from "./CollectionsVsDueReportPanel";
import FamilyStatementReportPanel from "./FamilyStatementReportPanel";
import GeneralLedgerReportPanel from "./GeneralLedgerReportPanel";

import "./reports.css";

/**
 * Report center (`/portal/finance/reports`), gated by `report:viewFinancial` — the same permission
 * the report endpoints themselves require (see `apps/api/src/modules/finance/reports/routes.ts`).
 * One tab per ERPNext-backed report the gateway serves (see
 * `docs/modules/finance-reports-definitions.md`): aging, collections vs due, general ledger, and
 * family statement. `joinvoice_export` is deliberately not here — it's a per-invoice compliance
 * artifact with its own flow, not a report a finance user browses.
 *
 * Each tab owns its own filters, preview run, and download independently — switching tabs never
 * interrupts another tab's in-flight export (see `ExportPanel`'s own doc comment on what "long-running
 * reports don't block UI" means in practice here).
 */
export default function ReportsCenterPage() {
  return (
    <>
      <h1>Reports</h1>
      <p>
        Run and download finance reports. Downloads process in the background — you&rsquo;ll be
        notified here once a file is ready.
      </p>

      <Tabs defaultValue="ar_aging">
        <Tabs.List>
          <Tabs.Tab value="ar_aging">Aging</Tabs.Tab>
          <Tabs.Tab value="collections_vs_due">Collections</Tabs.Tab>
          <Tabs.Tab value="general_ledger">General ledger</Tabs.Tab>
          <Tabs.Tab value="family_statement">Family statement</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="ar_aging">
          <ArAgingReportPanel />
        </Tabs.Panel>
        <Tabs.Panel value="collections_vs_due">
          <CollectionsVsDueReportPanel />
        </Tabs.Panel>
        <Tabs.Panel value="general_ledger">
          <GeneralLedgerReportPanel />
        </Tabs.Panel>
        <Tabs.Panel value="family_statement">
          <FamilyStatementReportPanel />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}
