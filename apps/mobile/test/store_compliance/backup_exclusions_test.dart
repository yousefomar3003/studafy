import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// QA-080: cached school data (grades, announcements, materials) must not travel in an OS backup
/// or device transfer and come back on a restore. The cache itself lives in the cache directory,
/// which no backup includes; the Android rules exclude `files/` and `databases/` as well, so an
/// older build's copy is never backed up either.
void main() {
  test('Android backup and device transfer exclude files/ and databases/', () {
    final legacy = File('android/app/src/main/res/xml/backup_rules.xml').readAsStringSync();
    final extraction = File(
      'android/app/src/main/res/xml/data_extraction_rules.xml',
    ).readAsStringSync();

    for (final domain in ['file', 'database']) {
      final rule = '<exclude domain="$domain" path="." />';
      expect(legacy, contains(rule));
      // Once under <cloud-backup> and once under <device-transfer>.
      expect(rule.allMatches(extraction), hasLength(2), reason: domain);
    }
  });

  test('the offline cache and material files are stored in the cache directory', () {
    final database = File('lib/src/core/offline/offline_database.dart').readAsStringSync();
    final materials = File('lib/src/core/offline/material_file_cache.dart').readAsStringSync();

    for (final source in [database, materials]) {
      expect(source, contains('getApplicationCacheDirectory'));
    }
    // Application Support is only touched to delete what older builds left there.
    expect(materials, isNot(contains('getApplicationSupportDirectory')));
    expect(RegExp('getApplicationSupportDirectory').allMatches(database), hasLength(1));
  });
}
