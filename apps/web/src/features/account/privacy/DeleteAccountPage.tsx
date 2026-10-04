import { ApiError } from "@studafy/api-client";
import { Button, Card, useToast } from "@studafy/ui";
import { useState } from "react";

import { useSessionStore } from "../../../lib/auth";
import { useFormatters, useTranslation } from "../../../lib/i18n";
import { ConfirmDialog } from "../sessions/ConfirmDialog";

import { useDeleteAccount } from "./mutations";
import { useSelfDsrRequestsQuery } from "./queries";

import type { AccountDeletion } from "./mutations";

function apiErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  return error.detail ?? error.title;
}

/**
 * Self-service account deletion (`/account/delete`) — the in-app path Apple's App Store Review
 * Guideline 5.1.1(v) and Google Play's data-deletion policy require. The mobile Profile tab opens
 * this page in the system browser, so iOS, Android and web share it.
 *
 * `POST /api/account/deletion` signs the caller out everywhere, so the success state is rendered
 * from the response alone (no refetch could succeed) and ends with a local sign-out. A request
 * filed earlier through `POST /api/privacy/me/dsr` still shows as pending instead of the action.
 */
export default function DeleteAccountPage() {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const { show } = useToast();
  const sessionStore = useSessionStore();
  const requestsQuery = useSelfDsrRequestsQuery();
  const deleteAccount = useDeleteAccount();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deletion, setDeletion] = useState<AccountDeletion | null>(null);

  const erasureRequests = (requestsQuery.data ?? []).filter(
    (request) => request.request_type === "erasure",
  );
  const pendingErasure = erasureRequests.find(
    (request) => request.status === "queued" || request.status === "processing",
  );
  const lastErasureFailed = erasureRequests[0]?.status === "failed";

  function handleConfirm() {
    deleteAccount.mutate(undefined, {
      onSuccess: (data) => {
        setConfirmOpen(false);
        if (data) setDeletion(data);
      },
      onError: (error) => {
        setConfirmOpen(false);
        show({
          variant: "error",
          title: t("accountDeletion.requestError"),
          description: apiErrorMessage(error, t("accountDeletion.tryAgain")),
        });
      },
    });
  }

  function handleDone() {
    // The server already revoked this session; logout only clears local state, so its own
    // (expected) failure is irrelevant.
    sessionStore.logout().catch(() => undefined);
  }

  if (deletion) {
    return (
      <Card as="section" aria-labelledby="account-deleted-heading">
        <Card.Header>
          <h1 id="account-deleted-heading">{t("accountDeletion.completedTitle")}</h1>
        </Card.Header>
        <Card.Body>
          <p role="status">
            {t("accountDeletion.completedBody", {
              date: formatDate(new Date(deletion.completes_by)),
            })}
          </p>
          {deletion.ai_subscriptions_canceled > 0 ? (
            <p>{t("accountDeletion.completedAiCanceled")}</p>
          ) : null}
          <p>{t("accountDeletion.completedRetainedIntro")}</p>
          <ul>
            {deletion.retained_records.map((record) => (
              <li key={record.category}>{t(`accountDeletion.retained.${record.category}`)}</li>
            ))}
          </ul>
          <Button type="button" onClick={handleDone}>
            {t("accountDeletion.completedDone")}
          </Button>
        </Card.Body>
      </Card>
    );
  }

  return (
    <div>
      <header>
        <h1>{t("accountDeletion.title")}</h1>
        <p>{t("accountDeletion.description")}</p>
      </header>

      <Card as="section" aria-labelledby="delete-account-heading">
        <Card.Header>
          <h2 id="delete-account-heading">{t("accountDeletion.heading")}</h2>
        </Card.Header>
        <Card.Body>
          {requestsQuery.isPending ? (
            <p role="status">{t("accountDeletion.loading")}</p>
          ) : pendingErasure ? (
            <p>
              {t("accountDeletion.pending", {
                date: formatDate(new Date(pendingErasure.created_at)),
              })}
            </p>
          ) : (
            <>
              <p>{t("accountDeletion.consequenceIntro")}</p>
              <ul>
                <li>{t("accountDeletion.consequenceSignOut")}</li>
                <li>{t("accountDeletion.consequenceProfile")}</li>
                <li>{t("accountDeletion.consequenceBilling")}</li>
                <li>{t("accountDeletion.consequenceRetained")}</li>
              </ul>
              {lastErasureFailed ? <p role="alert">{t("accountDeletion.previousFailed")}</p> : null}
              <Button type="button" variant="tertiary" onClick={() => setConfirmOpen(true)}>
                {t("accountDeletion.deleteButton")}
              </Button>
            </>
          )}
        </Card.Body>
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        title={t("accountDeletion.confirmTitle")}
        body={t("accountDeletion.confirmBody")}
        confirmLabel={t("accountDeletion.confirmButton")}
        loading={deleteAccount.isPending}
        onConfirm={handleConfirm}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
