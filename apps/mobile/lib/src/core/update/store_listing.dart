import 'release_config.dart';

/// The Play package id (the prod flavour has no suffix — see `android/app/build.gradle.kts`).
/// Overridable at build time only for completeness; the default is correct for every real build.
const String _androidPackageId = String.fromEnvironment(
  'ANDROID_PACKAGE_ID',
  defaultValue: 'com.studafy.studafy_mobile',
);

/// The App Store numeric id, assigned by Apple when the app is first created in App Store Connect.
/// Injected per build via `--dart-define=IOS_APP_STORE_ID=...`; empty until the listing exists,
/// in which case the forced-update screen falls back to a name-based App Store URL.
const String _iosAppStoreId = String.fromEnvironment('IOS_APP_STORE_ID');

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
      return _iosAppStoreId.isEmpty
          ? Uri.parse('https://apps.apple.com/app/studafy')
          : Uri.parse('https://apps.apple.com/app/id$_iosAppStoreId');
  }
}
