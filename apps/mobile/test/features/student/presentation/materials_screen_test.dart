import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart' hide Material;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/material.dart';
import 'package:studafy_mobile/src/core/offline/cached_value.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/student/application/materials_providers.dart';
import 'package:studafy_mobile/src/features/student/application/student_context_providers.dart';
import 'package:studafy_mobile/src/features/student/presentation/materials_screen.dart';
import 'package:studafy_mobile/src/features/student/presentation/widgets/material_list_tile.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';

Material _material({
  required String id,
  required String title,
  String ingestStatus = 'ready',
  bool aiVisible = false,
  String mimeType = 'application/pdf',
  int sizeBytes = 204800,
}) {
  return Material.fromJson({
    'id': id,
    'school_id': 'school-1',
    'class_id': 'class-1',
    'uploaded_by_user_id': 'teacher-1',
    'last_edited_by_user_id': 'teacher-1',
    'title': title,
    'description': null,
    'storage_key': 'permanent/school-1/materials/$id.pdf',
    'original_file_name': '$id.pdf',
    'mime_type': mimeType,
    'size_bytes': sizeBytes,
    'checksum_sha256': null,
    'ai_visible': aiVisible,
    'ingest_status': ingestStatus,
    'ingest_error': null,
    'ingested_at': null,
    'created_at': '2026-01-01T00:00:00.000Z',
    'updated_at': '2026-01-01T00:00:00.000Z',
  });
}

Widget _screenScope(List<Override> overrides) {
  return wrapWithLocalization(
    ProviderScope(
      overrides: overrides,
      child: Builder(
        builder: (context) {
          return MaterialApp(
            theme: AppTheme.light,
            debugShowCheckedModeBanner: false,
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            home: const MaterialsScreen(),
          );
        },
      ),
    ),
  );
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets('shows the unavailable message when no class is resolved', (tester) async {
    await tester.pumpWidget(
      _screenScope([currentEnrolledClassIdsProvider.overrideWithValue(const [])]),
    );
    await tester.pumpAndSettle();

    expect(find.text("Your materials aren't available yet."), findsOneWidget);
  });

  testWidgets('renders a section per enrolled class with its materials', (tester) async {
    await tester.pumpWidget(
      _screenScope([
        currentEnrolledClassIdsProvider.overrideWithValue(const ['class-1']),
        materialsClassCodeProvider('class-1').overrideWith((ref) async => 'MATH101-A'),
        materialsForClassProvider('class-1').overrideWith(
          (ref) => Stream.value(
            CachedValue(
              data: [_material(id: 'material-1', title: 'Photosynthesis Study Guide')],
              fetchedAt: DateTime(2026, 8, 24, 8),
              source: CacheSource.network,
            ),
          ),
        ),
        materialDownloadedProvider('material-1').overrideWith((ref) async => false),
      ]),
    );
    await tester.pumpAndSettle();

    expect(find.text('MATH101-A'), findsOneWidget);
    expect(find.text('Photosynthesis Study Guide'), findsOneWidget);
    expect(find.byType(MaterialListTile), findsOneWidget);
  });

  testWidgets('shows a status pill and disables tapping a not-yet-ready material', (tester) async {
    await tester.pumpWidget(
      _screenScope([
        currentEnrolledClassIdsProvider.overrideWithValue(const ['class-1']),
        materialsClassCodeProvider('class-1').overrideWith((ref) async => 'MATH101-A'),
        materialsForClassProvider('class-1').overrideWith(
          (ref) => Stream.value(
            CachedValue(
              data: [
                _material(id: 'material-1', title: 'Lecture Slides', ingestStatus: 'scanning'),
              ],
              fetchedAt: DateTime(2026, 8, 24, 8),
              source: CacheSource.network,
            ),
          ),
        ),
        materialDownloadedProvider('material-1').overrideWith((ref) async => false),
      ]),
    );
    await tester.pumpAndSettle();

    expect(find.text('Scanning'), findsOneWidget);
    final tile = tester.widget<ListTile>(find.byType(ListTile));
    expect(tile.enabled, isFalse);
  });

  testWidgets('an empty class shows the empty-materials line', (tester) async {
    await tester.pumpWidget(
      _screenScope([
        currentEnrolledClassIdsProvider.overrideWithValue(const ['class-1']),
        materialsClassCodeProvider('class-1').overrideWith((ref) async => 'MATH101-A'),
        materialsForClassProvider('class-1').overrideWith(
          (ref) => Stream.value(
            CachedValue(
              data: const [],
              fetchedAt: DateTime(2026, 8, 24, 8),
              source: CacheSource.network,
            ),
          ),
        ),
      ]),
    );
    await tester.pumpAndSettle();

    expect(find.text('No materials yet.'), findsOneWidget);
  });
}
