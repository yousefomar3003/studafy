# Legal documents and acceptance

Studafy's Privacy Policy, Terms of Service and School Agreement, where they live, and how schools
and users accept them.

## The documents

| Document         | Text                                     | Page                |
| ---------------- | ---------------------------------------- | ------------------- |
| Privacy Policy   | `docs/legal/{en,ar}/privacy.md`          | `/privacy`          |
| Terms of Service | `docs/legal/{en,ar}/terms.md`            | `/terms`            |
| School Agreement | `docs/legal/{en,ar}/school-agreement.md` | `/school-agreement` |

Each file starts with `# Title` and `Last updated: YYYY-MM-DD` (`آخر تحديث: YYYY-MM-DD` in Arabic).
That date is the document's **version**. `apps/web/src/routes/legal/LegalDocumentPage.tsx` renders
them; `?lang=ar` opens the Arabic text. The old `legal.studafy.com` addresses redirect to these pages
(`infra/docker/web/nginx.conf`).

## Who accepts what

| Who                      | Accepts                                | When                                    | Stored on                                             |
| ------------------------ | -------------------------------------- | --------------------------------------- | ----------------------------------------------------- |
| A school (its applicant) | Terms of Service, School Agreement     | Submitting the application (`/signup`)  | `app.school_applications` (migration 000186)          |
| Every user               | Terms of Service; reads Privacy Policy | First sign-in, and after either changes | `app.users.terms_version`, `privacy_version` (000187) |

The current versions are `LEGAL_DOCUMENT_VERSIONS` in `packages/constants/src/legal.ts`. The web
test `apps/web/src/routes/legal/legal-versions.test.ts` fails if they differ from the documents'
dates, or if an Arabic document's date differs from the English one.

## The sign-in gate

1. When a token is minted (sign-in or refresh), `readSessionClaims` compares the user's accepted
   versions with the current ones. If they differ, the access token carries
   `legal_acceptance_pending`.
2. `legalAcceptanceGuard` (`apps/api/src/middleware/legal-acceptance-guard.ts`) then refuses every
   request with `403 LEGAL_ACCEPTANCE_REQUIRED`, except: `GET /api/account/profile`,
   `POST /api/account/legal-acceptance`, `POST`/`DELETE /api/account/deletion` and
   `POST /api/auth/logout`.
3. The profile's `legal_acceptance` tells the apps what to show. The web
   (`LegalAcceptanceScreen.tsx`, inside `DeletionPendingGate`) and mobile
   (`legal_acceptance_screen.dart`, from `AppShell`) show the documents, a checkbox, and accept /
   sign out / delete the account.
4. `POST /api/account/legal-acceptance` takes the versions shown; anything but the current ones is
   `409 LEGAL_VERSION_OUTDATED`. It writes the user row and an audit row (the audit log is the
   history of acceptances). The client then refreshes its token, which no longer has the claim.

A person with accounts at several schools accepts once per account: each is a separate user.

## Changing a document

1. Edit the English and Arabic Markdown, and set the same new date in both.
2. Set that date in `LEGAL_DOCUMENT_VERSIONS` (`terms`, `privacy` or `schoolAgreement`).
3. Deploy. Changing `terms` or `privacy` asks every user to accept again at their next sign-in or
   token refresh. Changing `terms` or `schoolAgreement` applies to new school applications at once.
4. For a material change, tell school administrators by email before it takes effect: the School
   Agreement promises 30 days' notice (clause 11), and 30 days for a new sub-processor (B5.2).
