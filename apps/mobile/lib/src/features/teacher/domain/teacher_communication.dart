import '../../../core/api/generated/models/create_incident_body_incident_type.dart';
import '../../../core/api/generated/models/create_incident_body_severity.dart';

/// Presentation helpers for the teacher communication screens (ST-238): the incident report form's
/// two closed vocabularies. Kept out of the widgets so the enum-to-label-key mapping has one home
/// and the `$unknown` sentinel the generated enums carry is filtered in exactly one place.

/// The incident categories a teacher may file, in the order the form lists them, `$unknown`
/// excluded. `other` is kept last as the catch-all.
const incidentTypeOptions = <CreateIncidentBodyIncidentType>[
  CreateIncidentBodyIncidentType.behavioral,
  CreateIncidentBodyIncidentType.academicIntegrity,
  CreateIncidentBodyIncidentType.attendance,
  CreateIncidentBodyIncidentType.bullying,
  CreateIncidentBodyIncidentType.substance,
  CreateIncidentBodyIncidentType.vandalism,
  CreateIncidentBodyIncidentType.safety,
  CreateIncidentBodyIncidentType.other,
];

/// Severities from least to most serious — the same order the Principal workflow and the
/// `app.discipline_severity` enum use.
const incidentSeverityOptions = <CreateIncidentBodySeverity>[
  CreateIncidentBodySeverity.minor,
  CreateIncidentBodySeverity.moderate,
  CreateIncidentBodySeverity.major,
  CreateIncidentBodySeverity.critical,
];

/// Translation key for an incident category, e.g. `teacher.communication.incident.type.bullying`.
String incidentTypeLabelKey(CreateIncidentBodyIncidentType type) =>
    'teacher.communication.incident.type.${type.name}';

/// Translation key for a severity, e.g. `teacher.communication.incident.severity.major`.
String incidentSeverityLabelKey(CreateIncidentBodySeverity severity) =>
    'teacher.communication.incident.severity.${severity.name}';
