import 'package:flutter/gestures.dart';
import 'package:flutter/widgets.dart';

/// Closes the on-screen keyboard when the user taps anywhere outside the focused text field.
///
/// On iOS and Android Flutter deliberately keeps a `TextField` focused on an outside touch
/// (`EditableText`'s default tap-outside action only unfocuses for a mouse), so a number pad or a
/// multiline field — neither has a key that closes it — leaves the keyboard stuck open.
///
/// Two layers:
/// - The text field's own tap-outside intents are overridden. `EditableText` reports every pointer
///   that goes down and comes back up outside it, wherever it lands — on a button, a list tile, a
///   card — so this catches taps the gesture arena would otherwise give to another widget. Only a
///   tap closes the keyboard: a pointer that moved further than the touch slop is a scroll or a
///   drag, and scrolling a long form keeps the keyboard up.
/// - A translucent tap detector for inert space, kept as a fallback.
///
/// Mount it inside `MaterialApp.builder` so every route, sheet and dialog is covered.
class KeyboardDismissScope extends StatefulWidget {
  const KeyboardDismissScope({super.key, required this.child});

  final Widget child;

  @override
  State<KeyboardDismissScope> createState() => _KeyboardDismissScopeState();
}

class _KeyboardDismissScopeState extends State<KeyboardDismissScope> {
  final Map<int, Offset> _downPositions = <int, Offset>{};

  late final Map<Type, Action<Intent>> _actions = <Type, Action<Intent>>{
    EditableTextTapOutsideIntent: CallbackAction<EditableTextTapOutsideIntent>(
      onInvoke: (intent) {
        final event = intent.pointerDownEvent;
        if (event.kind == PointerDeviceKind.touch ||
            event.kind == PointerDeviceKind.stylus) {
          _downPositions[event.pointer] = event.position;
        } else {
          intent.focusNode.unfocus();
        }
        return null;
      },
    ),
    EditableTextTapUpOutsideIntent:
        CallbackAction<EditableTextTapUpOutsideIntent>(
          onInvoke: (intent) {
            final event = intent.pointerUpEvent;
            final down = _downPositions.remove(event.pointer);
            if (down != null &&
                (event.position - down).distance <= kTouchSlop) {
              intent.focusNode.unfocus();
            }
            return null;
          },
        ),
  };

  @override
  Widget build(BuildContext context) {
    return Actions(
      actions: _actions,
      child: GestureDetector(
        behavior: HitTestBehavior.translucent,
        onTap: () => FocusManager.instance.primaryFocus?.unfocus(),
        child: widget.child,
      ),
    );
  }
}
