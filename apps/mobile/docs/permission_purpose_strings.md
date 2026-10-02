# Permission purpose strings (ST-310)

Every OS permission the app can request, the text the user sees, where in the app it is asked, and
what happens when the user says no. Also covers the sign-in browser, which App Review checks along
with permissions.

Checked against the code on 2026-10-02. Re-check whenever a dependency that touches the camera,
photos, files or notifications changes, or a new `Info.plist` key or manifest permission appears.
`test/store_compliance/permission_purpose_strings_test.dart` fails if the declared set drifts.

## Summary

| Permission              | iOS                                            | Android                                    | Asked when                                                                 |
| ----------------------- | ---------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------- |
| Camera                  | `NSCameraUsageDescription`, shown by iOS       | None. Capture runs in the system camera app | Teacher taps **Camera** in Upload material                                 |
| Notifications           | iOS standard prompt (no custom string allowed) | `POST_NOTIFICATIONS` on Android 13+        | User taps **Continue** on the in-app explanation banner, after sign-in     |
| Photo library           | `NSPhotoLibraryUsageDescription`, never shown  | None                                       | Never. Declared because linked code references the API (see below)         |
| Music / media library   | `NSAppleMusicUsageDescription`, never shown    | None                                       | Never. Same reason                                                          |
| Files / storage         | None needed                                    | None needed                                | n/a. The system document picker grants access to the chosen file only      |

Nothing else is requested: no location, contacts, microphone, Bluetooth, tracking (ATT) or
biometrics. `NSUserTrackingUsageDescription` must stay absent (`child_directed_sdks_test.dart`).

## Camera

**iOS string** (`ios/Runner/Info.plist`):

> Take a photo of a worksheet, whiteboard or handout and upload it to your class as course material.

- **Where it's asked:** Classes → a class → Materials → **Upload material** → **Camera**
  (`teacher_content_screen.dart`, `_takePhoto`). This is the only `ImagePicker` call site in the app,
  and it uses `ImageSource.camera`. iOS shows its prompt at that tap, the first time only.
- **Who sees it:** teachers and teaching assistants. Students, parents and the view-only shell have
  no camera entry point.
- **If declined:** iOS won't show the prompt again; `image_picker` throws `camera_access_denied`.
  The screen now shows "Camera access is off. Turn it on in Settings > Studafy > Camera to take a
  photo." **Choose file** still works. (Before this ticket the exception was unhandled and the
  button did nothing.)
- **Android:** the manifest no longer declares `CAMERA`. `image_picker` asks for `CAMERA` at runtime
  only when the app declares it (`ImagePickerUtils.needRequestCameraPermission`); otherwise it
  sends `ACTION_IMAGE_CAPTURE` to the camera app, which needs no permission. The declaration was
  adding a prompt and a listed permission with no benefit.

## Notifications

**What the user reads first** (`shell.pushPermission.body`, en and ar):

> Get a notification when a grade is posted, an assignment is due soon, or your school sends an
> announcement or attendance alert. Your phone will ask for permission next.

This matches what the API sends: `GRADE_POSTED`, `ASSIGNMENT_DUE_SOON`, `ANNOUNCEMENT`,
`ATTENDANCE_ALERT` (`apps/api/src/modules/notifications`). Teachers also get material-processing
notices; the copy doesn't promise them.

- **Where it's asked:** once signed in, the shell shows `PushPermissionBanner` at the top while the
  OS prompt is unanswered (`PushSetup.needsPermission`). Tapping **Continue** shows the OS prompt.
  Nothing prompts before sign-in, and nothing prompts without the explanation first.
- **Why there's no "Not now":** App Review rejects a pre-permission screen that lets the user back
  out before the system prompt (5.1.1(iv); the reviewer note asks for "Continue" or "Next"). The
  user still refuses in the OS prompt, or just leaves the banner untapped.
- **How "unanswered" is decided** (`FirebasePushService.canRequestPermission`): iOS reports
  `notDetermined` until the prompt is shown. Android 13+ reports a never-asked
  `POST_NOTIFICATIONS` as `denied`, the same as a refusal, so the app stores
  `push_permission_requested` in secure storage when it asks. Android 12 and lower grant
  notifications at install, so no banner or prompt appears there.
- **If declined:** the banner goes away and is not shown again. Turning notifications on later is
  done in system Settings; there is no in-app toggle.
- **Android string:** Android has no developer-supplied purpose string. The system dialog says
  "Allow Studafy to send you notifications?" The in-app banner is the explanation.

Before this ticket, `initialize()` asked for permission the moment a session was authenticated, with
no explanation, and only if the session existed when the app mounted. A user who signed in during
the session (a clean install) was not set up for push until the next launch. Push setup now starts
from an auth-status listener in `app.dart`.

## Photo library and music library (declared, never shown)

> Studafy only opens a photo you choose to upload to your class as course material.

> Studafy only opens an audio file you choose to upload to your class as course material.

The app never asks for either. They are declared because App Store Connect scans the binary and
refuses an upload that links a privacy-sensitive API without its key (ITMS-90683), whether or not
the app calls it. Two linked plugins do that:

- **`image_picker_ios` 0.8.13+7** calls `PHPhotoLibrary requestAuthorization` in its legacy
  gallery path (`FLTImagePickerPlugin.m`, `checkPhotoAuthorizationWithImagePicker`). It is compiled
  in no matter how `image_picker` is used.
- **`file_picker` 11.0.3** under Swift Package Manager. Its `Package.swift` always defines
  `PICKER_MEDIA` and `PICKER_AUDIO` and depends on DKImagePickerController, so the photo and
  `MPMediaPickerController` paths are compiled in. `ios/Podfile`'s `Pod::PICKER_MEDIA = false` /
  `Pod::PICKER_AUDIO = false` only take effect in a CocoaPods build. The Xcode project is wired for
  SwiftPM (`FlutterGeneratedPluginSwiftPackage` in `project.pbxproj`), and SwiftPM is on by default
  on stable since Flutter 3.44.0 (flutter/flutter#184495). CI releases with 3.44.8.

The strings say what would happen if either picker were ever shown. The app only calls
`FilePicker.pickFiles` with the default `FileType.any` (the iOS document picker), so they are not
shown today. If a screen ever offers gallery or audio picking, re-read both strings against what
that screen does.

ST-308's documents said these keys "should not" be declared. That was true for a CocoaPods build,
and it is not what CI produces. `store/privacy-labels.md` and `sdk_compliance_inventory.md` are
corrected in this change.

## Files and storage

No permission on either platform. iOS: `UIDocumentPickerViewController`. Android: the Storage
Access Framework picker (`file_picker`), which returns a grant for the chosen file only. The
manifest declares no `READ_EXTERNAL_STORAGE`, `READ_MEDIA_*` or `WRITE_EXTERNAL_STORAGE`, and the
test fails if one is added.

## Android permissions in the shipped APK

The source manifest declares `INTERNET` and `RECEIVE_BOOT_COMPLETED`. Plugins add `POST_NOTIFICATIONS`,
`ACCESS_NETWORK_STATE`, `WAKE_LOCK`, `VIBRATE` and `com.google.android.c2dm.permission.RECEIVE` at
merge time (`docs/sdk_compliance_inventory.md`). Of these, only `POST_NOTIFICATIONS` is a runtime
permission the user is asked about. `AD_ID` is stripped with `tools:node="remove"`.

## Sign-in browser (no external-browser auth)

Before this ticket, Microsoft and Google sign-in opened with `LaunchMode.externalApplication`:
Mobile Safari on iOS and the default browser app on Android. The code comments and
`sdk_compliance_inventory.md` said ASWebAuthenticationSession and Custom Tabs; neither was true.
App Review rejects login that sends the user out to Safari (guideline 4.0).

Now (`lib/src/core/auth/oauth_browser.dart`):

- **iOS:** `LaunchMode.inAppBrowserView`, which is `SFSafariViewController` presented over the app.
  The sheet is closed when the callback arrives. It is a system browser, not a webview, so Google
  and Microsoft accept it.
- **Android:** unchanged, the default browser app, returning through the `studafy://auth/callback`
  intent filter. Google Play has no rule against it. Custom Tabs would keep the user in the app
  visually, but the callback would land in a `singleTop` activity that isn't on top of the task,
  and that wasn't tested on a device.
- **Cancel:** closing the browser without signing in sends no callback, so the login spinner now
  has a **Cancel** button (`AuthNotifier.cancelLogin`).
- **Bug fixed on the way:** `authorize()` returned `completer.future` from inside `try/finally`
  without `await`, so the `finally` cancelled the deep-link listener as soon as the browser opened.
  The callback could never be received. The integration suite swaps in `FakeOAuthBrowser`, so it
  never ran the real path. `test/core/auth/oauth_browser_test.dart` now covers it.
- **The reviewer path never opens a browser:** reviewers use **Sign in with email**
  (`POST /api/auth/login/review`, `docs/runbooks/app-review-access.md`).

The only other browser hand-offs are documented outbound links (privacy policy, account deletion,
school-fee payment, file downloads, store listing). `payment_routing_test.dart` allows the in-app
browser view for sign-in only.

## What is not verified

All of the above is checked in code and by unit and widget tests on Windows. None of it has run on
an iPhone or an Android 13+ device yet. These three need a device:

1. The iOS sign-in round trip in `SFSafariViewController`, including the "Open in Studafy?"
   confirmation iOS may show for the custom-scheme redirect.
2. The Android 13+ notification prompt appearing after **Continue**, and not again after a refusal.
3. App Store Connect accepting the upload without an ITMS-90683 email, and Xcode's privacy report
   for the archive (see `store/privacy-labels.md`, open item 1). Under SwiftPM the archive also
   links DKImagePickerController, DKPhotoGallery, SDWebImage and SwiftyGif. ST-308's manifest
   inventory assumed they were excluded. SDWebImage is on Apple's list of SDKs that need a privacy
   manifest; confirm the report lists one for it.

These are steps in `store/reviewer-walkthrough.md`.
