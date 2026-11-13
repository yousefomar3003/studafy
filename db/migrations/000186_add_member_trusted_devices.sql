-- Trusted devices for member-code sign-in, so a stranger cannot lock a member out.
--
-- Member IDs are sequential and printed on sheets, so anyone can send five wrong passwords for a
-- known ID and lock that account for fifteen minutes, again and again. The lockout exists to stop
-- guessing, but as built it also stops the member. Following OWASP's "device cookie" pattern, a
-- device that has already signed in to the account receives a random token; presenting it with the
-- password sends the attempt down a separate path that ignores the account-wide lockout and the
-- per-ID sign-in budget, and is limited by its own failure count instead. A stranger's wrong guesses
-- no longer reach the member's own phone; a stolen token buys only a few guesses before its row is
-- deleted.
--
-- Only the token's SHA-256 is stored: it is 256 random bits, so it needs no slow hash. The API keeps
-- at most ten per member, newest first; an administrator's password reset deletes them all.

SET ROLE studafy_admin;

CREATE TABLE app.member_trusted_devices (
  school_id       uuid        NOT NULL,
  user_id         uuid        NOT NULL,
  token_hash      text        NOT NULL,
  -- Wrong passwords in a row from this device; the API deletes the row when it reaches five.
  failed_attempts smallint    NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT pk_member_trusted_devices PRIMARY KEY (school_id, user_id, token_hash),
  CONSTRAINT fk_member_trusted_devices_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_member_trusted_devices_user
    FOREIGN KEY (user_id, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_member_trusted_devices_hash CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_member_trusted_devices_failed_attempts CHECK (failed_attempts BETWEEN 0 AND 1000),
  CONSTRAINT ck_member_trusted_devices_timestamps CHECK (updated_at >= created_at)
);

COMMENT ON TABLE app.member_trusted_devices IS
  'Devices that signed in to a member-code account (000186): SHA-256 of the device token and its own wrong-password count. They bypass the account lockout and are limited per device instead.';

REVOKE ALL PRIVILEGES ON TABLE app.member_trusted_devices FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.member_trusted_devices TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'member_trusted_devices');

RESET ROLE;
