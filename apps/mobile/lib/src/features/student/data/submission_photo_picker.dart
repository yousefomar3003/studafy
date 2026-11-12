import 'package:image_picker/image_picker.dart';

/// Longest edge, in pixels, of a homework photo taken with the camera — the same as a chat image
/// (ChatImagePicker), so a phone's 12–48 MP photo is uploaded at a size that is still easy to read
/// but costs the school a fraction of the storage.
const double submissionPhotoMaxDimension = 2560;

/// JPEG quality of a homework photo, as for a chat image.
const int submissionPhotoQuality = 85;

/// Takes a photo for a hand-in, downscaled to [submissionPhotoMaxDimension] at
/// [submissionPhotoQuality]. Null when the student cancels. Camera permission errors surface as the
/// plugin's `PlatformException` (`camera_access_denied`).
Future<XFile?> takeSubmissionPhoto([ImagePicker? picker]) => (picker ?? ImagePicker()).pickImage(
  source: ImageSource.camera,
  maxWidth: submissionPhotoMaxDimension,
  maxHeight: submissionPhotoMaxDimension,
  imageQuality: submissionPhotoQuality,
);
