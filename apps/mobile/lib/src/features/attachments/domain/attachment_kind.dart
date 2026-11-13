/// How the in-app attachment viewer can show a file.
enum AttachmentKind { pdf, image, text, document, other }

/// Whether an attachment can be opened, as the API reports it (`download_state`).
enum AttachmentAvailability { ready, checking, unavailable }

const _documentExtensions = {
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'rtf',
  'pages',
  'numbers',
  'key',
  'odt',
  'ods', //
  'odp',
};
const _textExtensions = {'txt', 'csv', 'md'};
const _imageExtensions = {
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'heic',
  'heif',
  'bmp',
};

/// Classifies by MIME type first, then by the file name's extension (uploads from some phones
/// arrive as application/octet-stream).
AttachmentKind attachmentKindOf(String mimeType, String fileName) {
  final mime = mimeType.toLowerCase();
  final dot = fileName.lastIndexOf('.');
  final ext = dot < 0 ? '' : fileName.substring(dot + 1).toLowerCase();

  if (mime == 'application/pdf' || ext == 'pdf') return AttachmentKind.pdf;
  if (mime.startsWith('image/') || _imageExtensions.contains(ext)) {
    return AttachmentKind.image;
  }
  if (mime == 'text/plain' ||
      mime == 'text/csv' ||
      _textExtensions.contains(ext)) {
    return AttachmentKind.text;
  }
  if (mime.contains('officedocument') ||
      mime.contains('msword') ||
      mime.contains('ms-excel') ||
      mime.contains('ms-powerpoint') ||
      mime.contains('opendocument') ||
      mime == 'application/rtf' ||
      _documentExtensions.contains(ext)) {
    return AttachmentKind.document;
  }
  return AttachmentKind.other;
}
