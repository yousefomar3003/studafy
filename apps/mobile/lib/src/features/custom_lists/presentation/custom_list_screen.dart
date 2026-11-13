import 'dart:async';

import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/custom_lists_providers.dart';
import '../domain/custom_list.dart';
import 'custom_list_row_card.dart';

/// Rows fetched per page; more load as the user scrolls near the end.
const customListPageSize = 30;

/// How long typing pauses before the search is sent.
const customListSearchDebounce = Duration(milliseconds: 400);

/// One custom list, read-only: its rows as cards, a search box, and a sort menu (date added, last
/// changed, what a row links to, or any column that is not sensitive -- a sensitive column can be
/// neither sorted nor searched). Pages load as the user scrolls. Adding and editing rows, and
/// revealing a sensitive cell, happen on the web.
class CustomListScreen extends ConsumerStatefulWidget {
  const CustomListScreen({
    required this.listId,
    required this.title,
    super.key,
  });

  final String listId;

  /// The list's name, shown before its detail loads.
  final String title;

  @override
  ConsumerState<CustomListScreen> createState() => _CustomListScreenState();
}

class _CustomListScreenState extends ConsumerState<CustomListScreen> {
  final _scroll = ScrollController();
  final _search = TextEditingController();
  Timer? _debounce;

  final List<CustomListRow> _rows = [];
  int _total = 0;
  bool _loading = false;
  bool _failed = false;
  bool _started = false;

  /// Bumped on every reset, so a page answered after the query changed is dropped.
  int _generation = 0;

  String _query = '';
  String _sort = 'created_at';
  bool _descending = false;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_maybeLoadMore);
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _scroll.dispose();
    _search.dispose();
    super.dispose();
  }

  Future<void> _load({bool reset = false}) async {
    if (reset) {
      _generation += 1;
      _rows.clear();
      _total = 0;
    } else if (_loading) {
      return;
    }
    final generation = _generation;
    setState(() {
      _loading = true;
      _failed = false;
      _started = true;
    });
    try {
      final page = await ref
          .read(customListsClientProvider)
          .rows(
            widget.listId,
            q: _query,
            sort: _sort,
            descending: _descending,
            limit: customListPageSize,
            offset: _rows.length,
          );
      if (!mounted || generation != _generation) return;
      setState(() {
        _rows.addAll(page.rows);
        _total = page.total;
      });
    } on Object {
      if (mounted && generation == _generation) setState(() => _failed = true);
    } finally {
      if (mounted && generation == _generation) {
        setState(() => _loading = false);
      }
    }
  }

  void _maybeLoadMore() {
    if (_loading || _failed || _rows.length >= _total) return;
    if (_scroll.position.extentAfter < 400) _load();
  }

  void _onSearchChanged(String value) {
    _debounce?.cancel();
    _debounce = Timer(customListSearchDebounce, () {
      if (value.trim() == _query) return;
      _query = value.trim();
      _load(reset: true);
    });
  }

  void _onSort(String choice) {
    switch (choice) {
      case _ascending:
        _descending = false;
      case _descendingChoice:
        _descending = true;
      default:
        _sort = choice;
    }
    _load(reset: true);
  }

  Future<void> _refresh() async {
    ref.invalidate(customListDetailProvider(widget.listId));
    await _load(reset: true);
  }

  @override
  Widget build(BuildContext context) {
    final detail = ref.watch(customListDetailProvider(widget.listId));
    final language = context.locale.languageCode;
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;

    if (!_started && detail.hasValue) {
      // The first page loads once the columns it is shown with are known.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && !_started) _load(reset: true);
      });
    }

    final columns = detail.value?.activeColumns ?? const <CustomListColumn>[];

    return Scaffold(
      appBar: AppBar(
        title: Text(detail.value?.summary.name(language) ?? widget.title),
        actions: [
          if (detail.hasValue)
            PopupMenuButton<String>(
              key: const Key('customListSort'),
              icon: const Icon(Icons.sort),
              tooltip: 'customLists.list.sort'.tr(),
              onSelected: _onSort,
              itemBuilder: (context) => [
                for (final (key, label) in [
                  ('created_at', 'customLists.list.sortCreated'.tr()),
                  ('updated_at', 'customLists.list.sortUpdated'.tr()),
                  ('link', 'customLists.list.sortLink'.tr()),
                  for (final column in columns)
                    if (!column.sensitive) (column.id, column.label(language)),
                ])
                  CheckedPopupMenuItem(
                    value: key,
                    checked: _sort == key,
                    child: Text(label),
                  ),
                const PopupMenuDivider(),
                CheckedPopupMenuItem(
                  value: _ascending,
                  checked: !_descending,
                  child: Text('customLists.list.ascending'.tr()),
                ),
                CheckedPopupMenuItem(
                  value: _descendingChoice,
                  checked: _descending,
                  child: Text('customLists.list.descending'.tr()),
                ),
              ],
            ),
        ],
      ),
      body: detail.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => _ErrorMessage(
          messageKey: 'customLists.list.loadError',
          onRetry: () =>
              ref.invalidate(customListDetailProvider(widget.listId)),
        ),
        data: (detail) => RefreshIndicator(
          onRefresh: _refresh,
          child: ListView(
            controller: _scroll,
            padding: const EdgeInsets.all(
              AppSpacing.space16,
            ).withBottomInset(context),
            children: [
              if (detail.summary.description case final description?) ...[
                Text(description, style: textTheme.bodyMedium),
                const SizedBox(height: AppSpacing.space8),
              ],
              Text(
                'customLists.list.webOnly'.tr(),
                style: textTheme.bodySmall?.copyWith(
                  color: colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: AppSpacing.space12),
              TextField(
                key: const Key('customListSearch'),
                controller: _search,
                onChanged: _onSearchChanged,
                textInputAction: TextInputAction.search,
                decoration: InputDecoration(
                  prefixIcon: const Icon(Icons.search),
                  labelText: 'customLists.list.search'.tr(),
                  border: const OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: AppSpacing.space12),
              if (_started && !_loading && !_failed && _rows.isEmpty)
                Text(
                  _query.isEmpty
                      ? 'customLists.list.noRows'.tr()
                      : 'customLists.list.noMatches'.tr(),
                  key: const Key('customListNoRows'),
                )
              else ...[
                if (_rows.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(bottom: AppSpacing.space8),
                    child: Text(
                      'customLists.rows'.plural(_total),
                      style: textTheme.labelLarge,
                    ),
                  ),
                for (final row in _rows)
                  CustomListRowCard(row: row, columns: columns),
              ],
              if (_failed)
                _ErrorMessage(
                  messageKey: _rows.isEmpty
                      ? 'customLists.list.loadError'
                      : 'customLists.list.loadMoreError',
                  onRetry: _load,
                )
              else if (_loading || !_started)
                const Padding(
                  padding: EdgeInsets.all(AppSpacing.space16),
                  child: Center(child: CircularProgressIndicator()),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

const _ascending = '__ascending';
const _descendingChoice = '__descending';

class _ErrorMessage extends StatelessWidget {
  const _ErrorMessage({required this.messageKey, required this.onRetry});

  final String messageKey;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(AppSpacing.space24),
      child: Column(
        children: [
          Text(messageKey.tr(), textAlign: TextAlign.center),
          const SizedBox(height: AppSpacing.space12),
          OutlinedButton(
            onPressed: onRetry,
            child: Text('customLists.retry'.tr()),
          ),
        ],
      ),
    );
  }
}
