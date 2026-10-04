import { ApiError } from "@studafy/api-client";
import { Button, Modal, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";

import { api } from "../../../lib/api";
import { useTranslation } from "../../../lib/i18n";

import { useDeactivateUser } from "./mutations";

import type { UserWithRoles } from "./queries";

export interface DeactivateUserDialogProps {
  user: UserWithRoles | null;
  onClose: () => void;
}

/**
 * Confirms before `PATCH /api/users/{userId}/deactivate`, which is irreversible from this screen
 * (there is no "reactivate" flow yet) and immediately revokes every session and device the user
 * holds. The consequence text is real data from the ST-187 admin session/device listing endpoints —
 * `enabled: open` so it is fetched only while the dialog is actually up, matching DeviceSessionsPanel.
 */
export function DeactivateUserDialog({ user, onClose }: DeactivateUserDialogProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const deactivateUser = useDeactivateUser();
  const open = user !== null;

  const sessionsQuery = useQuery({
    queryKey: ["admin-user-sessions", user?.id],
    queryFn: async () => {
      const { data } = await api.GET("/api/admin/users/{userId}/sessions", {
        params: { path: { userId: user!.id } },
      });
      return data?.sessions ?? [];
    },
    enabled: open,
  });

  const devicesQuery = useQuery({
    queryKey: ["admin-user-devices", user?.id],
    queryFn: async () => {
      const { data } = await api.GET("/api/admin/users/{userId}/devices", {
        params: { path: { userId: user!.id } },
      });
      return data?.devices ?? [];
    },
    enabled: open,
  });

  function handleConfirm() {
    if (!user) return;
    deactivateUser.mutate(user.id, {
      onSuccess: (result) => {
        show({
          variant: "success",
          title: t("adminPeople.users.deactivate.successToast", {
            name: user.display_name ?? user.email,
          }),
          description: t("adminPeople.users.deactivate.successDescription", {
            revoked: result.revoked,
            invitations: result.invitations_revoked,
          }),
        });
        onClose();
      },
      onError: (error) => {
        show({
          variant: "error",
          title: t("adminPeople.users.deactivate.error"),
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        });
      },
    });
  }

  const sessionCount = sessionsQuery.data?.length ?? 0;
  const deviceCount = devicesQuery.data?.length ?? 0;
  const countsLoading = sessionsQuery.isPending || devicesQuery.isPending;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("adminPeople.users.deactivate.title")}
      description={user ? `${user.display_name ?? user.email} (${user.email})` : undefined}
    >
      <Modal.Body>
        <p>{t("adminPeople.users.deactivate.body")}</p>
        <p role={countsLoading ? "status" : undefined}>
          {countsLoading
            ? t("adminPeople.users.deactivate.checking")
            : sessionCount === 0 && deviceCount === 0
              ? t("adminPeople.users.deactivate.noSessions")
              : t("adminPeople.users.deactivate.consequence", { sessionCount, deviceCount })}
        </p>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("adminPeople.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          loading={deactivateUser.isPending}
          onClick={handleConfirm}
        >
          {t("adminPeople.users.deactivate.confirm")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
