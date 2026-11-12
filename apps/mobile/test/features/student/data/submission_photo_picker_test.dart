import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker/image_picker.dart';
import 'package:studafy_mobile/src/features/student/data/submission_photo_picker.dart';

/// Records what the screen asks the camera for, without the platform plugin.
class _RecordingPicker extends ImagePicker {
  ImageSource? source;
  double? maxWidth;
  double? maxHeight;
  int? imageQuality;

  @override
  Future<XFile?> pickImage({
    required ImageSource source,
    double? maxWidth,
    double? maxHeight,
    int? imageQuality,
    CameraDevice preferredCameraDevice = CameraDevice.rear,
    bool requestFullMetadata = true,
  }) async {
    this.source = source;
    this.maxWidth = maxWidth;
    this.maxHeight = maxHeight;
    this.imageQuality = imageQuality;
    return XFile('/tmp/homework.jpg', name: 'homework.jpg');
  }
}

void main() {
  test('a homework photo is shrunk like a chat image', () async {
    final picker = _RecordingPicker();

    final photo = await takeSubmissionPhoto(picker);

    expect(photo?.name, 'homework.jpg');
    expect(picker.source, ImageSource.camera);
    expect(picker.maxWidth, 2560);
    expect(picker.maxHeight, 2560);
    expect(picker.imageQuality, 85);
  });
}
