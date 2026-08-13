import { StatusCard } from "../../components/StatusCard";

export type { StatusCardAction as InvitationOutcomeAction } from "../../components/StatusCard";
export type { StatusCardProps as InvitationOutcomeProps } from "../../components/StatusCard";

/**
 * The shared "invitation flow stopped here" card — see {@link StatusCard}. Kept as a named re-export
 * so every invite-route call site reads `InvitationOutcome`; the card itself now lives in
 * `src/components/` because the auth error page renders the same layout for OAuth failures.
 */
export const InvitationOutcome = StatusCard;
