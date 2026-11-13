-- A per-class switch for using the class's study materials with the AI study assistant.
--
-- Until now every material a teacher uploaded with ai_visible = true (the default) was chunked into
-- app.material_chunks and its text was sent to the AI provider whenever a student used Ask AI,
-- quizzes, flashcards, summaries or exams, and nothing let a teacher opt a whole class out. This
-- column is that opt-out, set by the class's teachers or school leadership through
-- PUT /api/academics/classes/{classId}/ai-materials.
--
-- While it is false:
--   - the API deletes the class's existing chunks (and with them, by ON DELETE CASCADE, every
--     generated quiz question, flashcard, exam item and citation grounded on them), so nothing
--     derived from the materials remains;
--   - the scan worker marks a newly uploaded, clean material `ready` without handing it to AI
--     ingestion, and the ingestion worker refuses to claim a material of such a class;
--   - every AI read path (retrieval, explain, summary, quiz, exam) treats the class's materials as
--     unavailable.
-- Turning it back on re-stages the class's AI-visible `ready` materials to `queued` and the API
-- enqueues their ingestion.
--
-- Default true keeps the existing behaviour for every class, old and new.

SET ROLE studafy_admin;

ALTER TABLE app.classes
  ADD COLUMN ai_materials_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN app.classes.ai_materials_enabled IS
  'Whether this class''s materials may be used with the AI study assistant (000196). False keeps '
  'them out of ingestion, retrieval and generation, and its chunks are deleted when it is turned off.';

RESET ROLE;
