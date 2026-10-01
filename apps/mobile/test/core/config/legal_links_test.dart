import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/config/legal_links.dart';

void main() {
  final webBaseUrl = Uri.parse('https://app.studafy.com');

  group('buildAccountDeleteUrl', () {
    test('builds /account/delete under the configured web base URL', () {
      final url = buildAccountDeleteUrl(webBaseUrl: webBaseUrl);

      expect(url.scheme, 'https');
      expect(url.host, 'app.studafy.com');
      expect(url.path, '/account/delete');
      expect(url.queryParameters, isEmpty);
    });
  });

  group('buildPrivacyPolicyUrl', () {
    test('builds /privacy under the configured web base URL', () {
      final url = buildPrivacyPolicyUrl(webBaseUrl: webBaseUrl);

      expect(url.toString(), 'https://app.studafy.com/privacy');
    });
  });
}
