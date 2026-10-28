import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../design/tokens/app_spacing_tokens.dart';
import 'brand_splash.dart' show brandNavy;

class _GuidePage {
  const _GuidePage(this.icon, this.key);

  final IconData icon;

  /// Under `launch.guide.<key>`: `title` and `body`.
  final String key;
}

const _pages = [
  _GuidePage(Icons.school_outlined, 'school'),
  _GuidePage(Icons.notifications_active_outlined, 'updates'),
  _GuidePage(Icons.family_restroom_outlined, 'family'),
];

/// The first-run guide: a few swipeable pages on the brand navy, "Next" to step through them,
/// "Get started" on the last one, and "Skip" throughout. [onDone] fires once, either way.
class LaunchGuide extends StatefulWidget {
  const LaunchGuide({required this.onDone, super.key});

  final VoidCallback onDone;

  @override
  State<LaunchGuide> createState() => _LaunchGuideState();
}

class _LaunchGuideState extends State<LaunchGuide> {
  final _controller = PageController();
  int _page = 0;

  bool get _isLast => _page == _pages.length - 1;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _next() {
    if (_isLast) {
      widget.onDone();
      return;
    }
    _controller.nextPage(
      duration: const Duration(milliseconds: 350),
      curve: Curves.easeOutCubic,
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return ColoredBox(
      color: brandNavy,
      child: SafeArea(
        child: Center(
          // A comfortable reading width on an iPad; a phone uses its full width.
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 560),
            child: Column(
              children: [
                Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: AppSpacing.space24,
                    vertical: AppSpacing.space8,
                  ),
                  child: Row(
                    children: [
                      Image.asset(
                        'assets/brand/studafy-wordmark-white.png',
                        height: 24,
                        semanticLabel: 'Studafy',
                      ),
                      const Spacer(),
                      // Kept in the layout on the last page so nothing shifts; just hidden.
                      Visibility.maintain(
                        visible: !_isLast,
                        child: TextButton(
                          key: const Key('launchGuideSkip'),
                          onPressed: widget.onDone,
                          style: TextButton.styleFrom(
                            foregroundColor: Colors.white,
                          ),
                          child: Text('launch.guide.skip'.tr()),
                        ),
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: PageView.builder(
                    controller: _controller,
                    itemCount: _pages.length,
                    onPageChanged: (page) => setState(() => _page = page),
                    itemBuilder: (context, index) =>
                        _GuidePageView(page: _pages[index]),
                  ),
                ),
                _Dots(count: _pages.length, current: _page),
                Padding(
                  padding: const EdgeInsets.fromLTRB(
                    AppSpacing.space24,
                    AppSpacing.space24,
                    AppSpacing.space24,
                    AppSpacing.space16,
                  ),
                  child: SizedBox(
                    width: double.infinity,
                    height: 56,
                    child: FilledButton(
                      key: const Key('launchGuideNext'),
                      onPressed: _next,
                      style: FilledButton.styleFrom(
                        backgroundColor: Colors.white,
                        foregroundColor: brandNavy,
                        textStyle: theme.textTheme.titleMedium?.copyWith(
                          fontWeight: FontWeight.w600,
                        ),
                        shape: const StadiumBorder(),
                      ),
                      child: Text(
                        _isLast
                            ? 'launch.guide.getStarted'.tr()
                            : 'launch.guide.next'.tr(),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _GuidePageView extends StatelessWidget {
  const _GuidePageView({required this.page});

  final _GuidePage page;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return LayoutBuilder(
      builder: (context, constraints) {
        // Scales with the space on hand: large on a tall phone or an iPad, compact in landscape.
        final art = (constraints.maxHeight * 0.38).clamp(96.0, 240.0);
        return SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.space32),
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: constraints.maxHeight),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Container(
                  width: art,
                  height: art,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: Colors.white.withValues(alpha: 0.1),
                  ),
                  child: Icon(page.icon, size: art * 0.45, color: Colors.white),
                ),
                const SizedBox(height: AppSpacing.space40),
                Text(
                  'launch.guide.${page.key}.title'.tr(),
                  textAlign: TextAlign.center,
                  style: theme.textTheme.headlineSmall?.copyWith(
                    color: Colors.white,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: AppSpacing.space12),
                Text(
                  'launch.guide.${page.key}.body'.tr(),
                  textAlign: TextAlign.center,
                  style: theme.textTheme.bodyLarge?.copyWith(
                    color: Colors.white.withValues(alpha: 0.8),
                    height: 1.5,
                  ),
                ),
                const SizedBox(height: AppSpacing.space24),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _Dots extends StatelessWidget {
  const _Dots({required this.count, required this.current});

  final int count;
  final int current;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'launch.guide.progress'.tr(
        namedArgs: {'current': '${current + 1}', 'total': '$count'},
      ),
      child: ExcludeSemantics(
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (var i = 0; i < count; i++)
              AnimatedContainer(
                duration: const Duration(milliseconds: 250),
                margin: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.space4,
                ),
                width: i == current ? 24 : 8,
                height: 8,
                decoration: BoxDecoration(
                  color: Colors.white.withValues(
                    alpha: i == current ? 1 : 0.35,
                  ),
                  borderRadius: BorderRadius.circular(4),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
