/// One AI capability the hub links to; each tile's destination is in
/// `presentation/widgets/ai_feature_grid.dart`.
///
/// Identifiers and ordering mirror `AI_FEATURES` (`apps/api/src/modules/ai/llm/routing.ts`)
/// exactly, so a feature reads the same name across the stack. `summary` matches that list
/// verbatim, not the `/summarize` route path.
enum AiFeature { ask, exam, summary, concepts, flashcards, quiz, explain }
