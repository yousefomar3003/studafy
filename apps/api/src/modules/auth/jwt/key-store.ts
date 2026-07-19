import { randomUUID } from "node:crypto";

import { exportJWK, generateKeyPair, importJWK, importPKCS8, type JWK } from "jose";

/**
 * A single RSA key pair held in memory for signing or verifying JWTs.
 */
export interface StoredKeyPair {
  kid: string;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  createdAt: Date;
}

/**
 * In-memory RSA key store with automatic rotation.
 *
 * Holds at most two key pairs: `current` (signing + verification) and `previous`
 * (verification only). The JWKS endpoint exposes both so that tokens signed with
 * the outgoing key remain verifiable until they expire.
 *
 * The store must be explicitly initialized (`init`) before use and torn down (`destroy`)
 * on shutdown to clear the rotation timer.
 */
export class KeyStore {
  private current: StoredKeyPair | null = null;
  private previous: StoredKeyPair | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Memoized export of the live key material.
   *
   * The result only changes when the key set changes, so it is computed once per rotation and
   * invalidated by setting this back to null. Measured on Bun 1.3, re-exporting both keys costs
   * ~7 µs against ~0.9 µs for the cached read — worth having on a per-request path, but modest:
   * the authentication budget is dominated by the RSA signature verification itself, not by this.
   *
   * `byKid` is the part that carries its weight structurally rather than numerically. Verification
   * resolves a token's `kid` to one public key through it and checks a single signature, instead
   * of handing a whole JWKS to jose and letting it work out which key applies.
   */
  private jwksCache: { keys: JWK[]; byKid: Map<string, CryptoKey> } | null = null;

  constructor(
    private readonly rotationIntervalMs: number,
    private readonly onRotate?: (kid: string) => void,
  ) {}

  /**
   * Initialize the store. If `privateKeyPem` is provided, it is loaded as the initial
   * signing key. Otherwise a fresh RSA-2048 key pair is generated.
   *
   * After initialization the rotation timer starts — call `destroy()` on shutdown.
   */
  async init(privateKeyPem?: string): Promise<void> {
    if (privateKeyPem) {
      const privateKey = await importPKCS8(privateKeyPem, "RS256");
      const publicKey = await derivePublicKey(privateKey);
      this.current = { kid: randomUUID(), publicKey, privateKey, createdAt: new Date() };
      this.jwksCache = null;
    } else {
      await this.rotate();
    }

    this.timer = setInterval(() => {
      this.rotate().catch(() => {
        /* rotation failure is non-fatal; next tick retries */
      });
    }, this.rotationIntervalMs);
  }

  /**
   * Generate a new key pair. The outgoing current key becomes `previous` (verification only)
   * and the new key becomes `current` (signing + verification).
   */
  async rotate(): Promise<StoredKeyPair> {
    const { publicKey, privateKey } = await generateKeyPair("RS256", {
      modulusLength: 2048,
    });

    const kid = randomUUID();
    const keyPair: StoredKeyPair = { kid, publicKey, privateKey, createdAt: new Date() };

    this.previous = this.current;
    this.current = keyPair;
    this.jwksCache = null;

    this.onRotate?.(kid);
    return keyPair;
  }

  /** The key pair used to sign new tokens. Throws if the store is not initialized. */
  signingKey(): StoredKeyPair {
    if (!this.current) throw new Error("KeyStore not initialized");
    return this.current;
  }

  /**
   * Build the JSON Web Key Set containing the current and previous public keys.
   * Consumed by the JWKS endpoint.
   */
  async toJwks(): Promise<{ keys: JWK[] }> {
    const { keys } = await this.resolve();
    return { keys };
  }

  /**
   * Resolve a `kid` from a token header to the public key that can verify it.
   *
   * Returns undefined for an unknown kid — which covers both a forged header and a token signed
   * by a key that has already rotated out of the two-key window. Both are unverifiable, and the
   * caller treats them identically.
   */
  async publicKeyFor(kid: string): Promise<CryptoKey | undefined> {
    const { byKid } = await this.resolve();
    return byKid.get(kid);
  }

  /** Populate {@link jwksCache} if cold, then return it. */
  private async resolve(): Promise<{ keys: JWK[]; byKid: Map<string, CryptoKey> }> {
    if (this.jwksCache) return this.jwksCache;

    const keys: JWK[] = [];
    const byKid = new Map<string, CryptoKey>();

    // Previous first, so the JWKS lists the outgoing key ahead of the incoming one — unchanged
    // from the pre-cache ordering, which the endpoint's tests assert on.
    for (const key of [this.previous, this.current]) {
      if (!key) continue;
      keys.push(await exportPublicKeyJwk(key));
      byKid.set(key.kid, key.publicKey);
    }

    this.jwksCache = { keys, byKid };
    return this.jwksCache;
  }

  /** Stop the rotation timer. Call on shutdown. */
  destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/** Export a stored key pair as a JWK suitable for a JWKS endpoint. */
async function exportPublicKeyJwk(key: StoredKeyPair): Promise<JWK> {
  const jwk = await exportJWK(key.publicKey);
  jwk.kid = key.kid;
  jwk.alg = "RS256";
  jwk.use = "sig";
  return jwk;
}

/**
 * Derive the public key from a PKCS#8 private key. jose doesn't expose a direct
 * "publicFromPrivate" helper, so we export the private key as JWK, strip private
 * fields, and re-import as a public-only key.
 */
async function derivePublicKey(privateKey: CryptoKey): Promise<CryptoKey> {
  const jwk = await exportJWK(privateKey);

  const publicJwk: JWK = {
    kty: jwk.kty,
    n: jwk.n,
    e: jwk.e,
  };

  return importJWK(publicJwk, "RS256") as Promise<CryptoKey>;
}
