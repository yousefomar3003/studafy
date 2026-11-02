/// Custom lists (OpenAPI tag "Custom lists", docs/modules/custom-lists.md): school-defined tables
/// for data Studafy has no section for -- bus routes, library loans, lockers -- read-only here.
/// Lists are created and edited on the web; the API refuses every write from the mobile channel.
///
/// Hand-written, as `features/account/domain/own_staff_record.dart` is: a cell's value is a
/// string, number, yes/no or list of choices (`RecordValue`), which the generator turns into an
/// empty wrapper class. JSON shapes follow the API's `custom-lists/schemas.ts`.
///
/// A sensitive cell never reaches the phone in full: the API sends its mask only, and the reveal
/// (a POST, so web-only) is not offered here.
library;

/// One choice of a choice column, as the school named it.
class ListChoice {
  const ListChoice({
    required this.value,
    required this.labelEn,
    required this.labelAr,
  });

  factory ListChoice.fromJson(Map<String, Object?> json) => ListChoice(
    value: json['value']! as String,
    labelEn: json['label_en']! as String,
    labelAr: json['label_ar']! as String,
  );

  final String value;
  final String labelEn;
  final String labelAr;

  String label(String languageCode) => languageCode == 'ar' ? labelAr : labelEn;
}

/// One column of a list.
class CustomListColumn {
  const CustomListColumn({
    required this.id,
    required this.fieldType,
    required this.labelEn,
    required this.labelAr,
    required this.sensitive,
    required this.archived,
    required this.options,
  });

  factory CustomListColumn.fromJson(Map<String, Object?> json) =>
      CustomListColumn(
        id: json['id']! as String,
        fieldType: json['field_type']! as String,
        labelEn: json['label_en']! as String,
        labelAr: json['label_ar']! as String,
        sensitive: json['sensitivity'] == 'sensitive',
        archived: json['archived'] == true,
        options: [
          for (final option in _list(json['options']))
            ListChoice.fromJson(_map(option)),
        ],
      );

  final String id;

  /// `short_text`, `long_text`, `number`, `date`, `single_choice`, `multi_choice`, `yes_no`,
  /// `phone` or `email`.
  final String fieldType;
  final String labelEn;
  final String labelAr;
  final bool sensitive;
  final bool archived;
  final List<ListChoice> options;

  String label(String languageCode) => languageCode == 'ar' ? labelAr : labelEn;
}

/// A list as the lists screen shows it.
class CustomListSummary {
  const CustomListSummary({
    required this.id,
    required this.nameEn,
    required this.nameAr,
    required this.description,
    required this.audience,
    required this.archived,
    required this.rowCount,
  });

  factory CustomListSummary.fromJson(Map<String, Object?> json) =>
      CustomListSummary(
        id: json['id']! as String,
        nameEn: json['name_en']! as String,
        nameAr: json['name_ar']! as String,
        description: json['description'] as String?,
        audience: json['audience']! as String,
        archived: json['archived'] == true,
        rowCount: (json['row_count'] as num?)?.toInt() ?? 0,
      );

  final String id;
  final String nameEn;
  final String nameAr;
  final String? description;

  /// `admins`, `leadership` or `staff`: who besides the school admin may read the list.
  final String audience;
  final bool archived;
  final int rowCount;

  String name(String languageCode) => languageCode == 'ar' ? nameAr : nameEn;
}

/// A list with its columns, in display order.
class CustomListDetail {
  const CustomListDetail({required this.summary, required this.columns});

  factory CustomListDetail.fromJson(Map<String, Object?> json) =>
      CustomListDetail(
        summary: CustomListSummary.fromJson(json),
        columns: [
          for (final column in _list(json['columns']))
            CustomListColumn.fromJson(_map(column)),
        ],
      );

  final CustomListSummary summary;
  final List<CustomListColumn> columns;

  /// The columns rows are shown with: archived ones are hidden, as on the web.
  List<CustomListColumn> get activeColumns =>
      columns.where((column) => !column.archived).toList();
}

/// One filled cell.
class CustomListCell {
  const CustomListCell({
    required this.columnId,
    required this.value,
    required this.masked,
    required this.mask,
  });

  factory CustomListCell.fromJson(Map<String, Object?> json) => CustomListCell(
    columnId: json['column_id']! as String,
    value: json['value'],
    masked: json['masked'] == true,
    mask: json['mask'] as String?,
  );

  final String columnId;

  /// The raw value: a string, number, bool or list of choice values; null for a masked cell.
  final Object? value;
  final bool masked;
  final String? mask;

  /// The cell as text. A sensitive cell reads as its mask only; a choice as the school's label for
  /// it; a date as its calendar day (the API may send a midnight-UTC timestamp, whose first ten
  /// characters are the day).
  String display(
    CustomListColumn column,
    String languageCode, {
    required String yes,
    required String no,
  }) {
    if (masked) return mask ?? '••••';
    final raw = value;
    if (raw == null) return '';
    String choice(Object? item) {
      for (final option in column.options) {
        if (option.value == item) return option.label(languageCode);
      }
      return '$item';
    }

    switch (column.fieldType) {
      case 'yes_no':
        return raw == true ? yes : no;
      case 'single_choice':
        return choice(raw);
      case 'multi_choice':
        return raw is List ? raw.map(choice).join(', ') : choice(raw);
      case 'date':
        final text = '$raw';
        return text.length >= 10 ? text.substring(0, 10) : text;
      case 'number':
        return raw is num && raw == raw.roundToDouble()
            ? '${raw.toInt()}'
            : '$raw';
      default:
        return '$raw';
    }
  }
}

/// Who or what a row is about.
class CustomListRowLink {
  const CustomListRowLink({
    required this.kind,
    required this.id,
    required this.name,
  });

  factory CustomListRowLink.fromJson(Map<String, Object?> json) =>
      CustomListRowLink(
        kind: json['kind']! as String,
        id: json['id']! as String,
        name: json['name'] as String?,
      );

  /// `student`, `parent`, `staff` or `class`.
  final String kind;
  final String id;

  /// Null when the signed-in user may not see that person or class.
  final String? name;
}

class CustomListRow {
  const CustomListRow({
    required this.id,
    required this.link,
    required this.cells,
  });

  factory CustomListRow.fromJson(Map<String, Object?> json) {
    final link = json['link'];
    return CustomListRow(
      id: json['id']! as String,
      link: link is Map ? CustomListRowLink.fromJson(_map(link)) : null,
      cells: [
        for (final cell in _list(json['cells']))
          CustomListCell.fromJson(_map(cell)),
      ],
    );
  }

  final String id;
  final CustomListRowLink? link;
  final List<CustomListCell> cells;

  CustomListCell? cell(String columnId) {
    for (final cell in cells) {
      if (cell.columnId == columnId) return cell;
    }
    return null;
  }
}

/// One page of a list's rows.
class CustomListRowPage {
  const CustomListRowPage({required this.rows, required this.total});

  factory CustomListRowPage.fromJson(Map<String, Object?> json) =>
      CustomListRowPage(
        rows: [
          for (final row in _list(json['rows']))
            CustomListRow.fromJson(_map(row)),
        ],
        total: (json['total'] as num?)?.toInt() ?? 0,
      );

  final List<CustomListRow> rows;
  final int total;
}

/// The rows of one list that link to a given student, parent, member of staff or class.
class LinkedCustomList {
  const LinkedCustomList({
    required this.listId,
    required this.nameEn,
    required this.nameAr,
    required this.columns,
    required this.rows,
    required this.total,
  });

  factory LinkedCustomList.fromJson(Map<String, Object?> json) {
    final list = _map(json['list']);
    return LinkedCustomList(
      listId: list['id']! as String,
      nameEn: list['name_en']! as String,
      nameAr: list['name_ar']! as String,
      columns: [
        for (final column in _list(json['columns']))
          CustomListColumn.fromJson(_map(column)),
      ],
      rows: [
        for (final row in _list(json['rows']))
          CustomListRow.fromJson(_map(row)),
      ],
      total: (json['total'] as num?)?.toInt() ?? 0,
    );
  }

  final String listId;
  final String nameEn;
  final String nameAr;
  final List<CustomListColumn> columns;
  final List<CustomListRow> rows;

  /// Every linked row, of which at most 50 are in [rows].
  final int total;

  String name(String languageCode) => languageCode == 'ar' ? nameAr : nameEn;
}

List<Object?> _list(Object? value) =>
    value is List ? value.cast<Object?>() : const <Object?>[];

Map<String, Object?> _map(Object? value) =>
    Map<String, Object?>.from(value! as Map);
