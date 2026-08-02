export { startEmailDispatcher } from "./dispatcher";
export type {
  DispatcherHandle,
  EmailDispatcherConfig,
  EmailDispatcherContext,
  EmailDispatcherLogger,
} from "./dispatcher";
export { scheduleDigestJob } from "./digest-scheduler";
export { processDigest } from "./digest-producer";
export type { DigestResult } from "./digest-producer";
export { TokenBucket } from "./rate-limiter";
export type { Now, RateLimiter } from "./rate-limiter";
export { createSesSender, isRetryableSendError } from "./sender";
export type { EmailSender, OutboundEmail, SentEmail, SenderLogger } from "./sender";
export {
  renderAlertEmail,
  renderDigestEmail,
  renderDunningEmail,
  renderInvitationEmail,
  renderSubscriptionDunningEmail,
  renderVerificationEmail,
} from "./templates";
export type {
  AlertEmailData,
  DigestEmailData,
  DigestItem,
  DunningEmailData,
  EmailTemplate,
  InvitationEmailData,
  RenderedEmail,
  SubscriptionDunningEmailData,
  VerificationEmailData,
} from "./templates";
