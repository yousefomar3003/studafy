import 'package:file_picker/file_picker.dart';

/// A file the user picked from the device: its local path, display name and exact size in bytes.
///
/// The size is the upload's `Content-Length` (the pre-signed PUT is signed for it), so it is always
/// the real one read from the file -- never a placeholder.
typedef PickedFile = ({String path, String name, int sizeBytes});

/// Opens the system file picker and returns what the user chose -- several files, or at most one
/// when [multiple] is false. Empty when the user cancels.
///
/// A file without a local path, or whose size cannot be read, is left out rather than uploaded with
/// a wrong length.
Future<List<PickedFile>> pickLocalFiles({bool multiple = true}) async {
  final files = multiple
      ? await FilePicker.pickFiles()
      : [?await FilePicker.pickFile()];

  final picked = <PickedFile>[];
  for (final file in files) {
    final path = file.path;
    final size = await file.length();
    if (path != null && size != null) {
      picked.add((path: path, name: file.name, sizeBytes: size));
    }
  }
  return picked;
}
