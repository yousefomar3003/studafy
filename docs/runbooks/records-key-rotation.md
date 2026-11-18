# Rotating the sensitive records key

Sensitive record answers and sensitive custom-list cells are sealed with a key from
`RECORDS_ENCRYPTION_KEYS` (ADR-0019). This runbook replaces that key, for example on a schedule or
after a suspected exposure, without losing any value.

## How it works

- `RECORDS_ENCRYPTION_KEYS` is a JSON object of key id → base64 32-byte key. Every key in it can
  open values. `RECORDS_ENCRYPTION_CURRENT_KEY_ID` names the one new values are sealed with.
- Each sealed value stores the id of the key that sealed it (`value_key_id`).
- The workers' daily records job (`purge-expired-sensitive-records`, 08:50 UTC) first purges expired
  values. It then **re-seals** every value whose key id is not the current one
  (`apps/workers/src/queues/maintenance/record-key-rotation.ts`). It works per school, in batches
  of 500, each batch in its own transaction. A failed school is rolled back and retried the next
  day, so the job can safely stop at any point and resume.
- Each batch writes an audit row (`target_table` `record_answers` or `custom_list_values`, the school
  as target). `old_values.sealed_with_key_ids` lists the old key ids, and `new_values` holds
  `resealed` (a count) and `resealed_to_key_id`. No value and no key material is logged.

## Steps

1. **Generate the new key** in your password manager: 32 random bytes, base64
   (`openssl rand -base64 32`). Pick an id that sorts after the old one, e.g. `records-2026-11`.
   Never paste the key into chat, tickets or logs.
2. **Add it next to the old key, and make it current**, on the API and the workers together:
   ```
   RECORDS_ENCRYPTION_KEYS={"<old-id>":"<old-key>","<new-id>":"<new-key>"}
   RECORDS_ENCRYPTION_CURRENT_KEY_ID=<new-id>
   ```
   Set it with `fly secrets set ... -a studafy-core-api` and `-a studafy-core-workers`, which
   restarts both. From now on, new values are sealed with the new key, and old values still open
   with the old one.
3. **Let the re-seal run.** Wait for the next daily run, or trigger it once from the maintenance
   queue. Check its log line for `resealed` and `resealFailed`.
4. **Confirm nothing is left on the old key.** As the owner role, read-only:
   ```sql
   SELECT value_key_id, count(*) FROM app.record_answers
   WHERE value_ciphertext IS NOT NULL GROUP BY 1;
   SELECT value_key_id, count(*) FROM app.custom_list_values
   WHERE value_ciphertext IS NOT NULL GROUP BY 1;
   ```
   Every row should show the new id. If old ids remain, look for `record re-seal failed for school`
   warnings, fix the cause, and wait for another run.
5. **Remove the old key** from `RECORDS_ENCRYPTION_KEYS` on both apps. A value still sealed with it
   would no longer open, which is why step 4 must show zero first.
6. **Destroy the old key** in the password manager once the deploy is healthy, and record the
   rotation date.

## After a suspected exposure

Do steps 1–5 the same day. Re-sealing protects values from the moment the old key is removed. It
does not help with copies already taken, such as old backups and database snapshots, which still
hold values under the old key. Treat those as exposed and follow the incident runbook.
