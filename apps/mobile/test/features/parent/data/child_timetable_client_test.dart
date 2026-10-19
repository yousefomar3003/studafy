import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/parent/data/child_timetable_client.dart';

import '../support.dart';

class _JsonAdapter implements HttpClientAdapter {
  _JsonAdapter(this.body);

  final Map<String, Object?> body;
  final requests = <RequestOptions>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    return ResponseBody.fromString(
      jsonEncode(body),
      200,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  test('fetches the child-scoped timetable and parses it', () async {
    final adapter = _JsonAdapter({
      'student_id': 'child-1',
      'term_id': 'term-1',
      'timetable_version_id': 'v1',
      'settings': {
        'school_days': [7, 1, 2, 3, 4],
        'periods_per_day': 7,
      },
      'slots': [childTimetableSlotJson()],
    });
    final client = ChildTimetableClient(Dio()..httpClientAdapter = adapter);

    final timetable = await client.fetch('child-1');

    expect(
      adapter.requests.single.path,
      '/api/reports/children/child-1/timetable',
    );
    expect(timetable.timetableVersionId, 'v1');
    expect(timetable.slots.single.courseName, 'Science');
  });
}
