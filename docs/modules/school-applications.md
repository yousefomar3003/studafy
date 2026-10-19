# School sign-up applications

The website's **Sign up** flow for a school owner. Studafy accounts are Google or Microsoft only, so
the applicant signs in with one of those first, then submits their school's details and a proof of
ownership. Studafy staff review it in the platform console. Approval creates the school with the
applicant as its administrator.

## Flow

1. **`/signup`**: the applicant chooses Google or Microsoft. The page links to
   `GET /api/auth/oauth/{provider}/school-application/start`.
2. **OAuth callback** (`GET /api/auth/oauth/{provider}/school-application/callback`): the API
   verifies the id_token and sets the **applicant session cookie** (`studafy_applicant`). The cookie
   is an RS256 JWT with its own audience. It is HttpOnly, SameSite=Strict, scoped to
   `/api/school-applications/me`, and lasts 2 hours. The callback then redirects to `/signup/apply`.
   - If that Google/Microsoft account already belongs to a Studafy user, the callback redirects to
     `/signup?error=SCHOOL_APPLICATION_ACCOUNT_EXISTS` instead. That person should sign in, not
     apply.
3. **`/signup/apply`**: the applicant fills in the school's name, country, city, address, currency,
   and the optional school email, website, student count and message. They add their own name, role
   and phone, and upload the proof: a PDF or JPG/PNG/WebP image, up to 10 MB.
   - The proof goes straight to S3 through a pre-signed PUT
     (`POST /api/school-applications/me/proof-upload-url`).
   - On submit (`POST /api/school-applications/me`), the API reads the stored object's type and size
     back from S3 and copies it to `permanent/school-applications/…`.
   - Each identity can have only one pending application.
4. **Team notification.** The worker's email dispatcher sends every submitted field and a console
   link to the inbox in the platform setting `onboarding.application_notification_email` (default
   `onboarding@studafy.com`, editable under Platform settings). Reply-To is the applicant.
5. **Review** at `/portal/platform/applications` (SUPER_ADMIN only). The page shows every field and a
   preview or link for the proof.
   - **Approve** creates an `active` school and an active `ORG_ADMIN` user, linked in
     `app.oauth_identities` to the exact Google/Microsoft account the person applied with. It then
     provisions the tenant (trial subscription, ERPNext), the same way email verification does for
     self-registration.
   - **Reject** requires a reason.
6. **Applicant email.** The dispatcher emails the decision to the applicant's sign-in address (their
   Gmail or Outlook). An approval tells them to sign in with that same account. A rejection includes
   the reason and a link to apply again.

Data lives in `app.school_applications` (migration 000139). The table is global and only
`studafy_admin` can access it through `withSystemTx`, the same as `app.sales_inquiries`.

## Setup per environment

- **Register the sign-up callback URLs** with each identity provider, next to the existing login
  callbacks. Each one is derived from the configured login redirect URI by swapping the path:
  - Google Cloud console → OAuth client → Authorized redirect URIs:
    `https://<api-host>/api/auth/oauth/google/school-application/callback`
  - Microsoft Entra → App registration → Authentication → Web redirect URIs:
    `https://<api-host>/api/auth/oauth/microsoft/school-application/callback`

  Without these, the provider rejects the sign-up with a `redirect_uri_mismatch` error.

- **Object storage** (`S3_*`) must be configured. Otherwise the upload endpoints answer 503, and
  the console cannot show the proof.
- **SES** (`SES_REGION`, `SES_FROM_ADDRESS`) must be configured for the emails to go out. Without
  it the dispatcher runs dry.
