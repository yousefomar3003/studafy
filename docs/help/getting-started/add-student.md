---
title: "Add a student"
description: "Create one student from the Students list, with optional guardians and record answers."
keywords:
  [
    "add student",
    "new student",
    "create student",
    "enrol",
    "enroll",
    "admission number",
    "student profile",
    "guardian",
  ]
title_ar: "إضافة طالب"
description_ar: "أنشئ طالبًا جديدًا من قائمة الطلاب، مع أولياء الأمور وبيانات السجل اختياريًا."
keywords_ar:
  [
    "إضافة طالب",
    "طالب جديد",
    "تسجيل طالب",
    "قيد طالب",
    "رقم القيد",
    "الرقم الأكاديمي",
    "ملف الطالب",
    "ولي الأمر",
    "تاريخ الميلاد",
    "حالة الطالب",
  ]
roles: [ORG_ADMIN]
action: add-student
order: 4
---

# Add a student

Use this to add students one at a time. For a whole class or school, import a
CSV file instead (see [Import students from a CSV file](/help/import-students)).

Only the school admin can add students. Principals see the student list in
Principal → `Students →`, but it is read-only there.

## Open the Students list

From your `Home` page, click `Manage students →`. The **Students** page lists
every student in the school.

## Fill in the new student form

1. Click `New student`.
2. Fill in the student's details:
   - **First name** and **Last name** (required).
   - **Middle name** and **Preferred name** (optional). A preferred name is
     shown instead of the legal name where it fits.
   - **Date of birth** and **Admission date** (optional).
   - **Admission number** (required). It must be unique within your school.
   - **Status**. Defaults to `Applicant`; pick `Enrolled` for a student who is
     already attending.
3. Optional: under **Guardians (optional)**, search for the parent by name or
   email and pick them. Choose their relationship to the student. Only parents
   who already have an account appear here.
4. Optional: open **Records (optional)** to fill in your school's student
   record form now. Document files are uploaded later, from the student's
   Records tab.
5. Click `Create student`.

There is no email field. Students sign in with their Studafy ID and a starting
password.

## After saving

You see "Added" with the student's name, and the student appears in the list
straight away. To open their profile, click `View` on their row. From the
profile you can add guardians later (see
[Link a parent to a student](/help/link-parent)).

If something is wrong, for example the admission number is already taken, the
student is not created and the error tells you why.
