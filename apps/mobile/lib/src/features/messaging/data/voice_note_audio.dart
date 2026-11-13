import 'dart:async';
import 'dart:io';

import 'package:audioplayers/audioplayers.dart' as ap;
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

/// A finished recording: the local file and its size.
class RecordedVoiceNote {
  const RecordedVoiceNote({required this.path, required this.sizeBytes});

  final String path;
  final int sizeBytes;
}

/// Records voice notes for chats — a seam over `record` so widget tests run without the plugin.
///
/// Notes are AAC-LC in an .m4a file (`audio/mp4`), mono, 32 kbps at 22.05 kHz: about 240 KB a
/// minute, clear for speech, and played natively by iOS, Android and every browser (the
/// principal's report review plays them in an `<audio>` element).
abstract class VoiceNoteRecorder {
  /// Whether the microphone may be used. The first call asks the user (the OS prompt); later
  /// calls return the stored answer without asking again.
  Future<bool> requestPermission();

  /// Starts recording to a new temporary file.
  Future<void> start();

  /// Stops and returns the recorded file; null when nothing was recorded.
  Future<RecordedVoiceNote?> stop();

  /// Stops and deletes the recording.
  Future<void> cancel();

  /// The input level while recording, 0 (silence) to 1, for the live waveform.
  Stream<double> levels();

  Future<void> dispose();
}

/// The `record`-backed [VoiceNoteRecorder].
class RecordVoiceNoteRecorder implements VoiceNoteRecorder {
  RecordVoiceNoteRecorder([AudioRecorder? recorder]) : _recorder = recorder ?? AudioRecorder();

  final AudioRecorder _recorder;

  static const _config = RecordConfig(
    encoder: AudioEncoder.aacLc,
    bitRate: 32000,
    sampleRate: 22050,
    numChannels: 1,
  );

  @override
  Future<bool> requestPermission() => _recorder.hasPermission();

  @override
  Future<void> start() async {
    final directory = await getTemporaryDirectory();
    final path = p.join(directory.path, 'voice-note-${DateTime.now().millisecondsSinceEpoch}.m4a');
    await _recorder.start(_config, path: path);
  }

  @override
  Future<RecordedVoiceNote?> stop() async {
    final path = await _recorder.stop();
    if (path == null) return null;
    final file = File(path);
    if (!await file.exists()) return null;
    return RecordedVoiceNote(path: path, sizeBytes: await file.length());
  }

  @override
  Future<void> cancel() => _recorder.cancel();

  @override
  Stream<double> levels() => _recorder
      .onAmplitudeChanged(const Duration(milliseconds: 120))
      // dBFS: about -45 is a quiet room, 0 is the loudest the microphone reports.
      .map((amplitude) => ((amplitude.current + 45) / 45).clamp(0.0, 1.0));

  @override
  Future<void> dispose() => _recorder.dispose();
}

/// What a [VoiceNotePlayer] is doing.
enum VoicePlaybackStatus { stopped, playing, paused, completed }

/// Plays voice notes — a seam over `audioplayers` so widget tests run without the plugin.
abstract class VoiceNotePlayer {
  /// Plays [source]: an `https:` URL (a pre-signed download) or a local file path.
  Future<void> play(String source);
  Future<void> pause();
  Future<void> resume();
  Future<void> stop();
  Future<void> seek(Duration position);
  Future<void> setSpeed(double speed);

  Stream<Duration> get positions;
  Stream<VoicePlaybackStatus> get statuses;

  Future<void> dispose();
}

/// The `audioplayers`-backed [VoiceNotePlayer].
class AudioplayersVoiceNotePlayer implements VoiceNotePlayer {
  AudioplayersVoiceNotePlayer([ap.AudioPlayer? player]) : _player = player ?? ap.AudioPlayer();

  final ap.AudioPlayer _player;

  @override
  Future<void> play(String source) async {
    final isUrl = source.startsWith('http://') || source.startsWith('https://');
    await _player.play(
      isUrl ? ap.UrlSource(source, mimeType: 'audio/mp4') : ap.DeviceFileSource(source),
    );
  }

  @override
  Future<void> pause() => _player.pause();

  @override
  Future<void> resume() => _player.resume();

  @override
  Future<void> stop() => _player.stop();

  @override
  Future<void> seek(Duration position) => _player.seek(position);

  @override
  Future<void> setSpeed(double speed) => _player.setPlaybackRate(speed);

  @override
  Stream<Duration> get positions => _player.onPositionChanged;

  @override
  Stream<VoicePlaybackStatus> get statuses => _player.onPlayerStateChanged.map(
    (state) => switch (state) {
      ap.PlayerState.playing => VoicePlaybackStatus.playing,
      ap.PlayerState.paused => VoicePlaybackStatus.paused,
      ap.PlayerState.completed => VoicePlaybackStatus.completed,
      _ => VoicePlaybackStatus.stopped,
    },
  );

  @override
  Future<void> dispose() => _player.dispose();
}
