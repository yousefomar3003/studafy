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
    const keys: JWK[] = [];

    if (this.previous) {
      keys.push(await exportPublicKeyJwk(this.previous));
    }
    if (this.current) {
      keys.push(await exportPublicKeyJwk(this.current));
    }

    return { keys };
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
