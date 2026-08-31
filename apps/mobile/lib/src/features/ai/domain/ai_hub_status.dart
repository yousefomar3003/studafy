import 'ai_usage.dart';

/// The AI tab's top-level state, mapped from `GET /api/ai/usage`'s outcome (see
/// `apps/api/src/modules/ai/gate/entitlement-gate.ts`'s `assertAiEntitled`, the decision flow
/// every `/api/ai/*` route shares: school active -> AI add-on active -> quota available).
///
/// A sealed three-plus-one shape, the same convention `TodaySection`
/// (`../../student/domain/today_section.dart`) and `GradeReportStatus`
/// (`../../student/domain/grade_report.dart`) already use for "loading finished, now what do we
/// show" — one state per reason there might be nothing to show yet, none of them an error.
sealed class AiHubStatus {
  const AiHubStatus();
}

/// The signed-in session's student id could not be resolved (`currentStudentIdProvider`'s
/// documented gap — see `../../student/application/student_context_providers.dart`). Distinct
/// from the entitlement states below: this app doesn't yet know *which* student to ask about, so
/// it never gets as far as calling the usage endpoint.
class AiHubUnavailable extends AiHubStatus {
  const AiHubUnavailable();
}

/// The school's own Studafy subscription is not active (`403 AI_SCHOOL_INACTIVE`). The AI add-on
/// is refused regardless of whether the student ever purchased one — see
/// `subscriptions/entitlements/resolve.ts`'s doc comment on why that's an AND over one joined row,
/// not two independent checks that could disagree.
class AiHubSchoolInactive extends AiHubStatus {
  const AiHubSchoolInactive();
}

/// No active AI add-on for this student (`402 AI_SUBSCRIPTION_INACTIVE`) — the upsell state.
class AiHubUnsubscribed extends AiHubStatus {
  const AiHubUnsubscribed();
}

/// An active AI add-on (`200`) — the feature hub state.
class AiHubSubscribed extends AiHubStatus {
  const AiHubSubscribed(this.usage);

  final AiUsage usage;
}

/// Maps a Studafy API `code` (`ApiException.code` — see `core/api/api_exception.dart`) from a
/// failed `GET /api/ai/usage` call onto the [AiHubStatus] it represents, or `null` for any other
/// code — a transient failure (`AI_QUOTA_UNAVAILABLE`, a network error, …) this function doesn't
/// have a dedicated state for, which the caller should treat as a genuine error instead.
///
/// Pure and dependency-free on purpose: `aiHubStatusProvider`
/// (`../application/ai_hub_providers.dart`) is the only caller, and keeping this mapping outside
/// that provider lets it be unit-tested without touching Dio or the generated API client at all.
AiHubStatus? aiHubStatusFromErrorCode(String? code) => switch (code) {
  'AI_SCHOOL_INACTIVE' => const AiHubSchoolInactive(),
  'AI_SUBSCRIPTION_INACTIVE' => const AiHubUnsubscribed(),
  _ => null,
};
