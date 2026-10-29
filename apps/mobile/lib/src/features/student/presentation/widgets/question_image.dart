import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../core/api/generated/models/assignment_question.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';

/// A question's heading: "3. What is …" — or "Question 3" when the picture is the whole question.
String questionHeading(AssignmentQuestion question) => question.prompt.isEmpty
    ? 'assignments.questions.number'.tr(
        namedArgs: {'number': '${question.position}'},
      )
    : '${question.position}. ${question.prompt}';

/// A question's picture, fitted to the card; tap to open it full screen and pinch to zoom.
/// Nothing when the question has none.
class QuestionImage extends StatelessWidget {
  const QuestionImage({required this.question, super.key});

  final AssignmentQuestion question;

  @override
  Widget build(BuildContext context) {
    final url = question.image?.downloadUrl;
    if (question.image == null) return const SizedBox.shrink();
    final colorScheme = Theme.of(context).colorScheme;
    final label = 'assignments.questions.picture'.tr(
      namedArgs: {'number': '${question.position}'},
    );

    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.space8),
      child: Semantics(
        button: url != null,
        image: true,
        label: label,
        child: InkWell(
          key: Key('questionImage-${question.id}'),
          borderRadius: BorderRadius.circular(12),
          onTap: url == null
              ? null
              : () => _openFullScreen(context, url, label),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(12),
            child: ColoredBox(
              color: colorScheme.surfaceContainerHighest,
              child: ConstrainedBox(
                constraints: const BoxConstraints(
                  maxHeight: 260,
                  minHeight: 120,
                ),
                child: Center(
                  child: url == null
                      ? const Icon(Icons.image_outlined, size: 48)
                      : Image.network(
                          url,
                          fit: BoxFit.contain,
                          loadingBuilder: (context, child, progress) =>
                              progress == null
                              ? child
                              : const Padding(
                                  padding: EdgeInsets.all(AppSpacing.space24),
                                  child: CircularProgressIndicator(),
                                ),
                          errorBuilder: (_, _, _) =>
                              const Icon(Icons.broken_image_outlined, size: 48),
                        ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  void _openFullScreen(BuildContext context, String url, String label) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        fullscreenDialog: true,
        builder: (context) => Scaffold(
          backgroundColor: Colors.black,
          appBar: AppBar(
            backgroundColor: Colors.black,
            foregroundColor: Colors.white,
            title: Text(label),
          ),
          body: InteractiveViewer(
            maxScale: 5,
            child: Center(
              child: Image.network(
                url,
                fit: BoxFit.contain,
                semanticLabel: label,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
