---
title: "Invite staff"
description: "Send principals and finance staff an email invitation, and create accounts for teachers and attendance officers."
keywords:
  [
    "invite",
    "invitation",
    "staff",
    "principal",
    "finance",
    "teacher",
    "attendance officer",
    "employee number",
    "resend",
    "revoke",
  ]
title_ar: "دعوة الموظفين"
description_ar: "أرسل دعوة بالبريد الإلكتروني إلى مدير المدرسة وموظفي المالية، وأنشئ حسابات المعلمين ومسؤولي الحضور."
keywords_ar:
  [
    "دعوة",
    "دعوة موظف",
    "الموظفين",
    "مدير المدرسة",
    "المالية",
    "محاسب",
    "معلم",
    "مسؤول الحضور",
    "حساب جديد",
    "رقم الموظف",
    "إعادة إرسال الدعوة",
    "إلغاء الدعوة",
  ]
roles: [ORG_ADMIN]
action: invite-staff
order: 3
---

# Invite staff

How a staff member joins depends on their role:

- **Principals and finance staff** work in the web portal. You send them an
  email invitation and they sign in with Google or Microsoft.
- **Teachers and attendance officers** work in the mobile app. You create
  their account and hand them a Studafy ID and a starting password. No email is
  needed.

Only the school admin can do either.

## Invite a principal or finance staff member

1. In the sidebar, open `Staff accounts`.
2. Under **Invite a principal or finance staff member**, enter their
   **Email** and pick the **Role**: Principal or Finance.
3. Click `Send invitation`.

Studafy emails them an invitation link. They open it and choose
`Continue with Google` or `Continue with Microsoft`, signing in with exactly the
email address you invited. There is no password to set. The link expires after
7 days. If they sign in with a different email address, the sign-in waits for
admin approval instead.

## Resend or revoke an invitation

The invitations table on the same page shows each invitation's status:
`Waiting for sign-in`, `Active`, `Expired`, or `Revoked`.

- `Resend` (waiting or expired) cancels the old link and emails a new one.
- `Revoke` (waiting only) cancels the invitation, so the link stops working.

## Add a teacher or attendance officer

1. In the sidebar, open `School members` and click `Add member`.
2. Pick the **Role**: Teacher or Attendance officer.
3. Fill in **Full name**. A teacher also needs an **Employee number**. **Email**
   is optional for both.
4. Click `Create account`.

Studafy shows their **Username** (their Studafy ID) and **Starting password**.
Give them both. They sign in to the mobile app with them and choose their own
password the first time. Click `Add another` for the next person, or `Done`.

If someone forgets their password, click `Reset password` on their row in
`School members`.
