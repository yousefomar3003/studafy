import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/term.dart';
import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../../../design/widgets/today_date_hero.dart';
import '../../student/presentation/widgets/status_pill.dart';
import '../application/attendance_office_providers.dart';
import '../domain/attendance_office.dart';
import 'register_screen.dart';

/// The attendance officer's home tab: today's date and time, then every class in the term in
/// view, with the state of its daily register on the chosen date (not started / in progress /
/// submitted), summary counts that double as a state filter, and a class-code search. Tapping a
/// class opens its [RegisterScreen].
///
/// The mobile twin of `apps/web/src/features/attendance-office/AttendanceOfficePage.tsx`.
class RegistersScreen extends ConsumerStatefulWidget {
  const RegistersScreen({super.key});

  @override
  ConsumerState<RegistersScreen> createState() => _RegistersScreenState();
}

class _RegistersScreenState extends ConsumerState<RegistersScreen> {
  String _query = '';
  RegisterState? _stateFilter;

  Future<void> _refresh() async {
    final date = ref.read(registerDateProvider);
    ref
      ..invalidate(officeTermSelectionProvider)
      ..invalidate(officeClassesProvider)
      ..invalidate(dailySessionsProvider(date));
    try {
      await ref.read(officeRegistersProvider.future);
    } catch (_) {
      // The error state renders from the provider itself.
    }
  }

  @override
  Widget build(BuildContext context) {
    final date = ref.watch(registerDateProvider);
    final selection = ref.watch(officeTermSelectionProvider).value;
    final registers = ref.watch(officeRegistersProvider);

    final children = <Widget>[
      const TodayDateHero(),
      const SizedBox(height: AppSpacing.space16),
      _FiltersRow(date: date, selection: selection),
      const SizedBox(height: AppSpacing.space12),
      ...registers.when(
        skipLoadingOnRefresh: true,
        loading: () => const [
          Padding(
            padding: EdgeInsets.all(AppSpacing.space32),
            child: Center(child: CircularProgressIndicator()),
          ),
        ],
        error: (_, _) => [
          _Message(
            icon: Icons.error_outline,
            message: 'attendanceOffice.registers.error'.tr(),
            onRetry: _refresh,
          ),
        ],
        data: (list) => _buildData(list, selection),
      ),
    ];

    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(
          AppSpacing.space16,
        ).withBottomInset(context),
        children: children,
      ),
    );
  }

  List<Widget> _buildData(
    List<ClassRegisterSummary> list,
    TermSelection? selection,
  ) {
    if (selection != null && selection.term == null) {
      return [
        _Message(
          icon: Icons.event_busy_outlined,
          message: 'attendanceOffice.registers.noTerm'.tr(),
        ),
      ];
    }
    if (list.isEmpty) {
      return [
        _Message(
          icon: Icons.school_outlined,
          message: 'attendanceOffice.registers.empty'.tr(),
        ),
      ];
    }

    final counts = RegisterCounts.of(list);
    final query = _query.trim().toLowerCase();
    final visible = [
      for (final register in list)
        if ((query.isEmpty ||
                register.classInfo.code.toLowerCase().contains(query)) &&
            (_stateFilter == null || register.state == _stateFilter))
          register,
    ];

    return [
      Wrap(
        spacing: AppSpacing.space8,
        runSpacing: AppSpacing.space8,
        children: [
          for (final state in RegisterState.values)
            FilterChip(
              label: Text(
                'attendanceOffice.registers.count.${state.name}'.tr(
                  namedArgs: {'count': '${_countFor(counts, state)}'},
                ),
              ),
              selected: _stateFilter == state,
              onSelected: (selected) =>
                  setState(() => _stateFilter = selected ? state : null),
            ),
        ],
      ),
      const SizedBox(height: AppSpacing.space12),
      TextField(
        onChanged: (value) => setState(() => _query = value),
        textInputAction: TextInputAction.search,
        decoration: InputDecoration(
          prefixIcon: const Icon(Icons.search),
          hintText: 'attendanceOffice.registers.searchHint'.tr(),
          border: const OutlineInputBorder(),
          isDense: true,
        ),
      ),
      const SizedBox(height: AppSpacing.space12),
      if (visible.isEmpty)
        _Message(
          icon: Icons.search_off_outlined,
          message: 'attendanceOffice.registers.noMatches'.tr(
            namedArgs: {'query': _query.trim()},
          ),
        )
      else
        for (final register in visible) ...[
          _RegisterTile(
            register: register,
            date: ref.read(registerDateProvider),
          ),
          const SizedBox(height: AppSpacing.space8),
        ],
    ];
  }

  int _countFor(RegisterCounts counts, RegisterState state) => switch (state) {
    RegisterState.notStarted => counts.notStarted,
    RegisterState.inProgress => counts.inProgress,
    RegisterState.submitted => counts.submitted,
  };
}

/// Date button and term switcher.
class _FiltersRow extends ConsumerWidget {
  const _FiltersRow({required this.date, required this.selection});

  final DateTime date;
  final TermSelection? selection;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final locale = context.locale.toString();
    final today = dateOnly(DateTime.now());
    final dateLabel = date == today
        ? '${'attendanceOffice.registers.today'.tr()} · ${DateFormat.MMMd(locale).format(date)}'
        : DateFormat.yMMMEd(locale).format(date);
    final terms = selection?.terms ?? const <Term>[];
    final term = selection?.term;

    return Wrap(
      spacing: AppSpacing.space8,
      runSpacing: AppSpacing.space8,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        Tooltip(
          message: 'attendanceOffice.registers.changeDate'.tr(),
          child: OutlinedButton.icon(
            icon: const Icon(Icons.calendar_today_outlined, size: 18),
            label: Text(dateLabel),
            onPressed: () async {
              final picked = await showDatePicker(
                context: context,
                initialDate: date,
                firstDate: DateTime(today.year - 2, today.month, today.day),
                lastDate: today,
                helpText: 'attendanceOffice.registers.date'.tr(),
              );
              if (picked != null) {
                ref.read(registerDateProvider.notifier).select(picked);
              }
            },
          ),
        ),
        if (term != null)
          terms.length > 1
              ? PopupMenuButton<String>(
                  tooltip: 'attendanceOffice.registers.changeTerm'.tr(),
                  initialValue: term.id,
                  onSelected: (id) =>
                      ref.read(pickedTermIdProvider.notifier).select(id),
                  itemBuilder: (_) => [
                    for (final option in terms)
                      PopupMenuItem(value: option.id, child: Text(option.name)),
                  ],
                  child: Chip(
                    avatar: const Icon(Icons.expand_more, size: 18),
                    label: Text(term.name),
                  ),
                )
              : Chip(label: Text(term.name)),
      ],
    );
  }
}

class _RegisterTile extends StatelessWidget {
  const _RegisterTile({required this.register, required this.date});

  final ClassRegisterSummary register;
  final DateTime date;

  @override
  Widget build(BuildContext context) {
    final stateLabel = 'attendanceOffice.state.${register.state.name}'.tr();
    final code = register.classInfo.code;

    return Card(
      margin: EdgeInsets.zero,
      child: Semantics(
        button: true,
        label: 'attendanceOffice.registers.rowLabel'.tr(
          namedArgs: {'class': code, 'state': stateLabel},
        ),
        excludeSemantics: true,
        child: ListTile(
          title: Text(code),
          trailing: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              StatusPill(label: stateLabel, tone: _toneFor(register.state)),
              const SizedBox(width: AppSpacing.space4),
              const Icon(Icons.chevron_right, size: 18),
            ],
          ),
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute<void>(
              builder: (_) => RegisterScreen(
                classId: register.classInfo.id,
                classCode: code,
                date: date,
              ),
            ),
          ),
        ),
      ),
    );
  }

  static StatusPillTone _toneFor(RegisterState state) => switch (state) {
    RegisterState.notStarted => StatusPillTone.neutral,
    RegisterState.inProgress => StatusPillTone.warning,
    RegisterState.submitted => StatusPillTone.success,
  };
}

class _Message extends StatelessWidget {
  const _Message({required this.icon, required this.message, this.onRetry});

  final IconData icon;
  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.all(AppSpacing.space32),
      child: Column(
        children: [
          Icon(icon, size: 32, color: colorScheme.onSurfaceVariant),
          const SizedBox(height: AppSpacing.space12),
          Text(
            message,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
              color: colorScheme.onSurfaceVariant,
            ),
          ),
          if (onRetry != null) ...[
            const SizedBox(height: AppSpacing.space12),
            OutlinedButton(
              onPressed: onRetry,
              child: Text('attendanceOffice.registers.retry'.tr()),
            ),
          ],
        ],
      ),
    );
  }
}
