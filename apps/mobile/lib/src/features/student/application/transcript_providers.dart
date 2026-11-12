import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/authenticated_dio.dart';
import '../data/transcript_client.dart';
import '../domain/transcript.dart';

/// [TranscriptClient] on its own [authenticatedDio], like `academicResultsClientProvider`.
final transcriptClientProvider = Provider<TranscriptClient>((ref) {
  return TranscriptClient(authenticatedDio(ref));
});

/// A student's transcripts, newest first — the signed-in student's own or a parent's child.
final studentTranscriptsProvider = FutureProvider.autoDispose
    .family<List<AcademicTranscript>, String>((ref, studentId) async {
      final transcripts = await ref
          .watch(transcriptClientProvider)
          .fetchTranscripts(studentId);
      return transcripts..sort((a, b) {
        final aTime = a.issuedAt ?? DateTime.fromMillisecondsSinceEpoch(0);
        final bTime = b.issuedAt ?? DateTime.fromMillisecondsSinceEpoch(0);
        return bTime.compareTo(aTime);
      });
    });

/// One transcript exactly as issued.
final academicTranscriptProvider = FutureProvider.autoDispose
    .family<AcademicTranscript, String>((ref, transcriptId) {
      return ref.watch(transcriptClientProvider).fetchTranscript(transcriptId);
    });
