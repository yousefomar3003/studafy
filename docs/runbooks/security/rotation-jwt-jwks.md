# Secret rotation: JWT signing keys (JWKS overlap)

The RSA key pair that signs `apps/api`'s access tokens. Since QA-023 it is a **stored secret**, `JWT_PRIVATE_KEY_PEM`, which every API machine loads at boot. Before that, each machine generated its own key in memory. A token signed on one machine was then a 401 on another, and every restart logged everyone out.

Source: `apps/api/src/modules/auth/jwt/key-store.ts` (`KeyStore.init`), wired in `apps/api/src/index.ts`, served at `GET /.well-known/jwks.json` (`apps/api/src/modules/auth/jwks/route.ts`). Verification architecture: [`docs/security/JWT_verification_architecture.md`](../../security/JWT_verification_architecture.md).

Boundary: `WS_JWT_SECRET` (HMAC `HS256`), the realtime handshake-ticket key that `apps/api` signs
with and `apps/realtime/src/auth.ts` verifies, is a **different class**: an application secret held
in the `prod` GitHub Environment, not a JWT signing key pair. Rotate it through the
application-secret procedure ([`rotation-provider-api-keys.md`](rotation-provider-api-keys.md)):
generate a new value of 32+ characters, set `WS_JWT_SECRET`, and run the deploy workflow, which
stages it onto both `studafy-core-api` and `studafy-core-realtime` and deploys them back to back:
until both run the new value, new handshakes fail and clients retry. (Realtime is scaled to zero
while live updates are deferred, so today no handshakes happen at all.) Open sockets are not affected, since the
key is checked only at handshake.

## How the key works

- `JWT_PRIVATE_KEY_PEM` (required when `APP_ENV` is `staging` or `production`; `env.ts` refuses to boot without it): an unencrypted RSA PKCS#8 PEM, which signs and verifies tokens. Its `kid` is the public key's RFC 7638 thumbprint, so every machine and every restart advertises the same `kid`.
- `JWT_NEXT_PRIVATE_KEY_PEM` (optional): the second key of a rotation window. It is published in the JWKS and accepted for verification, but **never signs**.
- With a PEM set there is no rotation timer: the key changes only when an operator changes the secret. `JWT_KEY_ROTATION_INTERVAL_MS` applies only to development, where a key is generated in memory.
- Secret stores that flatten newlines are handled: literal `\n` escapes and CRLF are converted back to newlines.
- At boot the API logs `jwt signing key ready` with the `kid` and `source` (`secret` or `generated`). On a deployed tier, `source` must be `secret`.

## First-time setup (NEEDS HUMAN)

Do this before the first deploy that contains QA-023. The API refuses to boot without the secret.

1. Generate the key on a trusted machine. Never paste it into chat, tickets or logs.

   ```bash
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out jwt-current.pem
   ```

2. Store it in the secret store the deploy workflow stages from (the `prod` GitHub Environment, see [`docs/runbooks/production-secrets.md`](../production-secrets.md)) as `JWT_PRIVATE_KEY_PEM`, and on the app:

   ```bash
   fly secrets set -a studafy-core-api JWT_PRIVATE_KEY_PEM="$(cat jwt-current.pem)" --stage
   ```

   Do the same on every staging API app, with a **different** key. Then shred the local file, or move it into the password manager.

3. Deploy. Check that every machine logs the same `kid` with `source: "secret"`, and that `GET /.well-known/jwks.json` returns that one `kid` from every machine.

Expect one forced sign-in at the switch. Tokens signed by the old in-memory keys die with them, which is bounded by `JWT_ACCESS_TTL_SECONDS` (900 s); refresh tokens are unaffected.

## Planned rotation (zero downtime)

Let A be the current key and B the new one. Each step is a normal rolling deploy, and the old and new machines accept each other's tokens at every step.

1. **Publish B.** Set `JWT_NEXT_PRIVATE_KEY_PEM=B`. A still signs; A and B both verify.
2. **Sign with B.** After step 1 is on every machine, swap the two secrets: `JWT_PRIVATE_KEY_PEM=B`, `JWT_NEXT_PRIVATE_KEY_PEM=A`. B signs; A and B both verify.
3. **Retire A.** After at least `JWT_ACCESS_TTL_SECONDS` (900 s), unset `JWT_NEXT_PRIVATE_KEY_PEM`.

## Emergency rotation (key exposed)

Set `JWT_PRIVATE_KEY_PEM` to a fresh key and leave `JWT_NEXT_PRIVATE_KEY_PEM` **unset**, so the exposed key stops verifying at once. Every live access token is refused and clients refresh; refresh tokens are stored server-side and keep working. Record the rotation in [`rotation-schedule.md`](rotation-schedule.md).

## Quarterly drill

1. `curl -fsS https://api.studafy.com/.well-known/jwks.json | jq '.keys[] | {kid, alg, use, kty}'`. Expect the current `kid` (plus the next one during a rotation window), with `alg=RS256`, `use=sig` and `kty=RSA`. Repeat a few times and confirm the same set comes back each time (different machines).
2. `fly apps restart studafy-core-api`, then fetch the JWKS again. The `kid` must **not** change. If it does, a machine is running without the secret.
3. Sign and verify end to end against the served JWKS, as `apps/api/src/modules/auth/jwt/sign-verify.test.ts` does under test.
4. Audit trail: record the `jwt signing key ready` log lines (Axiom, dataset `studafy-logs`) for the drill window. See [`rotation-schedule.md`](rotation-schedule.md).

## Known gaps

- Realtime tokens are HMAC-HS256 with `WS_JWT_SECRET`; rotating that secret invalidates _all_
  live WebSocket sessions at once (machines read it at start). That class's runbook
  ([`rotation-provider-api-keys.md`](rotation-provider-api-keys.md)) treats it as downtime-forcing
  by design, not silently.
