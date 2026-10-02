# Pre-submission reviewer walkthrough

Do what App Review and Play review will do, on a clean device, with the exact build being
submitted. Run it once per platform before every submission, after `review-checklist.md`. That file
covers the forms and policies; this one covers the running app.

A step passes only if what you see matches **Expected**. Write down anything else, even if it looks
harmless; reviewers do.

## Before you start

- **Build:** the archive/AAB being submitted, `prod` flavor, installed from TestFlight or Play
  internal testing, not a debug run from Xcode or Android Studio.
- **Clean device:** Studafy has never been installed on it, or the device has been erased. Deleting
  the app isn't enough on iOS, because the keychain (where `flutter_secure_storage` keeps the
  session) survives a reinstall. Use a physical device: push needs one on both platforms.
- **Android:** version 13 or later, so the notification permission prompt is exercised.
- **Accounts:** the four reviewer logins from `docs/runbooks/app-review-access.md`, verified with its
  step 4 `curl` the same day. A second device (or the web app) signed in as the teacher, to trigger a
  notification. A **disposable** account for the deletion step. Never delete a reviewer account.
- **Language:** run in English. If the Arabic listing ships, repeat steps 2–4 with the device set to
  Arabic.

## Steps

| #   | Step | Expected |
| --- | ---- | -------- |
| **1** | **Sign-in** | |
| 1.1 | Launch the app | Login screen: Sign in with Microsoft, Sign in with Google, Sign in with email, Privacy policy. No permission prompt of any kind. |
| 1.2 | Tap **Privacy policy** | `https://app.studafy.com/privacy` opens in the system browser and loads. |
| 1.3 | Tap **Sign in with Microsoft** | iOS: the Microsoft page opens in a sheet over the app (SFSafariViewController), not in Safari. Android: the browser app opens. |
| 1.4 | Close the sheet/browser without signing in, then tap **Cancel** under the spinner | Back on the login screen with "Sign-in was cancelled or failed." The app is not stuck. |
| 1.5 | **Sign in with email** as the student | Lands on the student shell (Home, Timetable, Courses, AI, Profile). |
| **2** | **Core path** (one pass per role; sign out between roles from Profile) | |
| 2.1 | Student: Home, Timetable, an assignment, Grades | Each loads seeded data with no error state. Dates are July 2026 (see the runbook's Known limitations). |
| 2.2 | Teacher: Classes → the Science class → **Take attendance**; then the grades and announcement icons in its app bar | Attendance, a grade and an announcement each save. |
| 2.3 | Teacher: the Science class → **Assignments and materials** icon → Materials tab → **Upload material** → **Camera** | iOS prompt reads: "Take a photo of a worksheet, whiteboard or handout and upload it to your class as course material." Android: the camera app opens with no permission prompt. |
| 2.4 | iOS only: deny camera at 2.3, then tap **Camera** again | Message: "Camera access is off. Turn it on in Settings > Studafy > Camera to take a photo." **Choose file** still works. |
| 2.5 | Parent: Children → Yara → Grades, Attendance tabs; Home → notifications card → Alerts tab | Data loads. The attendance alert threshold can be set from Alerts. |
| 2.6 | Administrator | View-only shell with the view-only banner and no edit controls. |
| **3** | **Push** (as the student, on the clean device) | |
| 3.1 | First time in the shell after sign-in | A banner at the top explains notifications and has one button, **Continue**. No OS prompt yet. |
| 3.2 | Tap **Continue** | The OS notification prompt appears. Allow it. The banner disappears. |
| 3.3 | From the second device, as the teacher, post a Science class announcement | The student device gets a notification (app in background) or an in-app banner (foreground). Tapping it opens the matching screen. |
| 3.4 | Kill and relaunch the app | No banner, no prompt. |
| 3.5 | Optional, second clean install: tap **Continue**, then **Don't Allow** | Banner gone and not shown on relaunch. The app works without push. |
| **4** | **AI consent** (as the student) | |
| 4.1 | AI tab | If the add-on is active: the feature grid. If not: the "isn't active" notice (go to step 6). |
| 4.2 | Open **Ask AI** | Consent modal before the screen. It names Anthropic and each data category, links to Anthropic's privacy policy, has **Allow** and **Don't allow**, and can't be dismissed by tapping outside. |
| 4.3 | **Don't allow** | Back out; no AI screen. Open it again: the modal shows again. |
| 4.4 | **Allow**, ask a question | An answer with citations. Its Report (flag) action is visible. |
| 4.5 | AI tab → privacy icon → **AI data sharing** → withdraw | Consent withdrawn. The next AI screen shows the modal again. |
| **5** | **School fee** (as the parent) | |
| 5.1 | Children → Yara → Finance | Invoices, fee schedule and receipts load. Amounts are the school's fees. |
| 5.2 | On an outstanding invoice, tap **Pay online** | The school's payment page opens in the system browser, not in the app. If no invoice shows the button, the seeded invoice has no `pay_online_url`; record that, since the reviewer won't see the button either. |
| **6** | **In-app purchase** | |
| 6.1 | Look for anything that sells, prices or links to the AI add-on or a plan, on every screen visited | Nothing. No price, no "subscribe", no link to the website. The not-active AI notice has no button or link. The app sells nothing, so there is no IAP to test. |
| **7** | **Privacy policy in the app** | |
| 7.1 | Profile → **Privacy policy** | Same URL as 1.2 opens in the system browser. |
| **8** | **Account deletion** (disposable account only) | |
| 8.1 | Profile → **Delete my account** | `/account/delete` opens in the system browser and explains the consequences. |
| 8.2 | Confirm | The request is accepted and a completion date is shown. Deletion revokes every session: back in the app, the next action should land on the login screen. Record what actually happens. |
| 8.3 | Open `https://app.studafy.com/legal/delete-account` signed out | The public deletion page loads (Play's Data safety URL). |
| **9** | **Metadata matches the build** | |
| 9.1 | Compare each screenshot in the upload set with the same screen in this build | Same layout, labels and features. No permission banner, debug banner or real student data. |
| 9.2 | Read `listing-metadata.md`'s description against what you saw | Every feature it names exists in this build. Nothing seen in the app contradicts it. |

## Sign-off

One row per platform. "Pass" means every step above passed. Otherwise list the failed step numbers
and the ticket raised for each.

| Platform | Build (version + build number) | Device and OS | Tester | Date | Result | Failed steps / tickets |
| -------- | ------------------------------ | ------------- | ------ | ---- | ------ | ---------------------- |
| iOS      |                                |               |        |      |        |                        |
| Android  |                                |               |        |      |        |                        |

**Not signed off yet.** As of 2026-10-02 there is no App Store Connect record, no Play Console
entry, and no build in either store (`store/README.md`), so there is nothing to install from
TestFlight or Play. Only the code-level checks below have been done.

## Code-level checks done for ST-310 (2026-10-02)

Verified by reading the code and by the test suite (`flutter test`: 559 passed, 16 skipped), on
Windows with no device:

- Purpose strings and permission prompts: `docs/permission_purpose_strings.md`.
- Sign-in no longer goes to Safari on iOS; the deep-link listener bug and the stuck spinner are
  fixed (`oauth_browser_test.dart`).
- The push prompt is explained first and set up after an in-session sign-in
  (`push_setup_test.dart`, `app_shell_test.dart`).
- Listing fields fit their limits (`listing_metadata_test.dart`). The subtitle (40 chars, limit 30)
  and Play short description (86, limit 80) were over and are rewritten; the offline claim is
  narrowed to what is cached.
- Screenshot plan names real screens (`StudentExamsScreen`, `StudentAttendanceScreen`,
  `ChildComparisonScreen` were wrong).

## Known blockers outside this walkthrough

Each of these fails the walkthrough or the submission regardless of how the app behaves. Owners
are in the linked documents.

1. **`app.studafy.com` had no DNS record** on 2026-10-01 (`listing-metadata.md`). Steps 1.2, 7.1, 8.1
   and 8.3 fail until it resolves.
2. **Support URL** `https://studafy.com/support` has not been checked (`listing-metadata.md`).
3. **Sign in with Apple** decision (guideline 4.8) is open (`review-checklist.md`).
4. **Children's-data counsel sign-off** is open (`docs/compliance/childrens-data-dossier.md`).
5. **Reviewer student's AI add-on** isn't confirmed. The AI seed activates the add-on for the first
   four seeded students; if Yara isn't one of them, step 4 can't be run with the reviewer account,
   and App Review can't reach the AI consent flow either.
6. **Xcode privacy report** for a SwiftPM archive hasn't been generated; the build links
   SDWebImage and the DK* pickers, which ST-308 assumed were excluded
   (`docs/permission_purpose_strings.md`, "What is not verified").
