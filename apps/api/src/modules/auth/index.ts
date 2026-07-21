export { KeyStore, type StoredKeyPair } from "./jwt/key-store";
export { signAccessToken, type SignOptions } from "./jwt/sign";
export {
  verifyAccessToken,
  TokenVerificationError,
  type VerifyOptions,
  type TokenFailureReason,
} from "./jwt/verify";
export { jwksRoutes } from "./jwks/route";
export {
  createJtiDenylist,
  jtiDenylistKey,
  JTI_DENYLIST_PREFIX,
  type JtiDenylist,
  type CreateJtiDenylistOptions,
} from "./denylist";
export { AUTH_CHANNELS, type AuthChannel } from "./channels";
export {
  createInvitationService,
  generateToken,
  hashToken,
  DEFAULT_INVITATION_EXPIRY_DAYS,
  type InvitationServiceOptions,
  type CreateInvitationParams,
  type CreateInvitationResult,
  type RevokeInvitationResult,
  type RegenerateInvitationResult,
} from "./invitation/service";
export { invitationRoutes } from "./invitation/route";
export {
  evaluateInvitationState,
  hashInvitationToken,
  maskInvitationEmail,
  resolveInvitationToken,
  verifyInvitationToken,
  type InvitationTokenResolution,
  type InvitationVerificationResult,
  type InvitationVerificationState,
} from "./invitation/verification";
export {
  mintOpaqueToken,
  parseOpaqueToken,
  hashSecret,
  verifySecret,
  type MintedToken,
  type ParsedToken,
} from "./tokens/opaque-token";
export {
  issueTokenPair,
  rotateRefreshToken,
  listActiveSessions,
  listUserDevices,
  deregisterDevice,
  resolveFamilyByToken,
  type SessionTokenConfig,
  type IssuedTokenPair,
  type DeviceContext,
  type ActiveSession,
  type UserDevice,
  type ResolvedFamily,
} from "./services/session-service";
export {
  revokeAndDenylist,
  adminRevokeUserSessions,
  REVOCATION_REASONS,
  type RevocationReason,
  type RevocationScope,
  type RevocationResult,
} from "./services/revocation-service";
export {
  deliverTokenPair,
  readPresentedToken,
  clearRefreshCookie,
  configureRefreshCookie,
  usesCookieDelivery,
  type TokenResponseBody,
} from "./delivery";
export { sessionRoutes } from "./routes/session-routes";
export {
  activationRoutes,
  type ActivationRouteDeps,
  type VerifiedMicrosoftIdentity,
} from "./routes/activation-routes";
export {
  activateAccount,
  ACTIVATION_PROVIDER,
  type ActivateAccountParams,
  type ActivateAccountResult,
  type ActivationIdentity,
} from "./services/activation-service";
export {
  emitRateLimitBlock,
  emitTokenReuseDetected,
  type RateLimitBlockEvent,
  type TokenReuseEvent,
} from "./auth-anomaly-events";
export { adminDeviceRoutes } from "./routes/admin-device-routes";
export { googleOAuthRoutes } from "./oauth/google-route";
export { microsoftOAuthRoutes } from "./oauth/microsoft-route";
export { type DenylistEntry } from "./denylist";
export type { AccessTokenClaims, JwtPayload, SignAccessTokenParams } from "./jwt/types";
