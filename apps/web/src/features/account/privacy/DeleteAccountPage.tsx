import { ApiError } from "@studafy/api-client";
import { Button, Card, useToast } from "@studafy/ui";
import { useState } from "react";

import { useTranslation } from "../../../lib/i18n";
import { ConfirmDialog } from "../sessions/ConfirmDialog";

import { useFileSelfDsrRequest } from "./mutations";
import { useSelfDsrRequestsQuery } from "./queries";

function apiErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  return error.detail ?? error.title;
}

/**
 * Self-service account deletion (`/account/delete`): files a GDPR erasure request
 * (`POST /api/privacy/me/dsr`) for the caller's own account — the in-app account-deletion path
 * Apple's App Store Review Guideline 5.1.1(v) and Google Play's Data Safety policy both require.
 * Previously this app had none; see `apps/mobile/store/review-checklist.md`.
 *
 * Deletion is a request, not an instant action — `app.data_subject_requests`' worker-drained queue
 * (`apps/workers/src/queues/maintenance`) processes it, the same pipeline an admin-filed erasure
 * already uses. That's disclosed in the confirmation copy rather than implied by an instant
 * "account gone" transition. If a request is already queued or processing, this shows that instead
 * of the delete action — the API itself also rejects a duplicate (409 `DSR_ALREADY_PENDING`), this
 * just avoids the round trip.
 */
export default function DeleteAccountPage() {
  const { t } = useTranslation();
  const { show } = useToast();
  const requestsQuery = useSelfDsrRequestsQuery();
  const fileRequest = useFileSelfDsrRequest();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const requests = requestsQuery.data ?? [];
  const erasureRequests = requests.filter((request) => request.request_type === "erasure");
  const pendingErasure = erasureRequests.find(
    (request) => request.status === "queued" || request.status === "processing",
  );
  const lastErasureFailed = erasureRequests[0]?.status === "failed";

  function handleConfirm() {
    fileRequest.mutate("erasure", {
      onSuccess: () => {
        setConfirmOpen(false);
        show({ variant: "success", title: t("accountDeletion.requestedToast") });
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
                date: new Date(pendingErasure.created_at).toLocaleDateString(),
              })}
            </p>
          ) : (
            <>
              <p>{t("accountDeletion.consequenceIntro")}</p>
              <ul>
                <li>{t("accountDeletion.consequenceProfile")}</li>
                <li>{t("accountDeletion.consequenceAcademic")}</li>
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
        loading={fileRequest.isPending}
        onConfirm={handleConfirm}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
