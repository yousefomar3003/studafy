import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/voice_note_controllers.dart';
import '../../data/voice_note_audio.dart';

/// "0:07", "1:45" — a voice note's length or position.
String formatVoiceDuration(Duration duration) {
  final seconds = duration.inSeconds;
  return '${seconds ~/ 60}:${(seconds % 60).toString().padLeft(2, '0')}';
}

/// A voice note inside a chat bubble: play / pause, a seek bar, position and length, and the
/// speed button (1× / 1.5× / 2×). One note plays at a time across the chat.
///
/// [source] is the pre-signed URL (or, for one still sending, the local file); null while the
/// upload is being checked for viruses (or storage is not configured) — the note then says so
/// instead of offering play.
class VoiceNotePlayerView extends ConsumerWidget {
  const VoiceNotePlayerView({
    required this.id,
    required this.source,
    required this.duration,
    required this.isMine,
    this.onSourceError,
    super.key,
  });

  final String id;
  final String? source;
  final Duration duration;
  final bool isMine;

  /// Called when playback fails (a pre-signed URL past its five minutes, usually), so the chat
  /// can fetch fresh URLs.
  final VoidCallback? onSourceError;

  static const double width = 240;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final playback = ref.watch(voiceNotePlaybackProvider);
    final controller = ref.read(voiceNotePlaybackProvider.notifier);
    final playing = playback.isPlaying(id);
    final position = playback.positionOf(id);
    final foreground = isMine ? colorScheme.onPrimary : colorScheme.onSurface;
    final muted = isMine
        ? colorScheme.onPrimary.withValues(alpha: 0.8)
        : colorScheme.onSurfaceVariant;
    final total = duration.inMilliseconds > 0 ? duration : const Duration(seconds: 1);
    final fraction = (position.inMilliseconds / total.inMilliseconds).clamp(0.0, 1.0);
    final source = this.source;
    final lengthText = formatVoiceDuration(duration);

    return SizedBox(
      width: width,
      child: Padding(
        padding: const EdgeInsetsDirectional.fromSTEB(
          AppSpacing.space4,
          AppSpacing.space4,
          AppSpacing.space12,
          AppSpacing.space8,
        ),
        child: Row(
          children: [
            if (source == null)
              Padding(
                padding: const EdgeInsets.all(AppSpacing.space12),
                child: Icon(Icons.hourglass_top, color: muted, size: 22),
              )
            else
              IconButton(
                tooltip: (playing ? 'messaging.voice.pause' : 'messaging.voice.play').tr(),
                onPressed: () async {
                  await controller.toggle(id, source);
                  final after = ref.read(voiceNotePlaybackProvider);
                  if (after.activeId == id && after.status == VoicePlaybackStatus.stopped) {
                    onSourceError?.call();
                  }
                },
                color: foreground,
                icon: Icon(playing ? Icons.pause_circle_filled : Icons.play_circle_fill, size: 36),
              ),
            Expanded(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (source == null)
                    Text(
                      'messaging.voice.checking'.tr(),
                      style: theme.textTheme.bodySmall?.copyWith(color: foreground),
                    )
                  else
                    Semantics(
                      label: 'messaging.voice.progress'.tr(
                        namedArgs: {
                          'position': formatVoiceDuration(position),
                          'length': lengthText,
                        },
                      ),
                      child: SliderTheme(
                        data: SliderTheme.of(context).copyWith(
                          trackHeight: 3,
                          thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 6),
                          overlayShape: const RoundSliderOverlayShape(overlayRadius: 12),
                          activeTrackColor: foreground,
                          inactiveTrackColor: muted.withValues(alpha: 0.35),
                          thumbColor: foreground,
                        ),
                        child: Slider(
                          value: fraction,
                          onChanged: playback.activeId == id
                              ? (value) => controller.seek(
                                  id,
                                  Duration(milliseconds: (value * total.inMilliseconds).round()),
                                )
                              : null,
                        ),
                      ),
                    ),
                  Row(
                    children: [
                      Icon(Icons.mic, size: 14, color: muted),
                      const SizedBox(width: AppSpacing.space4),
                      Text(
                        playback.activeId == id && position > Duration.zero
                            ? formatVoiceDuration(position)
                            : lengthText,
                        style: theme.textTheme.labelSmall?.copyWith(color: muted),
                      ),
                      const Spacer(),
                      if (source != null)
                        _SpeedButton(
                          speed: playback.speed,
                          color: foreground,
                          onPressed: controller.cycleSpeed,
                        ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SpeedButton extends StatelessWidget {
  const _SpeedButton({required this.speed, required this.color, required this.onPressed});

  final double speed;
  final Color color;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final label = speed == speed.roundToDouble() ? '${speed.toInt()}×' : '$speed×';
    return Semantics(
      button: true,
      label: 'messaging.voice.speed'.tr(namedArgs: {'speed': label}),
      excludeSemantics: true,
      child: InkWell(
        onTap: onPressed,
        borderRadius: BorderRadius.circular(AppSpacing.space12),
        child: Container(
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.space8,
            vertical: AppSpacing.space4,
          ),
          decoration: BoxDecoration(
            border: Border.all(color: color.withValues(alpha: 0.6)),
            borderRadius: BorderRadius.circular(AppSpacing.space12),
          ),
          child: Text(label, style: Theme.of(context).textTheme.labelSmall?.copyWith(color: color)),
        ),
      ),
    );
  }
}

/// Replaces the composer while a voice note is being recorded or previewed.
///
/// Recording: a pulsing dot, the elapsed time out of 2:00, a live waveform, delete and stop.
/// Recorded: play the preview, its length, delete and send.
class VoiceNoteRecorderBar extends ConsumerWidget {
  const VoiceNoteRecorderBar({required this.conversationId, required this.onSend, super.key});

  final String conversationId;
  final VoidCallback onSend;

  static const double _buttonSize = 44;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final provider = voiceNoteRecorderControllerProvider(conversationId);
    final recording = ref.watch(provider);
    final controller = ref.read(provider.notifier);
    final recorded = recording.phase == VoiceRecordingPhase.recorded;

    final Widget middle;
    if (recorded) {
      middle = VoiceNotePlayerView(
        id: 'preview-$conversationId',
        source: recording.path,
        duration: recording.duration,
        isMine: false,
      );
    } else {
      middle = Row(
        children: [
          _RecordingDot(color: colorScheme.error),
          const SizedBox(width: AppSpacing.space8),
          Semantics(
            liveRegion: true,
            label: 'messaging.voice.recordingLabel'.tr(
              namedArgs: {'elapsed': formatVoiceDuration(recording.elapsed)},
            ),
            excludeSemantics: true,
            child: Text(
              '${formatVoiceDuration(recording.elapsed)} / '
              '${formatVoiceDuration(const Duration(minutes: 2))}',
              style: theme.textTheme.bodyMedium?.copyWith(
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
          ),
          const SizedBox(width: AppSpacing.space12),
          Expanded(
            child: _Waveform(levels: recording.levels, color: colorScheme.primary),
          ),
        ],
      );
    }

    return SafeArea(
      top: false,
      minimum: const EdgeInsets.only(bottom: AppSpacing.space8),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.space12,
          AppSpacing.space8,
          AppSpacing.space12,
          AppSpacing.space4,
        ),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: colorScheme.surface,
            borderRadius: const BorderRadius.all(Radius.circular(30)),
            border: Border.all(color: colorScheme.outlineVariant),
          ),
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.space8),
            child: Row(
              children: [
                IconButton(
                  tooltip: 'messaging.voice.delete'.tr(),
                  onPressed: controller.cancel,
                  style: IconButton.styleFrom(fixedSize: const Size.square(_buttonSize)),
                  icon: Icon(Icons.delete_outline, color: colorScheme.error),
                ),
                Expanded(child: middle),
                const SizedBox(width: AppSpacing.space8),
                if (recorded)
                  IconButton.filled(
                    tooltip: 'messaging.voice.send'.tr(),
                    onPressed: onSend,
                    style: IconButton.styleFrom(
                      fixedSize: const Size.square(_buttonSize),
                      backgroundColor: colorScheme.inverseSurface,
                      foregroundColor: colorScheme.onInverseSurface,
                    ),
                    icon: const Icon(Icons.arrow_upward),
                  )
                else
                  IconButton.filled(
                    tooltip: 'messaging.voice.stop'.tr(),
                    onPressed: recording.phase == VoiceRecordingPhase.recording
                        ? controller.stop
                        : null,
                    style: IconButton.styleFrom(
                      fixedSize: const Size.square(_buttonSize),
                      backgroundColor: colorScheme.error,
                      foregroundColor: colorScheme.onError,
                    ),
                    icon: const Icon(Icons.stop_rounded),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _RecordingDot extends StatefulWidget {
  const _RecordingDot({required this.color});

  final Color color;

  @override
  State<_RecordingDot> createState() => _RecordingDotState();
}

class _RecordingDotState extends State<_RecordingDot> with SingleTickerProviderStateMixin {
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  );

  @override
  void initState() {
    super.initState();
    // No endless animation when the platform asks for reduced motion (and in widget tests, which
    // would otherwise never settle).
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      if (!MediaQuery.of(context).disableAnimations) _pulse.repeat(reverse: true);
    });
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: Tween<double>(begin: 0.35, end: 1).animate(_pulse),
      child: Container(
        width: 10,
        height: 10,
        decoration: BoxDecoration(color: widget.color, shape: BoxShape.circle),
      ),
    );
  }
}

/// Bars for the recent input levels, newest at the trailing end.
class _Waveform extends StatelessWidget {
  const _Waveform({required this.levels, required this.color});

  final List<double> levels;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return ExcludeSemantics(
      child: SizedBox(
        height: 28,
        child: LayoutBuilder(
          builder: (context, constraints) {
            const barWidth = 3.0;
            const gap = 2.0;
            final count = (constraints.maxWidth / (barWidth + gap)).floor().clamp(0, 200);
            final shown = levels.length > count ? levels.sublist(levels.length - count) : levels;
            return Row(
              mainAxisAlignment: MainAxisAlignment.end,
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                for (final level in shown)
                  Container(
                    width: barWidth,
                    height: 4 + 24 * level,
                    margin: const EdgeInsetsDirectional.only(start: gap),
                    decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(2)),
                  ),
              ],
            );
          },
        ),
      ),
    );
  }
}
