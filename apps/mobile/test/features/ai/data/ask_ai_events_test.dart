import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/ai/data/ask_ai_events.dart';

void main() {
  group('parseSseFrames', () {
    // Dio's ResponseType.stream body is a Stream<Uint8List>, not a Stream<List<int>>.
    test('reads a Stream<Uint8List> body, as Dio delivers it', () async {
      const body =
          'event: sources\ndata: {"conversation_id":"c1","sources":[]}\n\n'
          'event: delta\ndata: {"delta":"Hi"}\n\n';
      final stream = Stream<Uint8List>.fromIterable([Uint8List.fromList(utf8.encode(body))]);

      final frames = await parseSseFrames(stream).toList();

      expect(frames.map((f) => f.event), ['sources', 'delta']);
      expect(frames.last.data, '{"delta":"Hi"}');
    });

    test('decodes a multi-byte character split across chunks', () async {
      final bytes = utf8.encode('event: delta\ndata: {"delta":"👋"}\n\n');
      final split = bytes.indexOf(0xF0) + 2;
      final stream = Stream<Uint8List>.fromIterable([
        Uint8List.fromList(bytes.sublist(0, split)),
        Uint8List.fromList(bytes.sublist(split)),
      ]);

      final frames = await parseSseFrames(stream).toList();

      expect(frames.single.data, '{"delta":"👋"}');
    });
  });
}
