import 'dart:io';

import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/attachments/domain/attachment_kind.dart';
import 'package:studafy_mobile/src/features/attachments/presentation/attachment_viewer_screen.dart';
import 'package:studafy_mobile/src/features/student/presentation/widgets/attachment_download_tile.dart';

import '../../support/wrap_with_localization.dart' as l10n;

/// [home] in a localized MaterialApp wired to EasyLocalization's context, so it rebuilds once
/// the translations have loaded (as the real app does).
Widget wrapWithLocalization(Widget home) {
  final app = home is MaterialApp ? home.home! : home;
  return l10n.wrapWithLocalization(
    Builder(
      builder: (context) => MaterialApp(
        locale: context.locale,
        supportedLocales: context.supportedLocales,
        localizationsDelegates: context.localizationDelegates,
        home: app,
      ),
    ),
  );
}

void main() {
  group('attachmentKindOf', () {
    test('classifies by MIME type, then by extension', () {
      expect(attachmentKindOf('application/pdf', 'a.pdf'), AttachmentKind.pdf);
      expect(attachmentKindOf('image/png', 'scan'), AttachmentKind.image);
      expect(
        attachmentKindOf(
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'فلسطين كما خلقها الله.docx',
        ),
        AttachmentKind.document,
      );
      // Some phones upload everything as octet-stream: the extension still decides.
      expect(attachmentKindOf('application/octet-stream', 'Slides.PPTX'), AttachmentKind.document);
      expect(attachmentKindOf('application/octet-stream', 'notes.txt'), AttachmentKind.text);
      expect(attachmentKindOf('application/zip', 'bundle.zip'), AttachmentKind.other);
    });

    test('the local cache name is one safe path segment that keeps the extension', () {
      expect(safeLocalFileName('../../etc/passwd.docx'), '_.._etc_passwd.docx');
      expect(safeLocalFileName('فلسطين.docx'), 'فلسطين.docx');
      expect(safeLocalFileName(''), 'file');
    });
  });

  group('AttachmentDownloadTile', () {
    Future<void> pumpTile(WidgetTester tester, AttachmentAvailability availability) async {
      await tester.pumpWidget(
        wrapWithLocalization(
          MaterialApp(
            home: Scaffold(
              body: AttachmentDownloadTile(
                attachmentId: 'att-1',
                fileName: 'homework.docx',
                mimeType:
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                sizeBytes: 2048,
                downloadUrl: availability == AttachmentAvailability.ready
                    ? 'https://storage.example/homework.docx'
                    : null,
                availability: availability,
              ),
            ),
          ),
        ),
      );
      // Not pumpAndSettle: the "checking" spinner animates for as long as it is shown.
      for (var i = 0; i < 5; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    testWidgets('while the scan runs it says so instead of looking dead', (tester) async {
      await pumpTile(tester, AttachmentAvailability.checking);
      expect(find.text('Being checked for safety…'), findsOneWidget);
      await tester.tap(find.text('homework.docx'));
      await tester.pump();
      expect(find.byType(AttachmentViewerScreen), findsNothing);
    });

    testWidgets('a ready file opens in the in-app viewer', (tester) async {
      await pumpTile(tester, AttachmentAvailability.ready);
      await tester.tap(find.text('homework.docx'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.byType(AttachmentViewerScreen), findsOneWidget);
    });

    testWidgets('a file that failed its scan says it cannot be opened', (tester) async {
      await pumpTile(tester, AttachmentAvailability.unavailable);
      expect(find.text("This file can't be opened"), findsOneWidget);
    });
  });

  group('AttachmentViewerScreen', () {
    testWidgets('a Word file is not downloaded into the app: it offers Open', (tester) async {
      var resolved = 0;
      await tester.pumpWidget(
        wrapWithLocalization(
          AttachmentViewerScreen(
            attachmentId: 'att-docx',
            fileName: 'فلسطين كما خلقها الله.docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            resolveUrl: () async {
              resolved++;
              return null;
            },
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('attachmentOpenButton')), findsOneWidget);
      expect(find.text("This file opens in your phone's app for it."), findsOneWidget);
      // Nothing fetched until the student asks to open it.
      expect(resolved, 0);
    });

    testWidgets('shows a text file from the cache, with "Open in another app" available', (
      tester,
    ) async {
      final dir = await tester.runAsync(() => Directory.systemTemp.createTemp('viewer'));
      await tester.runAsync(() async {
        final file = File('${dir!.path}/attachments/att-txt/notes.txt');
        await file.create(recursive: true);
        await file.writeAsString('Read chapter 3');
      });

      await tester.pumpWidget(
        wrapWithLocalization(
          MaterialApp(
            home: AttachmentViewerScreen(
              attachmentId: 'att-txt',
              fileName: 'notes.txt',
              mimeType: 'text/plain',
              resolveUrl: () async => null,
              cacheDirectory: () async => dir!,
            ),
          ),
        ),
      );
      // Real file IO completes only while the test lets real time pass.
      for (var i = 0; i < 30 && find.text('Read chapter 3').evaluate().isEmpty; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
        await tester.pump();
      }

      expect(find.text('Read chapter 3'), findsOneWidget);
      expect(find.byKey(const Key('attachmentOpenExternally')), findsOneWidget);
    });

    testWidgets('a file with no URL and nothing cached says it is not available', (tester) async {
      final dir = await tester.runAsync(() => Directory.systemTemp.createTemp('viewer'));
      await tester.pumpWidget(
        wrapWithLocalization(
          MaterialApp(
            home: AttachmentViewerScreen(
              attachmentId: 'att-none',
              fileName: 'gone.pdf',
              mimeType: 'application/pdf',
              resolveUrl: () async => null,
              cacheDirectory: () async => dir!,
            ),
          ),
        ),
      );
      for (var i = 0; i < 5; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
        await tester.pump();
      }

      expect(find.text("This file isn't available right now."), findsOneWidget);
      expect(find.text('Try again'), findsOneWidget);
    });
  });
}
