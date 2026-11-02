/// A `major.minor.patch` version — the ordering-comparable core of a Flutter build's version
/// string.
///
/// The `+build` suffix a full `pubspec.yaml` version carries (and any `-prerelease` tag) is
/// dropped on parse: the release floor served by `GET /api/mobile/config` is expressed in `x.y.z`
/// only, and that is the granularity the forced-update check compares at.
class AppVersion implements Comparable<AppVersion> {
  const AppVersion(this.major, this.minor, this.patch);

  /// Parses `x.y.z`, tolerating a trailing `+build` or `-prerelease` which it ignores.
  /// Throws [FormatException] on anything else.
  factory AppVersion.parse(String raw) {
    final core = raw.trim().split('+').first.split('-').first;
    final parts = core.split('.');
    if (parts.length != 3) {
      throw FormatException('expected a x.y.z version', raw);
    }
    int component(int index) {
      final value = int.tryParse(parts[index]);
      if (value == null || value < 0) {
        throw FormatException('expected a x.y.z version', raw);
      }
      return value;
    }

    return AppVersion(component(0), component(1), component(2));
  }

  /// [AppVersion.parse] returning `null` instead of throwing — for the fail-open paths where an
  /// unreadable version must not lock the user out.
  static AppVersion? tryParse(String raw) {
    try {
      return AppVersion.parse(raw);
    } on FormatException {
      return null;
    }
  }

  final int major;
  final int minor;
  final int patch;

  bool operator <(AppVersion other) => compareTo(other) < 0;

  bool operator >(AppVersion other) => compareTo(other) > 0;

  @override
  int compareTo(AppVersion other) {
    if (major != other.major) return major.compareTo(other.major);
    if (minor != other.minor) return minor.compareTo(other.minor);
    return patch.compareTo(other.patch);
  }

  @override
  bool operator ==(Object other) => other is AppVersion && compareTo(other) == 0;

  @override
  int get hashCode => Object.hash(major, minor, patch);

  @override
  String toString() => '$major.$minor.$patch';
}
