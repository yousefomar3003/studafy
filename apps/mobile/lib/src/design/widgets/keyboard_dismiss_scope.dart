import 'package:flutter/widgets.dart';

/// Closes the on-screen keyboard when the user taps anywhere outside a text field.
///
/// On iOS and Android a `TextField` keeps focus on an outside touch (only mouse taps unfocus it),
/// so without this a number pad or a multiline field — neither has a key that closes it — leaves
/// the keyboard stuck open. The tap competes in the gesture arena like any other, so buttons, list
/// tiles and other text fields still win their own taps; only taps on otherwise inert space reach
/// this detector.
///
/// Mount it inside `MaterialApp.builder` so every route, sheet and dialog is covered.
class KeyboardDismissScope extends StatelessWidget {
  const KeyboardDismissScope({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.translucent,
      onTap: () => FocusManager.instance.primaryFocus?.unfocus(),
      child: child,
    );
  }
}
