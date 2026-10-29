---
title: "Link a parent to a student"
description: "Connect a parent account to their child from the Guardians tab or the unlinked list, so the family can see and pay fees."
keywords:
  [
    "link parent",
    "guardian",
    "add guardian",
    "family",
    "household",
    "unlinked",
    "siblings",
    "relationship",
    "children",
  ]
title_ar: "ربط ولي الأمر بالطالب"
description_ar: "اربط حساب ولي الأمر بابنه من تبويب أولياء الأمور أو من قائمة غير المرتبطين، ليتمكن الأهل من رؤية الرسوم ودفعها."
keywords_ar:
  [
    "ربط ولي الأمر",
    "ولي الأمر",
    "أولياء الأمور",
    "إضافة ولي أمر",
    "الأسرة",
    "العائلة",
    "غير مرتبط",
    "الإخوة",
    "صلة القرابة",
    "الأبناء",
    "الأب",
    "الأم",
  ]
roles: [ORG_ADMIN, FINANCE]
action: link-parent
order: 6
---

# Link a parent to a student

Studafy never links a parent to a child on its own. Staff always pick both
people: there is no matching by name, email, phone or ID number, and that
includes the CSV import.

A student with no linked parent still gets invoices, but gets no sibling
discount, appears in no family account or statement, and no parent can see or
pay their fees in the app. Linking puts the child in the parent's household.

Only the school admin can make or remove links. Finance staff can see who is
unlinked, and are asked to pass it to a school admin.

## Before you start

The parent needs an account with the Parent role. If they have none yet,
create it in the sidebar under `School members` → `Add member`, with the role
Parent.

## Link from the student's Guardians tab

1. From your `Home` page, click `Manage students →`, then `View` on the
   student's row.
2. Open the `Guardians` tab and click `Add guardian`.
3. Under **Search parents**, type the parent's name or email and pick them.
4. Choose the **Relationship**: Mother, Father, Guardian, Step-parent,
   Grandparent, Sibling or Other. It defaults to Guardian.
5. Click `Link guardian`.

## Link from the unlinked list

Finance keeps a list of everyone who is not in a family yet.

1. Open `Finance`, then `Families →`. When someone is unlinked, a banner shows
   the counts. Click `Review and link them`.
2. On **Unlinked students and parents**:
   - For a student with no guardian, click `Add a guardian`. This opens the
     student's Guardians tab: continue from step 3 above.
   - For a parent with no children, click `Link children to` and the parent's
     name. Search for each child, choose the relationship, then click
     `Link children`.

## Link while adding someone

When you add a student with `New student`, you can pick existing parents under
**Guardians (optional)**. See [Add a student](/help/add-student).

## Parents from a CSV import

An import creates and links a parent only for a parent email that is new to
Studafy. If the email already belongs to an account, the student is imported
without a link and the preview lists them under **Parents to link by hand**.
Link them with one of the ways above.

## Remove a link

On the student's `Guardians` tab, click `Remove` next to the guardian, then
`Remove` again to confirm. The parent no longer sees this student's records.
