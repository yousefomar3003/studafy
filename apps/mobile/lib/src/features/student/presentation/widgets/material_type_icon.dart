import 'package:flutter/material.dart';

/// Broad file-type buckets a material's `mime_type` sorts into, for icon selection and deciding
/// whether it gets an in-app preview. Not modeled against specific MIME strings one by one: the
/// server's `material.file` content class (`apps/api/src/modules/storage/content-classes.ts`)
/// already constrains what can be uploaded, so a simple prefix match here is enough.
enum MaterialFileKind { pdf, image, video, audio, document, other }

MaterialFileKind materialFileKindFor(String mimeType) {
  if (mimeType == 'application/pdf') return MaterialFileKind.pdf;
  if (mimeType.startsWith('image/')) return MaterialFileKind.image;
  if (mimeType.startsWith('video/')) return MaterialFileKind.video;
  if (mimeType.startsWith('audio/')) return MaterialFileKind.audio;
  if (mimeType.startsWith('text/') || mimeType.contains('word') || mimeType.contains('document')) {
    return MaterialFileKind.document;
  }
  return MaterialFileKind.other;
}

/// The icon representing [mimeType] on a materials list row or the viewer screen.
IconData materialTypeIconFor(String mimeType) => switch (materialFileKindFor(mimeType)) {
  MaterialFileKind.pdf => Icons.picture_as_pdf,
  MaterialFileKind.image => Icons.image,
  MaterialFileKind.video => Icons.videocam,
  MaterialFileKind.audio => Icons.audiotrack,
  MaterialFileKind.document => Icons.description,
  MaterialFileKind.other => Icons.insert_drive_file_outlined,
};
