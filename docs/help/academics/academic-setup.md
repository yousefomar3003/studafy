---
title: "Set up subjects and grading scales"
description: "Create subjects, define grading scales, and set the grading rules each grade uses in Academic setup."
keywords:
  [
    "academic setup",
    "subject",
    "course",
    "grading scale",
    "grade scale",
    "grade bands",
    "gpa",
    "pass mark",
    "grading rules",
    "weighted categories",
  ]
title_ar: "إعداد المواد وسلالم الدرجات"
description_ar: "أنشئ المواد الدراسية، وحدّد سلالم الدرجات، واضبط قواعد التقييم لكل صف من صفحة الإعداد الأكاديمي."
keywords_ar:
  [
    "الإعداد الأكاديمي",
    "مادة دراسية",
    "المواد",
    "مقرر",
    "سلم الدرجات",
    "سلم التقديرات",
    "التقدير",
    "المعدل",
    "درجة النجاح",
    "قواعد التقييم",
    "الصف",
    "توزيع الدرجات",
  ]
roles: [PRINCIPAL, ORG_ADMIN]
action: set-up-academics
order: 2
---

# Set up subjects and grading scales

Principals and school admins set up how each grade is assessed. Teachers can
look but not change anything.

Open the principal portal: `Home` if you are a principal, or `Principal` in
the sidebar if you are the school admin.

## Before you start

- Your school needs an academic year. The onboarding wizard creates one.
- Your grades must exist. Add them on `Grades & sections →`.
- You can change the setup while the academic year is `Draft` or `Published`.
  A `Finalized` or `Archived` year is read-only.

## Create a subject

Subjects are created together with a course.

1. Click `Classes →`, then `Add class`.
2. Next to **Course**, click `Add new course`.
3. Under **Subject**, pick `New subject…` and enter the **Subject name** (for
   example Mathematics) and **Subject code** (for example MATH).
4. Enter the **Course name** (for example Algebra I) and **Course code** (for
   example MATH101).
5. Click `Add course`.

Every field is required, and each code must be unused. You can then finish
adding the class, or close the form.

## Create a grading scale

1. Click `Academic setup →`, pick the **Academic year**, and open the
   `Grading scales` tab.
2. Click `Add scale` and enter the **Scale name**.
3. Edit the bands. Each band has a **Label**, the percentage it starts **From**,
   and optional **GPA points**. The starting bands are A 90, B 80, C 70, D 60
   and F 0. Use `Add band` for more.
4. Click `Save scale`.

The lowest band must start at 0%, and no two bands may share a starting
percentage or a label. The form checks this as you type.

## Set up a grade

1. In `Academic setup →`, open the `Grades & subjects` tab and pick the
   **Grade**.
2. Fill in the grade's policies: the **Default grading scale**, rounding, and
   whether marks need approval before results are finalized.
3. Click `Set up grade` (or `Save policies` once it is set up).

## Add subjects to a grade

1. Under the grade's subjects, choose a subject in **Add a subject** and click
   `Set up subject`.
2. Choose the **Requirement** (Mandatory, Optional or Elective), the **Grading
   method** (Weighted categories or Total points), the **Maximum marks**, the
   **Pass percentage** and the **Grading scale**.
3. Add the assessment categories with `Add category`. Weighted categories must
   add up to 100%.
4. Click `Save`.

In a `Draft` year you can save rules that still have problems and fix them
later. In a `Published` year every problem must be fixed before saving.
