import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/update/release_config.dart';
import 'package:studafy_mobile/src/core/update/store_listing.dart';

void main() {
  test('iOS opens Studafy\'s App Store listing by its numeric id', () {
    expect(
      storeListingUri(MobilePlatform.ios).toString(),
      'https://apps.apple.com/app/id6826890449',
    );
  });

  test('Android opens the Play listing of the prod package', () {
    expect(
      storeListingUri(MobilePlatform.android).toString(),
      'https://play.google.com/store/apps/details?id=com.studafy.studafy_mobile',
    );
  });
}
