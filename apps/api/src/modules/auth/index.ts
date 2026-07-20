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
  revokeSession,
  revokeDeviceSessions,
  revokeSessionByToken,
  type SessionTokenConfig,
  type IssuedTokenPair,
  type DeviceContext,
  type ActiveSession,
} from "./services/session-service";
export {
  deliverTokenPair,
  readPresentedToken,
  clearRefreshCookie,
  configureRefreshCookie,
  usesCookieDelivery,
  type TokenResponseBody,
} from "./delivery";
export { sessionRoutes } from "./routes/session-routes";
export type { AccessTokenClaims, JwtPayload, SignAccessTokenParams } from "./jwt/types";
