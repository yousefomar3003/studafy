import { Button, Card } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState, type PropsWithChildren } from "react";

import { Loading } from "../../../components/Loading";
import { api } from "../../../lib/api";
import { useSessionStore } from "../../../lib/auth";
import { useFormatters, useTranslation } from "../../../lib/i18n";

/**
 * Wraps each authenticated layout inside `RequireAuth` (app/routes.tsx). Holds back the guarded content while the signed-in account has a deletion scheduled (its 14-day
 * grace period). The API confines such a session to reading its profile, cancelling the deletion
 * and logging out, so the page offers exactly those two actions instead of a portal whose every
 * request would be refused. Mirrors the mobile app's DeletionPendingScreen.
 *
 * Shares the `account-profile` query key with the home header, so the profile is fetched once.
 * A failed profile load lets the content through: the API still enforces the restriction.
 *
 * Cancelling reloads the page: that restores the session from the refresh cookie, which mints an
 * access token without the `deletion_pending` claim.
 */
export function DeletionPendingGate({ children }: PropsWithChildren) {
  const profile = useQuery({
    queryKey: ["account-profile"],
    queryFn: async () => {
      const { data } = await api.GET("/api/account/profile");
      return data ?? null;
    },
    staleTime: 5 * 60_000,
  });

  if (profile.isPending) return <Loading />;
  const scheduledFor = profile.data?.deletion_scheduled_for;
  if (!scheduledFor) return <>{children}</>;
  return <DeletionPending scheduledFor={scheduledFor} />;
}

function DeletionPending({ scheduledFor }: { scheduledFor: string }) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const store = useSessionStore();
  const [cancelling, setCancelling] = useState(false);
  const [failed, setFailed] = useState(false);

  async function cancel() {
    setCancelling(true);
    setFailed(false);
    const { error } = await api.DELETE("/api/account/deletion");
    if (error) {
      setCancelling(false);
      setFailed(true);
      return;
    }
    window.location.reload();
  }

  return (
    <Card as="section" aria-labelledby="deletion-pending-heading">
      <Card.Header>
        <h1 id="deletion-pending-heading">{t("accountDeletion.pendingGateTitle")}</h1>
      </Card.Header>
      <Card.Body>
        <p role="status">
          {t("accountDeletion.pendingGateBody", { date: formatDate(new Date(scheduledFor)) })}
        </p>
        {failed ? <p role="alert">{t("accountDeletion.pendingGateFailed")}</p> : null}
        <Button type="button" onClick={() => void cancel()} disabled={cancelling}>
          {t("accountDeletion.pendingGateCancel")}
        </Button>{" "}
        <Button
          type="button"
          variant="secondary"
          onClick={() => void store.logout()}
          disabled={cancelling}
        >
          {t("accountDeletion.pendingGateSignOut")}
        </Button>
      </Card.Body>
    </Card>
  );
}
