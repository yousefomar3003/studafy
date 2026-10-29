---
title: "Student and parent records"
description: "Build your school's record forms, fill in records for students and parents, handle sensitive information, and track what is missing."
keywords:
  [
    "records",
    "student record",
    "parent record",
    "template",
    "documents",
    "sensitive",
    "passport",
    "national id",
    "medical",
    "missing information",
    "import",
  ]
title_ar: "سجلات الطلاب وأولياء الأمور"
description_ar: "أنشئ نماذج سجلات مدرستك، واملأ سجلات الطلاب وأولياء الأمور، وتعامل مع البيانات الحساسة، وتابع المعلومات الناقصة."
keywords_ar:
  [
    "سجلات",
    "سجل الطالب",
    "سجل ولي الأمر",
    "نموذج",
    "مستندات",
    "وثائق",
    "بيانات حساسة",
    "جواز السفر",
    "الهوية الوطنية",
    "ملف طبي",
    "معلومات ناقصة",
    "استيراد",
  ]
roles: [ORG_ADMIN, PRINCIPAL]
order: 2
---

# Student and parent records

Every school collects different information about its students and their
parents: a birth certificate, a vaccination record, a bus stop, emergency
contacts, a passport number. You decide what to collect by building two record
forms, one for students and one for parents. School staff fill the records in.
Parents never enter anything.

Org admins and principals can do everything on this page. A principal works on
records of people who already exist and does not create students or users.

## Build the forms

Open Admin → School settings → **Student and parent records**, or
Principal → **Student and parent records**. Pick the **Student** or **Parent**
form.

1. Click `Add field`. Give it a type (text, number, date, choice, yes/no,
   phone, email or document), an English and an Arabic label, and optional
   help text.
2. Choose who may see it. Leadership always can; you can widen it to
   finance, then teachers, then parents. Each level includes the ones before
   it, so a field parents can see is also seen by teachers and finance.
3. Mark it **Required** if you want it to show up on the missing-information
   list when it is empty. Required never stops you saving a record, creating a
   student, enrolling them or billing them.
4. Use **Preview** to check the form in English and Arabic.
5. Click `Publish`. Your edits stay a draft until you publish.

Changing a field later never rewrites answers already given, and archiving a
field removes it from the form but keeps its answers. You cannot change a
published field's type: archive it and add a new one instead.

## Sensitive information

Mark a field **Sensitive** for anything like an ID or passport number, a
medical note or a diagnosis. Studafy suggests this when a label looks like one.
A sensitive field:

- is encrypted, and shows masked everywhere (for example `•••• 1234`);
- is never shown to finance, teachers or parents, whatever its visibility;
- needs an extra step to see in full: click `Reveal`. Every reveal is recorded
  with who looked, when, and at which field;
- is deleted 12 months after the student leaves, or after the period you set
  on the field. For a parent, the clock starts when their last child leaves.

Once published as sensitive, a field stays sensitive.

## Fill in a record

Open a student and choose the **Records** tab. To open a parent's record, use
the link on the student's Guardians tab. Principals can also click a student in
Principal → Students. Edit the answers and save.

For a document field, upload the file (PDF or an image), add an expiry date if
the field has one, and mark it **Verified** once you have checked it. Sensitive
documents open through a short-lived link that also needs the reveal
permission.

You can also fill in the form while creating a student, or a user with the
Parent role, in the optional **Records** section. Upload document files on the
Records tab afterwards.

## Missing information

Admin → **Missing information** (and the same page in the principal portal)
lists current students and parents with an empty required field or document,
and documents that have expired or expire within 30 days. Search by name, filter
by issue, and click a row to open that record. Your dashboard shows the counts.

## Importing records from a CSV

When you import students from a CSV file, the student form's fields appear as
extra columns you can map. A document field cannot be imported: upload its
files on the Records tab. A blank cell never clears an answer already on file.
Sensitive columns show masked in the preview.

A parent email that already belongs to an account is never matched. The student
is imported without a parent link, and the preview tells you so. Link the
parent yourself from the student's Guardians tab or from Finance → Unlinked.
Brothers and sisters in the same file who share a new parent email get one new
parent account between them.
