import 'dart:async';
import 'dart:io';

import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart' hide Material;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/material.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/student/application/materials_providers.dart';
import 'package:studafy_mobile/src/features/student/presentation/material_viewer_screen.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';

Material _material({
  required String id,
  String title = 'Photosynthesis Study Guide',
  String ingestStatus = 'ready',
  bool aiVisible = false,
  String mimeType = 'application/pdf',
}) {
  return Material.fromJson({
    'id': id,
    'school_id': 'school-1',
    'class_id': 'class-1',
    'uploaded_by_user_id': 'teacher-1',
    'last_edited_by_user_id': 'teacher-1',
    'title': title,
    'description': 'Chapters 1 through 4.',
    'storage_key': 'permanent/school-1/materials/$id.pdf',
    'original_file_name': '$id.pdf',
    'mime_type': mimeType,
    'size_bytes': 204800,
    'checksum_sha256': null,
    'ai_visible': aiVisible,
    'ingest_status': ingestStatus,
    'ingest_error': null,
    'ingested_at': null,
    'created_at': '2026-01-01T00:00:00.000Z',
    'updated_at': '2026-01-01T00:00:00.000Z',
  });
}

Widget _screenScope(Material material, {List<Override> overrides = const []}) {
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
            home: MaterialViewerScreen(material: material),
          );
        },
      ),
    ),
  );
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets('shows the pending-scan message and no preview before the file is ready', (
    tester,
  ) async {
    await tester.pumpWidget(_screenScope(_material(id: 'm1', ingestStatus: 'uploaded')));
    await tester.pumpAndSettle();

    expect(find.text('Pending scan'), findsOneWidget);
    expect(find.text('This file is still being processed. Check back soon.'), findsOneWidget);
  });

  testWidgets('shows the blocked message for a quarantined material', (tester) async {
    await tester.pumpWidget(_screenScope(_material(id: 'm1', ingestStatus: 'quarantined')));
    await tester.pumpAndSettle();

    expect(
      find.text("This file was blocked by a security scan and can't be opened."),
      findsOneWidget,
    );
  });

  testWidgets('shows the AI-visible note for a ready, AI-visible material', (tester) async {
    await tester.pumpWidget(
      _screenScope(
        _material(id: 'm1', ingestStatus: 'ready', aiVisible: true, mimeType: 'application/msword'),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text("Included in the AI assistant's study materials."), findsOneWidget);
  });

  testWidgets('offers an external-open action for a ready file with no in-app preview', (
    tester,
  ) async {
    await tester.pumpWidget(
      _screenScope(_material(id: 'm1', ingestStatus: 'ready', mimeType: 'application/msword')),
    );
    await tester.pumpAndSettle();

    expect(find.text('Open with another app'), findsOneWidget);
    expect(find.text('No in-app preview for this file type.'), findsOneWidget);
  });

  testWidgets('shows a spinner while a PDF download is in flight', (tester) async {
    await tester.pumpWidget(
      _screenScope(
        _material(id: 'm1', ingestStatus: 'ready'),
        overrides: [
          ensureMaterialDownloadedProvider('m1').overrideWith((ref) => Completer<File>().future),
        ],
      ),
    );
    await tester.pump();

    expect(find.byType(CircularProgressIndicator), findsOneWidget);
  });

  testWidgets('shows a retry action when the download fails', (tester) async {
    await tester.pumpWidget(
      _screenScope(
        _material(id: 'm1', ingestStatus: 'ready'),
        overrides: [
          ensureMaterialDownloadedProvider('m1').overrideWith((ref) async {
            throw Exception('network error');
          }),
        ],
      ),
    );
    await tester.pumpAndSettle();

    expect(
      find.text("Couldn't download this file. Check your connection and try again."),
      findsOneWidget,
    );
    expect(find.widgetWithText(OutlinedButton, 'Retry'), findsOneWidget);
  });
}
