/// Formats [bytes] as a short human-readable size — "480 B", "12.3 KB", "4 MB" — for attachment
/// rows. Not localized: byte-count units (B/KB/MB) read the same in both of the app's locales.
String formatFileSize(int bytes) {
  if (bytes < 1024) return '$bytes B';
  final kb = bytes / 1024;
  if (kb < 1024) return '${kb.toStringAsFixed(kb < 10 ? 1 : 0)} KB';
  final mb = kb / 1024;
  return '${mb.toStringAsFixed(mb < 10 ? 1 : 0)} MB';
}
