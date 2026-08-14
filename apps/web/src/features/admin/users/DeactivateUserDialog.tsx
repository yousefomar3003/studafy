import { ApiError } from "@studafy/api-client";
import { Button, Modal, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";

import { api } from "../../../lib/api";

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
          title: `${user.display_name ?? user.email} deactivated`,
          description: `${result.revoked} session(s) revoked across their devices; ${result.invitations_revoked} pending invitation(s) cancelled.`,
        });
        onClose();
      },
      onError: (error) => {
        show({
          variant: "error",
          title: "Couldn't deactivate user",
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
      title="Deactivate user"
      description={user ? `${user.display_name ?? user.email} (${user.email})` : undefined}
    >
      <Modal.Body>
        <p>
          This immediately suspends the account and signs it out everywhere. It cannot be undone
          from this screen.
        </p>
        <p role={countsLoading ? "status" : undefined}>
          {countsLoading
            ? "Checking active sessions…"
            : sessionCount === 0 && deviceCount === 0
              ? "This user has no active sessions or registered devices."
              : `This will end ${sessionCount} active session${sessionCount === 1 ? "" : "s"} across ${deviceCount} device${deviceCount === 1 ? "" : "s"}, and cancel any pending invitations for this account.`}
        </p>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          loading={deactivateUser.isPending}
          onClick={handleConfirm}
        >
          Deactivate
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
