import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/confirm_submission_attachment_body.dart';
import 'package:studafy_mobile/src/core/api/generated/models/confirm_upload_body.dart';
import 'package:studafy_mobile/src/core/api/generated/models/create_material_body.dart';
import 'package:studafy_mobile/src/core/api/generated/models/update_assignment_body.dart';

/// The API validates request bodies with Zod, where an optional field may be left out but not
/// sent as `null` (400 VALIDATION_FAILED). `scripts/fix_optional_null_fields.dart` makes the
/// generated client omit unset optional, non-nullable keys; fields the API marks nullable still
/// send `null` (on PATCH that means "clear").
void main() {
  test('material upload bodies leave an unset checksum out', () {
    final create = const CreateMaterialBody(
      classId: 'c',
      title: 'math',
      originalFileName: 'Studafy TAM SAM SOM 2.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10,
    ).toJson();
    expect(create.containsKey('checksum_sha256'), isFalse);
    // `description` is nullable on the API, so an explicit null is still sent.
    expect(create.containsKey('description'), isTrue);

    final confirm = const ConfirmUploadBody(
      storageKey: 'temp/a/b/c.pdf',
    ).toJson();
    expect(confirm, {'storage_key': 'temp/a/b/c.pdf'});
  });

  test('submission attachment confirm leaves an unset checksum out', () {
    final body = const ConfirmSubmissionAttachmentBody(
      storageKey: 'temp/a/b/c.pdf',
      contentType: 'application/pdf',
    ).toJson();
    expect(body.containsKey('checksum_sha256'), isFalse);
  });

  test(
    'a PATCH body still sends null for a nullable field (clear) and omits unset optionals',
    () {
      final body = const UpdateAssignmentBody(description: null).toJson();
      // `description` is nullable on the API: null means "clear it".
      expect(body.containsKey('description'), isTrue);
      expect(body['description'], isNull);
      // `title` is optional but not nullable: unset means "leave it", so it is not sent.
      expect(body.containsKey('title'), isFalse);
    },
  );
}
