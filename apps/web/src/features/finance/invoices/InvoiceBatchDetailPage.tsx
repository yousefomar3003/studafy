import { useParams } from "react-router-dom";

import { useTranslation } from "../../../lib/i18n";

import { BatchProgress } from "./InvoiceBatchPage";

import "./invoices.css";

/**
 * One past batch run (`/portal/finance/invoices/batches/:batchId`), gated by `billing:read`: the
 * same progress panel and per-student results as right after starting it, still polled while the
 * run is in flight.
 */
export default function InvoiceBatchDetailPage() {
  const { t } = useTranslation();
  const { batchId = "" } = useParams<{ batchId: string }>();
  return (
    <>
      <h1>{t("finance.invoices.history.detailTitle")}</h1>
      <BatchProgress batchId={batchId} />
    </>
  );
}
