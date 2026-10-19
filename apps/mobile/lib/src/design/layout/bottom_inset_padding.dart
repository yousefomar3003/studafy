import 'package:flutter/widgets.dart';

/// Scroll padding that also clears whatever sits over the bottom of the screen.
extension BottomInsetPadding on EdgeInsets {
  /// This padding with the ambient bottom inset ([MediaQuery.paddingOf]) added to its bottom.
  ///
  /// Inside the app shell that inset is the floating navigation bar's height (the shell's
  /// `Scaffold` uses `extendBody`, so tab content scrolls behind the bar); elsewhere it is the
  /// device's bottom safe area. A scroll view that sets its own `padding` loses the automatic
  /// `MediaQuery` padding a `ListView` applies by default, so it adds the inset back through this
  /// to keep its last item reachable above the bar.
  EdgeInsets withBottomInset(BuildContext context) =>
      copyWith(bottom: bottom + MediaQuery.paddingOf(context).bottom);
}

/// How far the shell's floating navigation bar reaches above the device safe area.
extension BottomBarOverlap on BuildContext {
  /// The bottom padding a tab's [FloatingActionButton] needs to sit clear of the shell's bar.
  ///
  /// `Scaffold` positions its FAB against the device safe area ([MediaQuery.viewPaddingOf]), not
  /// the ambient padding, so inside the app shell — whose bar reaches the body only as bottom
  /// [MediaQuery.paddingOf] — a nested screen's FAB would sit behind the bar. This is the part of
  /// that inset the safe area doesn't already cover; outside the shell it is 0.
  ///
  /// Read it from the screen's own context, *outside* its `Scaffold`: the Scaffold strips the
  /// bottom padding from its FAB slot, so read from inside the FAB it is always 0.
  double get bottomBarOverlap {
    final overlap = MediaQuery.paddingOf(this).bottom - MediaQuery.viewPaddingOf(this).bottom;
    return overlap > 0 ? overlap : 0;
  }
}
