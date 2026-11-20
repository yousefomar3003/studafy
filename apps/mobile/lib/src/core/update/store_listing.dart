import 'release_config.dart';

/// The Play package id (the prod flavour has no suffix — see `android/app/build.gradle.kts`).
/// Overridable at build time only for completeness; the default is correct for every real build.
const String _androidPackageId = String.fromEnvironment(
  'ANDROID_PACKAGE_ID',
  defaultValue: 'com.studafy.studafy_mobile',
);

/// The App Store numeric id Apple assigned to Studafy in App Store Connect (app 6826890449).
/// The release builds never passed `--dart-define=IOS_APP_STORE_ID`, so the default is the real id:
/// a name-based `apps.apple.com/app/studafy` URL is not a valid listing and the forced-update
/// screen's Update button would lead nowhere.
const String _iosAppStoreId = String.fromEnvironment(
  'IOS_APP_STORE_ID',
  defaultValue: '6826890449',
);

/// Where the forced-update screen sends a user to get a supported build. `https` listing URLs,
/// not `market:` / `itms-apps:` deep links: `launchUrl(..., externalApplication)` already hands
/// an `apps.apple.com` / `play.google.com` URL to the Store app on device, and the `https` form
/// is also openable in a test or desktop context.
Uri storeListingUri(MobilePlatform platform) {
  switch (platform) {
    case MobilePlatform.android:
      return Uri.parse(
        'https://play.google.com/store/apps/details?id=$_androidPackageId',
      );
    case MobilePlatform.ios:
      return Uri.parse('https://apps.apple.com/app/id$_iosAppStoreId');
  }
}
