import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/shell/domain/account_delete_link.dart';

void main() {
  group('buildAccountDeleteUrl', () {
    test('builds /account/delete under the configured web base URL', () {
      final url = buildAccountDeleteUrl(webBaseUrl: Uri.parse('https://app.studafy.com'));

      expect(url.scheme, 'https');
      expect(url.host, 'app.studafy.com');
      expect(url.path, '/account/delete');
      expect(url.queryParameters, isEmpty);
    });
  });
}
