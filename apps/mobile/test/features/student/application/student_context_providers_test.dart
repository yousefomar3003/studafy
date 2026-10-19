import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/api_exception.dart';
import 'package:studafy_mobile/src/core/api/generated/models/student_self.dart';
import 'package:studafy_mobile/src/core/api/generated/students/students_client.dart';
import 'package:studafy_mobile/src/core/api/generated/studafy_api_client.dart';
import 'package:studafy_mobile/src/core/auth/auth_providers.dart';
import 'package:studafy_mobile/src/core/auth/auth_state.dart';
import 'package:studafy_mobile/src/features/student/application/student_context_providers.dart';

StudentSelf _self({
  String id = 'student-1',
  List<String> classIds = const ['class-1'],
}) => StudentSelf.fromJson({
  'id': id,
  'school_id': 'school-1',
  'user_id': 'user-1',
  'first_name': 'Adam',
  'last_name': 'Fares',
  'preferred_name': null,
  'status': 'enrolled',
  'enrolled_class_ids': classIds,
});

DioException _httpError(int status) {
  final requestOptions = RequestOptions(path: '/api/students/me');
  final response = Response<dynamic>(
    requestOptions: requestOptions,
    statusCode: status,
  );
  return DioException.badResponse(
    statusCode: status,
    requestOptions: requestOptions,
    response: response,
  ).copyWith(error: ApiException.fromResponse(response));
}

/// Answers `getStudentMe` from a queue of results, counting calls so caching is observable.
class _FakeStudentsClient extends Fake implements StudentsClient {
  _FakeStudentsClient(this.respond);

  Future<StudentSelf> Function() respond;
  int calls = 0;

  @override
  Future<StudentSelf> getStudentMe() {
    calls++;
    return respond();
  }
}

class _FakeApiClient extends Fake implements StudafyApiClient {
  _FakeApiClient(this.students);

  @override
  final _FakeStudentsClient students;
}

/// A directly flippable stand-in for the real `authNotifierProvider`-backed [authStatusProvider],
/// the same seam `test/core/offline/offline_providers_test.dart` uses.
class _FakeAuthStatusNotifier extends Notifier<AuthStatus> {
  @override
  AuthStatus build() => AuthStatus.authenticated;
}

final _fakeAuthStatus = NotifierProvider<_FakeAuthStatusNotifier, AuthStatus>(
  _FakeAuthStatusNotifier.new,
);

void main() {
  late _FakeStudentsClient students;
  late ProviderContainer container;

  setUp(() {
    students = _FakeStudentsClient(
      () async => _self(classIds: const ['class-1', 'class-2']),
    );
    container = ProviderContainer(
      overrides: [
        apiClientProvider.overrideWithValue(_FakeApiClient(students)),
        authStatusProvider.overrideWith((ref) => ref.watch(_fakeAuthStatus)),
      ],
      // Riverpod 3 retries a failed provider with backoff by default (what lets an offline launch
      // recover in the app); disabled here so the error case settles immediately.
      retry: (_, _) => null,
    );
    addTearDown(container.dispose);
  });

  test(
    'resolves the student id and enrolled class ids from GET /api/students/me',
    () async {
      container.listen(currentStudentIdProvider, (_, _) {});
      container.listen(currentEnrolledClassIdsProvider, (_, _) {});

      // Unresolved while the request is in flight — consumers show "not available", never a guess.
      expect(container.read(currentStudentIdProvider), isNull);
      expect(container.read(currentEnrolledClassIdsProvider), isEmpty);

      await container.read(currentStudentSelfProvider.future);

      expect(container.read(currentStudentIdProvider), 'student-1');
      expect(container.read(currentEnrolledClassIdsProvider), [
        'class-1',
        'class-2',
      ]);
    },
  );

  test('fetches once and shares the result between both providers', () async {
    container.listen(currentStudentIdProvider, (_, _) {});
    container.listen(currentEnrolledClassIdsProvider, (_, _) {});
    await container.read(currentStudentSelfProvider.future);
    container.read(currentStudentIdProvider);
    container.read(currentEnrolledClassIdsProvider);

    expect(students.calls, 1);
  });

  test('stays unresolved without calling the API while signed out', () async {
    container.read(_fakeAuthStatus.notifier).state = AuthStatus.unauthenticated;

    expect(await container.read(currentStudentSelfProvider.future), isNull);
    expect(container.read(currentStudentIdProvider), isNull);
    expect(container.read(currentEnrolledClassIdsProvider), isEmpty);
    expect(students.calls, 0);
  });

  test('re-resolves for the next session after a logout', () async {
    container.listen(currentStudentIdProvider, (_, _) {});
    await container.read(currentStudentSelfProvider.future);
    expect(container.read(currentStudentIdProvider), 'student-1');

    container.read(_fakeAuthStatus.notifier).state = AuthStatus.unauthenticated;
    await container.read(currentStudentSelfProvider.future);
    expect(container.read(currentStudentIdProvider), isNull);

    students.respond = () async => _self(id: 'student-2', classIds: const []);
    container.read(_fakeAuthStatus.notifier).state = AuthStatus.authenticated;
    await container.read(currentStudentSelfProvider.future);

    expect(container.read(currentStudentIdProvider), 'student-2');
    expect(container.read(currentEnrolledClassIdsProvider), isEmpty);
  });

  test(
    'treats a 404 (no student record for this session) as unresolved, not an error',
    () async {
      students.respond = () async => throw _httpError(404);

      expect(await container.read(currentStudentSelfProvider.future), isNull);
      expect(container.read(currentStudentIdProvider), isNull);
      expect(container.read(currentEnrolledClassIdsProvider), isEmpty);
    },
  );

  test(
    'surfaces other failures as an error while the derived providers stay unresolved',
    () async {
      students.respond = () async => throw _httpError(503);
      container.listen(currentStudentSelfProvider, (_, _) {});

      await expectLater(
        container.read(currentStudentSelfProvider.future),
        throwsA(isA<DioException>()),
      );
      expect(container.read(currentStudentIdProvider), isNull);
      expect(container.read(currentEnrolledClassIdsProvider), isEmpty);
    },
  );
}
