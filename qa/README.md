# QA tooling (QA-02)

Bearer tokens for every role in the staging QA tenants, without database access. Accounts,
provisioning and safety: [`docs/runbooks/qa-staging-access.md`](../docs/runbooks/qa-staging-access.md).

| Path            | What                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------ |
| `get-tokens.sh` | curl + jq: signs in as all 15 accounts, writes `qa/.tokens.env` (gitignored, mode 600).    |
| `accounts.json` | The accounts the script and Bruno use: school, role, email, channel, token variable.       |
| `bruno/`        | [Bruno](https://www.usebruno.com/) collection: `Login` (one request per account), `Smoke`. |
| `generate.ts`   | Renders `accounts.json` and `bruno/Login/*` from `db/seeds/qa-credentials.ts`.             |

## curl

```bash
QA_LOGIN_PASSWORD='<password>' qa/get-tokens.sh      # or omit it and type it at the prompt
source qa/.tokens.env
curl -H "authorization: Bearer $QA_TOKEN_B_PRINCIPAL" https://staging-api.studafy.com/api/auth/sessions
```

Variables are `QA_TOKEN_<SCHOOL>_<ROLE>`: `QA_TOKEN_PLATFORM_SUPER_ADMIN`, `QA_TOKEN_A_ORG_ADMIN`,
`QA_TOKEN_B_ATTENDANCE_OFFICER`, and so on. Options:

- `QA_BASE_URL`: the API to sign in to. Defaults to `https://staging-api.studafy.com`. Use
  `http://localhost:3000` for a local API.
- `QA_TOKENS_FILE`: where to write the tokens. Defaults to `qa/.tokens.env`.
- `QA_CHANNEL`: forces one channel for every account. By default each account uses its own (see
  the runbook).

Tokens last 15 minutes. Rerun the script to refresh them; a 429 is waited out automatically.

## Bruno

Open `qa/bruno` as a collection, select the `staging` (or `local`) environment, set the secret
`qaPassword`, and run the `Login` folder. Each request saves its token to an environment variable
with the same `QA_TOKEN_*` name, so any request can use `{{QA_TOKEN_A_STUDENT}}` as a bearer token.
`Smoke` checks the platform boundary: SUPER_ADMIN gets 200 and a school ORG_ADMIN gets 403.

## Local

Same flow against a local API. Set `QA_LOGIN_PASSWORD` (24+ characters) in the API's environment,
then:

```bash
QA_TENANT_SEED_CONFIRM=studafy-qa bun run db:seed:qa
QA_BASE_URL=http://localhost:3000 QA_LOGIN_PASSWORD='<same value>' qa/get-tokens.sh
```

## Changing the roster

Edit `db/seeds/qa-credentials.ts`, then run `bun run qa:generate`. The seed test fails while the
committed `accounts.json` or `bruno/Login/*` disagree with the seed.
