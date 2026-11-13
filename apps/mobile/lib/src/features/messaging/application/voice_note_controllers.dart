import 'dart:async';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/voice_note_audio.dart';
import '../domain/chat_state.dart';
import '../domain/messaging.dart';

/// The microphone seam; overridden with a fake in tests.
final voiceNoteRecorderProvider = Provider.autoDispose<VoiceNoteRecorder>((ref) {
  final recorder = RecordVoiceNoteRecorder();
  ref.onDispose(recorder.dispose);
  return recorder;
});

/// The playback seam; overridden with a fake in tests.
final voiceNotePlayerProvider = Provider.autoDispose<VoiceNotePlayer>((ref) {
  final player = AudioplayersVoiceNotePlayer();
  ref.onDispose(player.dispose);
  return player;
});

/// The clock recording time is measured with. Override in tests.
final voiceNoteClockProvider = Provider<DateTime Function()>((ref) => DateTime.now);

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

enum VoiceRecordingPhase { idle, starting, recording, recorded }

/// Where the chat's voice-note recorder is: [elapsed] while recording, the finished file's
/// [path] and [duration] once stopped (a preview the user can play, delete or send).
class VoiceRecordingState {
  const VoiceRecordingState({
    this.phase = VoiceRecordingPhase.idle,
    this.elapsed = Duration.zero,
    this.levels = const [],
    this.path,
    this.sizeBytes = 0,
  });

  final VoiceRecordingPhase phase;
  final Duration elapsed;

  /// Recent input levels (0–1), newest last, for the live waveform.
  final List<double> levels;

  /// The recorded file, once [phase] is [VoiceRecordingPhase.recorded].
  final String? path;

  /// The recorded file's size.
  final int sizeBytes;

  Duration get duration => elapsed;

  bool get isActive => phase != VoiceRecordingPhase.idle;
}

/// Why recording could not start.
enum VoiceRecordingRefusal { permissionDenied, failed }

/// Records one voice note at a time for a chat: tap the microphone ([start]), tap stop
/// ([stop]) — or reach [maxVoiceNoteDuration], which stops by itself — then send ([take]) or
/// delete ([cancel]). Nothing leaves the phone until the note is sent.
class VoiceNoteRecorderController extends Notifier<VoiceRecordingState> {
  VoiceNoteRecorderController(this.conversationId);

  final String conversationId;

  /// How many level samples the waveform keeps.
  static const levelHistory = 48;

  Timer? _ticker;
  StreamSubscription<double>? _levels;
  DateTime? _startedAt;

  /// The latest state, readable from the dispose callback (which may not touch `state` or `ref`).
  VoiceRecordingState _latest = const VoiceRecordingState();

  late VoiceNoteRecorder _recorder;

  @override
  VoiceRecordingState build() {
    _recorder = ref.watch(voiceNoteRecorderProvider);
    final recorder = _recorder;
    listenSelf((_, next) => _latest = next);
    ref.onDispose(() {
      _stopTicking();
      final latest = _latest;
      // A recording abandoned by leaving the chat is discarded, never sent.
      if (latest.phase == VoiceRecordingPhase.recording) {
        unawaited(recorder.cancel().catchError((_) {}));
      } else if (latest.path case final path?) {
        unawaited(_deleteQuietly(path));
      }
    });
    return const VoiceRecordingState();
  }

  /// Asks for the microphone (the first time) and starts recording. Returns why it could not
  /// start, or null when it did.
  Future<VoiceRecordingRefusal?> start() async {
    if (state.isActive) return null;
    state = const VoiceRecordingState(phase: VoiceRecordingPhase.starting);
    try {
      if (!await _recorder.requestPermission()) {
        if (ref.mounted) state = const VoiceRecordingState();
        return VoiceRecordingRefusal.permissionDenied;
      }
      await _recorder.start();
    } on Object {
      if (ref.mounted) state = const VoiceRecordingState();
      return VoiceRecordingRefusal.failed;
    }
    if (!ref.mounted) return null;
    _startedAt = ref.read(voiceNoteClockProvider)();
    state = const VoiceRecordingState(phase: VoiceRecordingPhase.recording);
    _ticker = Timer.periodic(const Duration(milliseconds: 100), (_) => _tick());
    _levels = _recorder.levels().listen((level) {
      if (!ref.mounted || state.phase != VoiceRecordingPhase.recording) return;
      final levels = [...state.levels, level];
      state = VoiceRecordingState(
        phase: state.phase,
        elapsed: state.elapsed,
        levels: levels.length > levelHistory
            ? levels.sublist(levels.length - levelHistory)
            : levels,
      );
    }, onError: (_) {});
    return null;
  }

  /// Time recorded so far, capped at [maxVoiceNoteDuration].
  Duration _elapsedNow() {
    final startedAt = _startedAt;
    if (startedAt == null) return state.elapsed;
    final elapsed = ref.read(voiceNoteClockProvider)().difference(startedAt);
    return elapsed > maxVoiceNoteDuration ? maxVoiceNoteDuration : elapsed;
  }

  void _tick() {
    if (!ref.mounted || state.phase != VoiceRecordingPhase.recording) return;
    final elapsed = _elapsedNow();
    state = VoiceRecordingState(phase: state.phase, elapsed: elapsed, levels: state.levels);
    // The two-minute cap: stop by itself, keeping the note for preview.
    if (elapsed >= maxVoiceNoteDuration) unawaited(stop());
  }

  /// Stops recording and keeps the file as a preview. A note under half a second is discarded
  /// (an accidental tap).
  Future<void> stop() async {
    if (state.phase != VoiceRecordingPhase.recording || _stopping) return;
    _stopping = true;
    try {
      await _finishRecording();
    } finally {
      _stopping = false;
    }
  }

  bool _stopping = false;

  Future<void> _finishRecording() async {
    _stopTicking();
    final elapsed = _elapsedNow();
    state = VoiceRecordingState(phase: state.phase, elapsed: elapsed, levels: state.levels);
    RecordedVoiceNote? recorded;
    try {
      recorded = await _recorder.stop();
    } on Object {
      recorded = null;
    }
    if (!ref.mounted) return;
    if (recorded == null || elapsed < const Duration(milliseconds: 500)) {
      if (recorded != null) unawaited(_deleteQuietly(recorded.path));
      state = const VoiceRecordingState();
      return;
    }
    state = VoiceRecordingState(
      phase: VoiceRecordingPhase.recorded,
      elapsed: elapsed > maxVoiceNoteDuration ? maxVoiceNoteDuration : elapsed,
      levels: state.levels,
      path: recorded.path,
      sizeBytes: recorded.sizeBytes,
    );
  }

  /// Throws the note away, recording or recorded.
  Future<void> cancel() async {
    final phase = state.phase;
    final path = state.path;
    _stopTicking();
    state = const VoiceRecordingState();
    if (phase == VoiceRecordingPhase.recording) {
      try {
        await _recorder.cancel();
      } on Object {
        // Nothing to clean up that the OS will not.
      }
    } else if (path != null) {
      await _deleteQuietly(path);
    }
  }

  /// Hands the recorded note over for sending and resets; null unless one is recorded.
  PendingVoiceNote? take() {
    final path = state.path;
    if (state.phase != VoiceRecordingPhase.recorded || path == null) return null;
    final note = PendingVoiceNote(
      localPath: path,
      duration: state.duration,
      sizeBytes: state.sizeBytes,
    );
    state = const VoiceRecordingState();
    return note;
  }

  void _stopTicking() {
    _ticker?.cancel();
    _ticker = null;
    unawaited(_levels?.cancel());
    _levels = null;
  }

  static Future<void> _deleteQuietly(String path) async {
    try {
      final file = File(path);
      if (await file.exists()) await file.delete();
    } on Object {
      // A temporary file; the OS clears the cache directory eventually.
    }
  }
}

final voiceNoteRecorderControllerProvider = NotifierProvider.autoDispose
    .family<VoiceNoteRecorderController, VoiceRecordingState, String>(
      VoiceNoteRecorderController.new,
    );

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

/// Which voice note is playing (one at a time: starting another pauses this one), where it is,
/// and at what speed.
class VoicePlaybackState {
  const VoicePlaybackState({
    this.activeId,
    this.status = VoicePlaybackStatus.stopped,
    this.position = Duration.zero,
    this.speed = 1,
  });

  /// The attachment id (or a pending note's local id) loaded in the player.
  final String? activeId;
  final VoicePlaybackStatus status;
  final Duration position;
  final double speed;

  bool isPlaying(String id) => activeId == id && status == VoicePlaybackStatus.playing;

  /// [position] for [id], or zero when another note is loaded.
  Duration positionOf(String id) => activeId == id ? position : Duration.zero;

  VoicePlaybackState copyWith({
    String? activeId,
    VoicePlaybackStatus? status,
    Duration? position,
    double? speed,
  }) => VoicePlaybackState(
    activeId: activeId ?? this.activeId,
    status: status ?? this.status,
    position: position ?? this.position,
    speed: speed ?? this.speed,
  );
}

/// The speeds the speed button cycles through.
const voicePlaybackSpeeds = [1.0, 1.5, 2.0];

/// One player for every voice note on screen, so only one plays at a time.
class VoiceNotePlaybackController extends Notifier<VoicePlaybackState> {
  StreamSubscription<Duration>? _positions;
  StreamSubscription<VoicePlaybackStatus>? _statuses;

  @override
  VoicePlaybackState build() {
    final player = ref.watch(voiceNotePlayerProvider);
    _positions = player.positions.listen((position) {
      if (ref.mounted) state = state.copyWith(position: position);
    }, onError: (_) {});
    _statuses = player.statuses.listen((status) {
      if (!ref.mounted) return;
      state = status == VoicePlaybackStatus.completed
          ? state.copyWith(status: status, position: Duration.zero)
          : state.copyWith(status: status);
    }, onError: (_) {});
    ref.onDispose(() {
      unawaited(_positions?.cancel());
      unawaited(_statuses?.cancel());
      unawaited(player.stop().catchError((_) {}));
    });
    return const VoicePlaybackState();
  }

  VoiceNotePlayer get _player => ref.read(voiceNotePlayerProvider);

  /// Plays or pauses note [id] from [source] (a URL or a local path). Starting a note stops
  /// whichever one was playing.
  Future<void> toggle(String id, String source) async {
    try {
      if (state.activeId == id) {
        switch (state.status) {
          case VoicePlaybackStatus.playing:
            await _player.pause();
            state = state.copyWith(status: VoicePlaybackStatus.paused);
          case VoicePlaybackStatus.paused:
            await _player.resume();
            state = state.copyWith(status: VoicePlaybackStatus.playing);
          case VoicePlaybackStatus.stopped:
          case VoicePlaybackStatus.completed:
            await _start(id, source);
        }
        return;
      }
      await _player.stop();
      await _start(id, source);
    } on Object {
      if (ref.mounted) {
        state = state.copyWith(status: VoicePlaybackStatus.stopped, position: Duration.zero);
      }
    }
  }

  Future<void> _start(String id, String source) async {
    state = VoicePlaybackState(
      activeId: id,
      status: VoicePlaybackStatus.playing,
      speed: state.speed,
    );
    await _player.play(source);
    if (state.speed != 1) await _player.setSpeed(state.speed);
  }

  /// Moves note [id] to [position] when it is the loaded one.
  Future<void> seek(String id, Duration position) async {
    if (state.activeId != id) return;
    state = state.copyWith(position: position);
    try {
      await _player.seek(position);
    } on Object {
      // The next position event corrects the bar.
    }
  }

  /// 1× → 1.5× → 2× → 1×, for every note.
  Future<void> cycleSpeed() async {
    final index = voicePlaybackSpeeds.indexOf(state.speed);
    final next = voicePlaybackSpeeds[(index + 1) % voicePlaybackSpeeds.length];
    state = state.copyWith(speed: next);
    try {
      if (state.activeId != null) await _player.setSpeed(next);
    } on Object {
      // Applied on the next play.
    }
  }

  /// Stops whatever is playing (leaving the chat, starting to record).
  Future<void> stopAll() async {
    if (state.activeId == null) return;
    state = const VoicePlaybackState().copyWith(speed: state.speed);
    try {
      await _player.stop();
    } on Object {
      // Already stopped.
    }
  }
}

final voiceNotePlaybackProvider =
    NotifierProvider.autoDispose<VoiceNotePlaybackController, VoicePlaybackState>(
      VoiceNotePlaybackController.new,
    );
