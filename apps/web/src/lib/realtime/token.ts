/**
 * Supplies the realtime handshake token, mirroring `src/lib/api.ts`'s `getToken` seam. The gateway
 * authenticates a connection with a JWT passed as the `?token=` query parameter (see
 * `apps/realtime/docs/protocol.md`). Returns `null` today because nothing issues a session yet; the
 * client stays disconnected until this starts returning a value. Async so the token can come from a
 * refreshing store.
 */
export async function getRealtimeToken(): Promise<string | null> {
  return null;
}
