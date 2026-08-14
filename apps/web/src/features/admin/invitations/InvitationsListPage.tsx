import { Tabs } from "@studafy/ui";
import { useState } from "react";

import { BulkInviteModal } from "./BulkInviteModal";
import { BulkInviteProgressPanel } from "./BulkInviteProgressPanel";
import { BulkInvitesBoard } from "./BulkInvitesBoard";
import { CreateInvitationModal } from "./CreateInvitationModal";
import { InvitationsBoard } from "./InvitationsBoard";
import { InviteLinkDialog } from "./InviteLinkDialog";
import { RevokeInvitationDialog } from "./RevokeInvitationDialog";

import "./invitations.css";

import type { InviteLinkDetails } from "./InviteLinkDialog";
import type { InvitationWithStatus } from "./queries";

/**
 * Invitation management (`/portal/admin/invitations`), gated by `organization:manageSettings` like
 * the rest of `/portal/admin` — the same permission set the backend's own inline
 * `SUPER_ADMIN`/`ORG_ADMIN` check requires for every invitation mutation, so nobody who can reach
 * this screen is missing the authority to act on what it shows.
 *
 * Two tabs share one screen rather than two routes: single invitations (the status board — pending/
 * expired/consumed/revoked, filterable and searchable, matching `UsersListPage`'s Select-based status
 * filter rather than introducing a second UI idiom for the same idea) and bulk-invite batches (their
 * own per-recipient progress view). Both originate invitations, but a batch's lifecycle — queued,
 * processed async by a worker, individually retriable — is different enough from a single invite's
 * synchronous create/resend/revoke that folding them into one table would blur two different mental
 * models into one confusing view.
 */
export default function InvitationsListPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [bulkCreateOpen, setBulkCreateOpen] = useState(false);
  const [revokingInvitation, setRevokingInvitation] = useState<InvitationWithStatus | null>(null);
  const [linkDetails, setLinkDetails] = useState<InviteLinkDetails | null>(null);
  const [progressBulkInviteId, setProgressBulkInviteId] = useState<string | null>(null);

  return (
    <>
      <h1>Invitations</h1>

      <Tabs defaultValue="invitations">
        <Tabs.List>
          <Tabs.Tab value="invitations">Invitations</Tabs.Tab>
          <Tabs.Tab value="bulk">Bulk invites</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="invitations">
          <InvitationsBoard
            onCreate={() => setCreateOpen(true)}
            onRevoke={setRevokingInvitation}
            onResent={setLinkDetails}
          />
        </Tabs.Panel>

        <Tabs.Panel value="bulk">
          <BulkInvitesBoard
            onCreate={() => setBulkCreateOpen(true)}
            onViewProgress={setProgressBulkInviteId}
          />
        </Tabs.Panel>
      </Tabs>

      <CreateInvitationModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={setLinkDetails}
      />

      <BulkInviteModal
        open={bulkCreateOpen}
        onClose={() => setBulkCreateOpen(false)}
        onCreated={setProgressBulkInviteId}
      />

      <RevokeInvitationDialog
        invitation={revokingInvitation}
        onClose={() => setRevokingInvitation(null)}
      />

      <InviteLinkDialog details={linkDetails} onClose={() => setLinkDetails(null)} />

      <BulkInviteProgressPanel
        bulkInviteId={progressBulkInviteId}
        onClose={() => setProgressBulkInviteId(null)}
      />
    </>
  );
}
