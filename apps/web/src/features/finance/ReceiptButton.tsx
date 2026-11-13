import { Button, useToast } from "@studafy/ui";
import { useState } from "react";

import { api } from "../../lib/api";
import { useLocale, useTranslation } from "../../lib/i18n";

import type { ButtonVariant } from "@studafy/ui";

/**
 * A payment's PDF receipt, fetched with the session's bearer token. `receipt_url` is a path on the
 * API (`GET /api/finance/payments/{paymentId}/receipt`) that needs authentication, so a plain
 * `<a href>` cannot open it. The receipt is rendered in the app's chosen language, not the
 * browser's.
 */
export async function fetchReceipt(paymentId: string, locale: string): Promise<Blob> {
  const { data } = await api.GET("/api/finance/payments/{paymentId}/receipt", {
    params: { path: { paymentId } },
    headers: { "Accept-Language": locale },
    parseAs: "blob",
  });
  if (!data) throw new Error("Receipt unavailable");
  return data as unknown as Blob;
}

interface ReceiptButtonProps {
  paymentId: string;
  variant?: ButtonVariant;
}

/** Opens the receipt in a new tab. */
export function ReceiptButton({ paymentId, variant = "tertiary" }: ReceiptButtonProps) {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const { show } = useToast();
  const [opening, setOpening] = useState(false);

  async function open() {
    // The tab is opened inside the click, before the request, so popup blockers allow it; the PDF
    // is loaded into it once it arrives.
    const tab = window.open("", "_blank");
    setOpening(true);
    try {
      const url = URL.createObjectURL(await fetchReceipt(paymentId, locale));
      if (tab) tab.location.href = url;
      else window.location.assign(url);
      // Long enough for the viewer to load it; the tab keeps its own copy after that.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      tab?.close();
      show({ variant: "error", title: t("finance.common.receiptError") });
    } finally {
      setOpening(false);
    }
  }

  return (
    <Button type="button" variant={variant} loading={opening} onClick={() => void open()}>
      {t("finance.common.openReceipt")}
    </Button>
  );
}
