-- Creates Studafy's first tenant-scoped (school-owned) tables: the authentication and identity
-- model. Every table carries a canonical school_id, references app.schools(id) with a single-column
-- foreign key, and is placed under the canonical tenant_isolation policy via the ST-034 helper
-- app.apply_tenant_isolation, so Row-Level Security is enabled and forced and fails closed when
-- app.school_id is missing or invalid. Cross-tenant integrity is enforced structurally with
-- composite foreign keys ((id, school_id) candidate keys + (user_id, school_id) references), not by
-- RLS alone. Invitation and refresh tokens are stored hash-only (bytea SHA-256/HMAC digest); no raw
-- token is ever persisted. Roles are the fixed compile-time set from @studafy/constants (ADR-0002),
-- modeled here as the app.user_role enum. This migration is transactional (the default): all objects
-- are created as studafy_admin so studafy_admin owns them and studafy_app never can.

SET ROLE studafy_admin;

CREATE TYPE app.user_status AS ENUM ('invited', 'active', 'suspended', 'archived');
CREATE TYPE app.user_role AS ENUM (
  'SUPER_ADMIN',
  'ORG_ADMIN',
  'INSTRUCTOR',
  'TEACHING_ASSISTANT',
  'STUDENT',
  'GUEST',
  'SUPPORT_AGENT'
);

-- Canonical school-scoped user account. normalized_email is the application-computed canonical form
-- (lower(btrim(email))) used for tenant-scoped uniqueness and lookup; email preserves the display
-- form. uq_users_id_school is the candidate key that anchors every child table's composite
-- (user_id, school_id) foreign key, guaranteeing a child can never reference a user in another school.
CREATE TABLE app.users (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_users PRIMARY KEY,
  school_id uuid NOT NULL,
  email text NOT NULL,
  normalized_email text NOT NULL,
  display_name text,
  status app.user_status NOT NULL DEFAULT 'invited',
  email_verified_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_users_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_users_school_normalized_email UNIQUE (school_id, normalized_email),
  CONSTRAINT fk_users_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_users_email CHECK (
    email = btrim(email) AND email <> '' AND char_length(email) <= 320
  ),
  CONSTRAINT ck_users_normalized_email CHECK (
    normalized_email = lower(btrim(normalized_email))
    AND normalized_email <> ''
    AND char_length(normalized_email) <= 320
  ),
  CONSTRAINT ck_users_display_name CHECK (
    display_name IS NULL OR (display_name = btrim(display_name) AND display_name <> '')
  ),
  CONSTRAINT ck_users_email_verified_at CHECK (
    email_verified_at IS NULL OR email_verified_at >= created_at
  ),
  CONSTRAINT ck_users_timestamps CHECK (updated_at >= created_at)
);

-- Many-to-many user/role junction. The natural key (school_id, user_id, role) is the primary key,
-- so a role can be assigned to a user at most once and no surrogate id is needed. The composite
-- foreign key keeps the assignment inside the user's own school.
CREATE TABLE app.user_roles (
  school_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role app.user_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_user_roles PRIMARY KEY (school_id, user_id, role),
  CONSTRAINT fk_user_roles_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_user_roles_user
    FOREIGN KEY (user_id, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

-- External identity-provider accounts, kept separate from users. (provider, subject) is globally
-- unique because an IdP subject identifies exactly one external account across the whole platform;
-- the linked user is still constrained to the same school via the composite foreign key. Provider
-- OAuth/ID tokens and profile data are deliberately NOT stored here.
CREATE TABLE app.oauth_identities (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_oauth_identities PRIMARY KEY,
  school_id uuid NOT NULL,
  user_id uuid NOT NULL,
  provider text NOT NULL,
  subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_oauth_identities_provider_subject UNIQUE (provider, subject),
  CONSTRAINT fk_oauth_identities_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_oauth_identities_user
    FOREIGN KEY (user_id, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_oauth_identities_provider CHECK (
    provider = lower(provider)
    AND provider ~ '^[a-z][a-z0-9_]*$'
    AND char_length(provider) BETWEEN 2 AND 63
  ),
  CONSTRAINT ck_oauth_identities_subject CHECK (
    subject = btrim(subject) AND subject <> '' AND char_length(subject) <= 255
  ),
  CONSTRAINT ck_oauth_identities_timestamps CHECK (updated_at >= created_at)
);

-- School-scoped invitations. The invitation token is stored only as its digest (token_hash); the raw
-- token is generated and returned once by the application and never persisted. Lifecycle is tracked
-- by expires_at/revoked_at/consumed_at with immutable ordering constraints; expiry-at-use (a
-- current-time comparison) is evaluated in the application transaction, never by a mutable-time
-- check constraint.
CREATE TABLE app.invitations (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_invitations PRIMARY KEY,
  school_id uuid NOT NULL,
  email text NOT NULL,
  normalized_email text NOT NULL,
  role app.user_role NOT NULL,
  token_hash bytea NOT NULL,
  invited_by_user_id uuid,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_invitations_token_hash UNIQUE (token_hash),
  CONSTRAINT fk_invitations_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_invitations_invited_by
    FOREIGN KEY (invited_by_user_id, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_invitations_email CHECK (
    email = btrim(email) AND email <> '' AND char_length(email) <= 320
  ),
  CONSTRAINT ck_invitations_normalized_email CHECK (
    normalized_email = lower(btrim(normalized_email))
    AND normalized_email <> ''
    AND char_length(normalized_email) <= 320
  ),
  CONSTRAINT ck_invitations_token_hash CHECK (octet_length(token_hash) = 32),
  CONSTRAINT ck_invitations_expires_after_created CHECK (expires_at > created_at),
  CONSTRAINT ck_invitations_revoked_after_created CHECK (
    revoked_at IS NULL OR revoked_at >= created_at
  ),
  CONSTRAINT ck_invitations_consumed_after_created CHECK (
    consumed_at IS NULL OR consumed_at >= created_at
  ),
  CONSTRAINT ck_invitations_not_revoked_and_consumed CHECK (
    revoked_at IS NULL OR consumed_at IS NULL
  )
);

-- Revocable server-side refresh tokens, stored hash-only. family_id groups a rotation chain so the
-- whole family can be revoked on refresh-token reuse detection. parent_token_id / replaced_by_token_id
-- trace the chain and are constrained (via composite self foreign keys) to the same school. Device
-- metadata uses explicit, optional columns rather than a JSONB blob.
CREATE TABLE app.refresh_tokens (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_refresh_tokens PRIMARY KEY,
  school_id uuid NOT NULL,
  user_id uuid NOT NULL,
  token_hash bytea NOT NULL,
  family_id uuid NOT NULL,
  parent_token_id uuid,
  replaced_by_token_id uuid,
  device_name text,
  user_agent text,
  ip_address inet,
  issued_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz NOT NULL,
  rotated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_refresh_tokens_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_refresh_tokens_token_hash UNIQUE (token_hash),
  CONSTRAINT fk_refresh_tokens_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_refresh_tokens_user
    FOREIGN KEY (user_id, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_refresh_tokens_parent
    FOREIGN KEY (parent_token_id, school_id) REFERENCES app.refresh_tokens (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_refresh_tokens_replaced_by
    FOREIGN KEY (replaced_by_token_id, school_id) REFERENCES app.refresh_tokens (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_refresh_tokens_token_hash CHECK (octet_length(token_hash) = 32),
  CONSTRAINT ck_refresh_tokens_expires_after_issued CHECK (expires_at > issued_at),
  CONSTRAINT ck_refresh_tokens_rotated_after_issued CHECK (
    rotated_at IS NULL OR rotated_at >= issued_at
  ),
  CONSTRAINT ck_refresh_tokens_revoked_after_issued CHECK (
    revoked_at IS NULL OR revoked_at >= issued_at
  ),
  CONSTRAINT ck_refresh_tokens_parent_not_self CHECK (
    parent_token_id IS NULL OR parent_token_id <> id
  ),
  CONSTRAINT ck_refresh_tokens_replaced_not_self CHECK (
    replaced_by_token_id IS NULL OR replaced_by_token_id <> id
  ),
  CONSTRAINT ck_refresh_tokens_device_name CHECK (
    device_name IS NULL OR (btrim(device_name) <> '' AND char_length(device_name) <= 200)
  ),
  CONSTRAINT ck_refresh_tokens_user_agent CHECK (
    user_agent IS NULL OR char_length(user_agent) <= 1024
  )
);

-- Deliberate indexes only. Primary keys and unique constraints already index their own columns, so
-- these cover the remaining authentication query patterns and foreign-key parent checks:
--   idx_oauth_identities_school_user  list a user's linked identities; backs the composite FK.
--   idx_invitations_school_invited_by  check/list invitations created by a user; backs the FK.
--   idx_refresh_tokens_school_family  revoke an entire rotation family in one tenant.
--   idx_refresh_tokens_school_user    revoke/list a user's tokens; backs the composite FK.
--   idx_refresh_tokens_school_parent  check/traverse child tokens; backs the self FK.
--   idx_refresh_tokens_school_replaced_by  check reverse rotation links; backs the self FK.
-- users and user_roles need no extra index: their unique/primary keys are already tenant-aware
-- (school_id-leading), which also serves the RLS tenant predicate.
CREATE INDEX idx_oauth_identities_school_user ON app.oauth_identities (school_id, user_id);
CREATE INDEX idx_invitations_school_invited_by
  ON app.invitations (school_id, invited_by_user_id);
CREATE INDEX idx_refresh_tokens_school_family ON app.refresh_tokens (school_id, family_id);
CREATE INDEX idx_refresh_tokens_school_user ON app.refresh_tokens (school_id, user_id);
CREATE INDEX idx_refresh_tokens_school_parent ON app.refresh_tokens (school_id, parent_token_id);
CREATE INDEX idx_refresh_tokens_school_replaced_by
  ON app.refresh_tokens (school_id, replaced_by_token_id);

-- At most one active (neither revoked nor consumed) invitation per school/email/role. The predicate
-- uses only immutable lifecycle columns; expiry is intentionally excluded because a mutable-time
-- predicate is not immutable and cannot appear in an index.
CREATE UNIQUE INDEX uq_invitations_active
  ON app.invitations (school_id, normalized_email, role)
  WHERE revoked_at IS NULL AND consumed_at IS NULL;

-- Runtime grants. ST-031 default privileges already grant CRUD to studafy_app on new studafy_admin
-- tables; the statements below make the auth CRUD surface explicit and re-assert that PUBLIC has no
-- access. Finer per-action authorization (who may write what) is enforced in the application layer;
-- RLS only guards the tenant boundary.
REVOKE ALL PRIVILEGES ON TABLE
  app.users,
  app.user_roles,
  app.oauth_identities,
  app.invitations,
  app.refresh_tokens
FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  app.users,
  app.user_roles,
  app.oauth_identities,
  app.invitations,
  app.refresh_tokens
TO studafy_app;

REVOKE ALL ON TYPE
  app.user_status,
  app.user_role
FROM PUBLIC;

GRANT USAGE ON TYPE
  app.user_status,
  app.user_role
TO studafy_app;

-- Apply the canonical tenant_isolation policy (ENABLE + FORCE RLS) to every table. Each already
-- satisfies the helper's preconditions: schema app, owned by studafy_admin, school_id NOT NULL with a
-- single-column foreign key to app.schools(id), and no other permissive policy.
SELECT app.apply_tenant_isolation('app', 'users');
SELECT app.apply_tenant_isolation('app', 'user_roles');
SELECT app.apply_tenant_isolation('app', 'oauth_identities');
SELECT app.apply_tenant_isolation('app', 'invitations');
SELECT app.apply_tenant_isolation('app', 'refresh_tokens');

RESET ROLE;
