---
title: "Timetable"
description: "How to build and change the weekly timetable: set the school week, edit a draft, add lessons, resolve clashes, and publish."
keywords:
  [
    "timetable",
    "schedule",
    "draft",
    "publish",
    "conflict",
    "period",
    "lesson",
    "school week",
    "grid",
  ]
order: 1
---

# Timetable

The weekly timetable lives in Admin → Timetable, and principals have the same
screen under Principal → Timetable. Pick an **Academic year** and a **Term**;
the current ones are selected automatically. Everyone sees the term's live
timetable, and you can narrow it to one **Class** or one **Teacher**.

Org admins and principals can change it. Other roles see it read-only.

## How changes reach teachers and students

You never edit the live timetable directly. Changes go through a draft:

1. Click `Edit timetable`. Studafy opens a draft copy of the live timetable.
2. Add, move, change, or remove lessons. Teachers and students keep seeing the
   live timetable while you work.
3. Click `Publish`. The draft becomes the live timetable straight away.

`Discard draft` throws away every unpublished change and leaves the live
timetable as it is. If you leave and come back, `Continue editing` reopens the
same draft.

A term with no timetable yet shows `Create timetable`, which starts an empty
draft.

## School week

`School week` sets the days your school teaches and the number of periods in a
day. The grid shows exactly those days as columns and those periods as rows.
The default is Sunday to Thursday; use the presets or tick the days yourself.

Changing the school week never deletes lessons. If a day you remove still has
lessons, its column stays visible (in italics) until they are moved.

## Adding and changing lessons

While editing a draft:

- **Add a lesson:** hover a cell and click `+`, then choose the **Class**. Its
  usual teacher and room are filled in; change them if needed, and `Add lesson`.
- **Drag a class:** drag a chip from the `Classes` palette onto a cell. It is
  placed with the class's usual teacher and room.
- **Keyboard:** press Enter/Space on a class chip to pick it up, then
  Enter/Space on a cell's `+` to place it. Escape cancels the pick.
- **Change or move a lesson:** click it to open `Edit slot`. You can change the
  class, teacher, room, day, or period, or `Remove` the lesson.

A cell can hold several lessons at once, for classes running in parallel in
different rooms. Lessons for the same course share a colour, and today's column
is highlighted.

## Clashes

Before a lesson is saved, Studafy checks that the teacher and the room are not
already booked at that day and period. A clash raises an alert, for example:

> Teacher "Alex Davis" is already scheduled for class "MATH-A1" on Monday, period 2.

The lesson it clashes with is outlined in red. Dismiss the alert, then move one
of the two lessons or change its teacher or room. Teacher clashes are reported
before room clashes.

## Submitted timetables

Timetables submitted for review through the older two-step flow show as
`Submitted`. Use `Approve and publish` to make one live, or `Send back to draft`
to keep editing it.

## Export

`Export CSV` downloads the lessons on screen (day, period, class, teacher,
employee number, room), respecting the class and teacher filters.
