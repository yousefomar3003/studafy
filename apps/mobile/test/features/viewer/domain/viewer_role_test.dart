import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/viewer/domain/viewer_role.dart';

void main() {
  group('resolveViewerRole', () {
    test('org admin claim resolves to the admin summary', () {
      expect(resolveViewerRole(['ORG_ADMIN']), ViewerRole.admin);
    });

    test('super admin claim resolves to the admin summary', () {
      expect(resolveViewerRole(['SUPER_ADMIN']), ViewerRole.admin);
    });

    test('finance claim resolves to the finance summary', () {
      expect(resolveViewerRole(['FINANCE']), ViewerRole.finance);
    });

    test('support agent claim has no summary yet', () {
      expect(resolveViewerRole(['SUPPORT_AGENT']), ViewerRole.unsupported);
    });

    test('guest claim has no summary yet', () {
      expect(resolveViewerRole(['GUEST']), ViewerRole.unsupported);
    });

    test('no roles at all has no summary yet', () {
      expect(resolveViewerRole(const []), ViewerRole.unsupported);
    });

    test('an unrecognized claim has no summary yet', () {
      expect(resolveViewerRole(['SOME_FUTURE_ROLE']), ViewerRole.unsupported);
    });

    test('an admin claim wins over a finance claim on the same session', () {
      expect(resolveViewerRole(['FINANCE', 'ORG_ADMIN']), ViewerRole.admin);
    });

    test('a teaching role alongside finance does not change the finance summary', () {
      // Mirrors the shell's own priority: only an admin-type role changes what a non-admin
      // role sees here. A session holding FINANCE and a teaching role never reaches this
      // shell in practice (resolveShellRole sends it to the teacher shell instead), but the
      // resolver itself stays admin-first, finance-second regardless.
      expect(resolveViewerRole(['FINANCE', 'INSTRUCTOR']), ViewerRole.finance);
    });
  });
}
