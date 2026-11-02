# ADR-019: Application-level AES-256-GCM encryption for sensitive student and parent record values

## Status

Accepted

## Context

Schools define their own student and parent record templates (`docs/modules/student-records.md`,
to be written). A school may mark any field `sensitive`: national ID or passport numbers, medical
notes, and anything else the school decides needs strict handling. Those values have to be
encrypted at rest, masked by default, and readable in full only through an audited "reveal" call
that requires `studentRecord:readSensitive`.

The repository has no column-level encryption today:

- PostgreSQL is encrypted only at the storage layer (`storage_encrypted = true`,
  `infra/terraform/modules/postgres/main.tf`). Anyone who can read rows, such as the `studafy_app`
  role, a logical dump, a read replica or a restored backup, reads plaintext.
- `pgcrypto` is approved only for hashing and random bytes (`docs/database/extensions.md`). That
  doc says to revisit the approval "if an authentication or key-management design ever introduces
  sensitive key material into SQL".
- The only KMS key is the DR-backup key (`infra/terraform/modules/backup/replication.tf`). Object
  storage deliberately uses SSE-S3, because "this project has no KMS key management set up yet"
  (`infra/terraform/modules/storage/main.tf`).
- Application secrets reach the API and workers through the per-service Secrets Manager
  containers (`infra/terraform/modules/secrets`), injected by `valueFrom` in
  `infra/deploy/ecs/*/task-definition.json.tpl`. `apps/api/src/env.ts` refuses to boot a
  deployed tier with a required secret missing (the `TURNSTILE_SECRET_KEY` refinement).

Both the API (record writes, reveal, DSR export) and the workers (CSV import apply) need to encrypt.
The API (reveal, DSR export) needs to decrypt. Retention deletes only rows and needs no key.

## Decision

1. **AES-256-GCM in the application, in one small shared package.** A new
   `packages/records` (`@studafy/records`, `src/crypto.ts`) is the only code that touches key material
   or ciphertext. It uses `node:crypto`, which Bun implements, so it adds no new dependency. The
   API and the workers both import it, and nothing else in the repository calls `createCipheriv`.
   - Each value gets a fresh 96-bit random nonce and a 128-bit tag. The stored blob is
     `nonce ‖ ciphertext ‖ tag`.
   - **Additional authenticated data** binds a ciphertext to its row:
     `school_id ‖ subject_kind ‖ subject_id ‖ field_id`. A ciphertext copied to another student,
     field or school fails authentication instead of decrypting there.

2. **A versioned keyring delivered as an app secret.** There are two new environment variables
   for the API and the workers, both stored in the existing `api` and `workers` app-secrets
   containers:
   - `RECORDS_ENCRYPTION_KEYS`: a JSON object `{ "<key id>": "<base64 32 bytes>" }`;
   - `RECORDS_ENCRYPTION_CURRENT_KEY_ID`: the key used for new writes.

   `env.ts` (API) and the workers' env refuse to boot staging or production with either variable
   missing, malformed, or holding a key that isn't 32 bytes. Development and test fall back to a
   fixed, documented dev key, which a deployed tier refuses, the same way the Turnstile test key
   is handled.

3. **Storage shape.** Each sensitive answer row stores:
   - `value_ciphertext bytea`;
   - `value_key_id text`, so rotation never needs a guess;
   - `value_mask text`, computed once at write time.

   The plaintext `value` column is NULL for sensitive fields. A CHECK constraint enforces "exactly
   one of plaintext or ciphertext", keyed on the field's sensitivity at write time.

4. **Non-reveal paths never decrypt.** List, read, missing-information, import-preview and export
   responses return only `value_mask`. Only the reveal endpoint and the DSR export call
   `decrypt()`, and both are audited. Holding the key is never needed to render a page, so a bug
   in an ordinary read path cannot leak a plaintext value it never had.
   - **Mask rules:** for `short_text`, `phone`, `number` and `email`, `•••• ` plus the last 4
     characters, but only when the value has at least 8 characters. Shorter values, and every
     other type (`long_text`, `date`, choices, `yes_no`), are fully masked as `••••`. For a
     medical note, even the last 4 characters would say too much.

5. **A `SensitiveValue` wrapper for plaintext held in memory.** Decrypted values travel inside a
   class whose `toString`, `toJSON` and `util.inspect` return the mask. A plaintext value that
   accidentally reaches pino, a Sentry event, an error message or `JSON.stringify` therefore
   serializes as `••••`. Only the reveal and export serializers unwrap it explicitly.

6. **Rotation.** To rotate, add a new key id, switch `RECORDS_ENCRYPTION_CURRENT_KEY_ID`, and run a
   worker job that re-encrypts rows whose `value_key_id` is not current. Remove the old key from
   the secret only once that job reports zero rows left on it. A key id the keyring does not hold
   fails closed (`RECORD_KEY_UNAVAILABLE`), never with a plaintext fallback.

7. **Sensitive document files use per-object SSE-KMS with a dedicated key.** Uploads stay
   pre-signed and direct to S3, so an object stays readable in place by anything granted the key.
   Encrypting files in the application would force the API to proxy every byte. The API applies
   SSE-KMS (`aws:kms`, the key, Bucket Key enabled) when it promotes a sensitive document from
   `temp/` to `permanent/` (`CopyObject`). The browser's pre-signed PUT is unchanged. The staged
   `temp/` object (SSE-S3) is deleted at promotion and otherwise expires within 24 hours. S3 Bucket
   Keys keep KMS request charges negligible next to the $1/month for the key. Only the API task
   role holds `kms:GenerateDataKey`/`kms:Decrypt` (`infra/terraform/modules/compute`), and
   CloudTrail records every use of the key. `STORAGE_SENSITIVE_KMS_KEY_ID` is required on staging
   and production. Local development (rustfs) has no KMS, so there the class falls back to the
   bucket default.

## Alternatives considered

- **`pgcrypto` (`pgp_sym_encrypt` in SQL).** Rejected. The key would travel in SQL parameters on
  every statement and could surface in `log_statement`, `auto_explain`, slow-query logs and
  connection-pool debug output. `docs/database/extensions.md` explicitly withholds that approval.
  It also gives no AAD binding.
- **AWS KMS `Encrypt`/`GenerateDataKey` per value.** Rejected for now. It adds a network call to
  every write and every reveal. The project has no KMS key management yet. Local development and
  test would need LocalStack or a fake. The keyring's key-id indirection keeps this as a later
  upgrade without changing the row format: the keyring entries can become KMS-wrapped data keys,
  unwrapped at boot.
- **Per-school data keys wrapped by the keyring** (a `record_data_keys` table, so offboarding a
  school can crypto-shred its values in backups too). Deferred. Backups already expire on a fixed
  retention window, and nothing yet requires per-school shredding. It adds a table, a cache and a
  bootstrap step per school. It can be layered on later by giving each school its own key id.
- **Storage-layer encryption only, which is today's state.** Rejected. It does not protect
  against anything that can read rows: the app role, dumps, replicas, restored backups or SQL
  logging.
- **A third-party envelope library** (Tink, libsodium bindings). Rejected. `node:crypto` AES-GCM is
  enough for this threat model, and a new native dependency would need a supply-chain review
  (`docs/runbooks/supply-chain-security.md`).

## Consequences

- There are two new required secrets for the API and the workers. Terraform `app_secret_defaults`
  and both ECS task definitions gain the `valueFrom` entries, and `infra/deploy/task-definitions.test.ts`
  pins them. A deploy without them fails to boot, by design.
- Sensitive values cannot be searched, sorted, filtered or deduplicated in SQL. That matches the
  rule that Studafy never matches people on record data.
- Losing the keyring means losing every sensitive value. The secret is covered by the same
  Secrets Manager backup and recovery as the other app secrets, and the runbook must say so
  (`docs/runbooks/` entry, to be written with the feature).
- The live database never holds plaintext for sensitive fields. Restored backups hold only
  ciphertext, which stays readable only while its key id remains in the keyring.
- Sensitive document files need one new KMS key (`infra/terraform/modules/storage`), a
  `kms:Decrypt`/`kms:GenerateDataKey` grant for the API task role, and one new
  required env var. Ordinary documents keep SSE-S3.

## Review

Accepted on 2026-10-28 by the project owner, who delegated the choice to the safest option that is
also the most cost-effective in hosting and compute. Alternatives were weighed against that
brief.
