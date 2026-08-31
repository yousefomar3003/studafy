/// One AI capability the hub links to, once its own screen ships — this ticket builds the hub
/// and upsell, not the feature screens themselves (each tile opens a "coming soon" placeholder
/// today; see `presentation/widgets/ai_feature_grid.dart`).
///
/// Identifiers and ordering mirror `AI_FEATURES` (`apps/api/src/modules/ai/llm/routing.ts`)
/// exactly, so a feature reads the same name across the stack. `summary` matches that list
/// verbatim, not the `/summarize` route path.
enum AiFeature { ask, exam, summary, concepts, flashcards, quiz, explain }
