---
title: "Timetable builder"
description: "How to build a weekly schedule: pick a term, create a draft, place classes, resolve conflicts, and submit for approval."
keywords: ["timetable", "schedule", "draft", "approval", "conflict", "period", "slot", "grid"]
order: 1
---

# Timetable builder

The timetable is built per term in Admin → Timetable builder. It is a
three-level drill-down: academic year, then term, then a draft version of that
term's schedule. You build on a grid of school days against periods, submit
for approval, and the approved version becomes the live schedule.

## Version lifecycle

A timetable has one or more versions per term. Non-draft versions are
read-only.

| State       | What it means                                   | Can you edit? |
| ----------- | ----------------------------------------------- | ------------- |
| `Draft`     | Working copy. Editable. Delete it or submit it. | Yes           |
| `Submitted` | Sent for review. Read-only.                     | No            |
| `Approved`  | Reviewed and live for the term. Read-only.      | No            |

A reviewed draft that is not accepted is sent back to `Draft` with a note
("Sent back: …") so you can fix it and resubmit.

## Building a schedule

1. Pick an **Academic year**, then a **Term**. The current year and term are
   selected automatically.
2. If no draft exists, click `New draft`, name it, and `Create draft`.
   (The setup wizard's timetable step also creates a draft version.)
3. Place classes on the grid — see below.
4. When the schedule is complete, `Submit for approval`.

## Placing classes

The grid shows school days as columns and periods as rows. The `Classes`
palette lists every schedulable class in the term.

- Drag a class chip onto a cell. A cell can hold several classes at once
  (multiple rooms running in parallel).
- Keyboard: press Enter/Space on a class chip to pick it up, then Enter/Space
  on a cell's `+` target to place it. Escape cancels the pick.
- Click a placed slot to change its **Teacher** and **Room** in `Edit slot`,
  or remove it. A slot always needs both a teacher and a room.
- Use `Add period` to extend the day and `Remove empty period` to trim the
  last row when it is empty.

## Conflicts

Before a slot is placed, Studafy checks that the teacher and the room are not
double-booked at the same day and period. A collision raises an alert, for
example:

> Teacher "Alex Davis" is already scheduled for class "MATH-A1" on Monday, period 2.

Dismiss the alert and place the class elsewhere, or change the conflicting
slot, then try again. Teacher conflicts are reported before room conflicts.

## After approval

An `Approved` version is the term's live schedule and is read-only. To change
it, create a new draft from the version bar and submit that for review. Do not
edit a live timetable directly.
