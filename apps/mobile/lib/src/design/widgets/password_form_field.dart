import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

/// A password (or setup code) field with an eye button that shows or hides what was typed.
///
/// Hidden by default. The button is announced as "Show password" / "Hide password" (localized),
/// and it is left out of the keyboard's next/done traversal so tabbing goes field to field. The
/// field keeps every other behaviour of a [TextFormField]; [decoration] gets the button as its
/// suffix icon.
///
/// The button's key is [toggleKey], or `<field key>Visibility` when the field has a string
/// [ValueKey] — so tests can tap it without each caller naming it.
class PasswordFormField extends StatefulWidget {
  const PasswordFormField({
    super.key,
    this.controller,
    this.decoration = const InputDecoration(),
    this.enabled,
    this.autofillHints,
    this.textInputAction,
    this.onFieldSubmitted,
    this.validator,
    this.toggleKey,
  });

  final TextEditingController? controller;
  final InputDecoration decoration;
  final bool? enabled;
  final Iterable<String>? autofillHints;
  final TextInputAction? textInputAction;
  final ValueChanged<String>? onFieldSubmitted;
  final FormFieldValidator<String>? validator;
  final Key? toggleKey;

  @override
  State<PasswordFormField> createState() => _PasswordFormFieldState();
}

class _PasswordFormFieldState extends State<PasswordFormField> {
  bool _visible = false;

  Key? get _toggleKey {
    if (widget.toggleKey != null) return widget.toggleKey;
    final key = widget.key;
    return key is ValueKey<String> ? Key('${key.value}Visibility') : null;
  }

  @override
  Widget build(BuildContext context) {
    final label = _visible
        ? 'auth.password.hide'.tr()
        : 'auth.password.show'.tr();
    return TextFormField(
      controller: widget.controller,
      enabled: widget.enabled,
      obscureText: !_visible,
      autocorrect: false,
      enableSuggestions: false,
      autofillHints: widget.autofillHints,
      textInputAction: widget.textInputAction,
      onFieldSubmitted: widget.onFieldSubmitted,
      validator: widget.validator,
      decoration: widget.decoration.copyWith(
        suffixIcon: ExcludeFocus(
          child: IconButton(
            key: _toggleKey,
            icon: Icon(
              _visible
                  ? Icons.visibility_off_outlined
                  : Icons.visibility_outlined,
            ),
            tooltip: label,
            onPressed: widget.enabled == false
                ? null
                : () => setState(() => _visible = !_visible),
          ),
        ),
      ),
    );
  }
}
