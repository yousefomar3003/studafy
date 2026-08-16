-- Creates app.flashcard_decks, app.flashcards, and app.flashcard_reviews: the school-owned store for
-- AI-generated flashcard decks (ST-168) and the per-student spaced-repetition progress that advances
-- them. Cards are grounded on ingested material chunks with a per-card citation, the same posture
-- quiz_questions (000099) takes; reviews carry each student's SM-2 schedule per card.
--
-- Depends on 000008 (app.students), 000019 (app.material_chunks), and 000006
-- (app.apply_tenant_isolation).
--
-- flashcard_decks: one row per generated deck, scoped to a student within a school. Append-only,
-- like quizzes -- a deck is never edited after generation.
-- flashcards: one row per card, carrying the card type (term_definition or q_a), the front
-- (term / question) and back (definition / answer), and a citation to the single material chunk the
-- card was grounded on. A card's back is the study answer -- unlike quiz_questions there is no hidden
-- answer key, because flashcards are self-graded.
-- flashcard_reviews: one row per student-card -- the mutable SM-2 progress (interval, ease factor,
-- repetition count, next due_at) plus a lifetime review_count. This is the one non-append-only table
-- in the feature: it is deliberately a state row, because spaced-repetition scheduling needs the
-- latest schedule, not a history of every rating. See ck_flashcard_reviews_* for the SM-2 bounds the
-- database re-asserts independently of the application (apps/api/src/modules/ai/flashcards/
-- scheduling.ts enforces the same arithmetic before this row is ever written).
--
-- No updated_at on flashcard_decks or flashcards: both are append-only, never mutated after
-- creation (same rationale as audit_logs in 000018 and ai_messages in 000021). flashcard_reviews
-- does carry updated_at -- it is the one table in the feature that is updated in place.
--
-- Normalization: a card's citation is its material_chunk_id, nothing denormalized alongside it (no
-- material title, no page number copied here) -- exactly the ai_message_citations precedent (000023)
-- and the quiz_questions precedent (000099). Rendering a citation joins back to app.material_chunks /
-- app.materials at read time.

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.flashcard_decks (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_flashcard_decks PRIMARY KEY,
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  model text NOT NULL,
  card_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_flashcard_decks_id_school UNIQUE (id, school_id),

  CONSTRAINT fk_flashcard_decks_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_flashcard_decks_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_flashcard_decks_model CHECK (model = btrim(model) AND model <> ''),
  CONSTRAINT ck_flashcard_decks_card_count CHECK (card_count >= 1)
);

-- One card: a term/definition or Q/A item, with its citation to the single material chunk it was
-- grounded on. card_order is the card's 1-based position within its deck -- a structural column,
-- like material_chunks.chunk_index and quiz_questions.question_order, not a repeating group: it is
-- what makes a deck's card sequence reconstructible in the order the model produced it.
--
-- front/back are both mandatory and non-empty: a card with an empty face is not a card. There is no
-- FK from flashcard_reviews' back-anchoring here -- the reviews table references the card, not its
-- text.
CREATE TABLE app.flashcards (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_flashcards PRIMARY KEY,
  school_id uuid NOT NULL,
  deck_id uuid NOT NULL,
  card_order integer NOT NULL,
  card_type text NOT NULL,
  front text NOT NULL,
  back text NOT NULL,
  material_chunk_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_flashcards_id_school UNIQUE (id, school_id),
  -- The real business key: a deck has exactly one card at each ordinal. Also the relational
  -- lookup index for "load this deck's cards in order" -- school_id leading -- so no separate
  -- CREATE INDEX is issued for it, the same reasoning as uq_quiz_questions_quiz_order (000099).
  CONSTRAINT uq_flashcards_deck_order UNIQUE (school_id, deck_id, card_order),

  CONSTRAINT fk_flashcards_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_flashcards_deck FOREIGN KEY (deck_id, school_id)
    REFERENCES app.flashcard_decks (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  -- CASCADE, not RESTRICT: this is the ai_message_citations precedent (000023) and the
  -- quiz_questions precedent (000099). A citation is meaningless once its chunk is gone, and
  -- RESTRICT here would make a material undeletable for as long as any card ever cited it.
  CONSTRAINT fk_flashcards_chunk FOREIGN KEY (material_chunk_id, school_id)
    REFERENCES app.material_chunks (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,

  CONSTRAINT ck_flashcards_order CHECK (card_order >= 1),
  CONSTRAINT ck_flashcards_type CHECK (card_type IN ('term_definition', 'q_a')),
  CONSTRAINT ck_flashcards_front CHECK (front = btrim(front) AND front <> ''),
  CONSTRAINT ck_flashcards_back CHECK (back = btrim(back) AND back <> '')
);

-- One row per (student, card) -- the SM-2 progress. This is a state row, not a log: every review
-- overwrites it, so the "next due" query reads the latest schedule in one row. review_count is the
-- lifetime total, so progress tracking does not need a review-history table to answer "how many
-- times has this student reviewed this card".
--
-- interval_days / repetitions / due_at / ease_factor are the SM-2 schedule advanced by
-- flashcards/scheduling.ts. The CHECKs below are the database-level half of "the review schedule
-- advances per algorithm": ease_factor never drops below 1.3 (SM-2's floor), interval_days and
-- repetitions and review_count never go negative. The algorithm's exact arithmetic (the 1/6/growing
-- interval ladder and the EF delta) stays application-level, the same posture quiz_questions takes
-- for option-cardinality bounds that a CHECK constraint cannot express without a subquery.
CREATE TABLE app.flashcard_reviews (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_flashcard_reviews PRIMARY KEY,
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  card_id uuid NOT NULL,
  interval_days integer NOT NULL,
  ease_factor numeric(4,2) NOT NULL,
  repetitions integer NOT NULL,
  due_at timestamptz NOT NULL,
  review_count integer NOT NULL,
  last_rated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_flashcard_reviews_id_school UNIQUE (id, school_id),
  -- The upsert key: one schedule per student per card. Also the relational lookup index for
  -- "load this student's progress for these cards" -- school_id leading -- so no separate CREATE
  -- INDEX is issued for it.
  CONSTRAINT uq_flashcard_reviews_student_card UNIQUE (school_id, student_id, card_id),

  CONSTRAINT fk_flashcard_reviews_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- The card already identifies its owning student through its deck; student_id is kept explicit so
  -- the "progress per student" lookups and the upsert key do not need to join through the deck.
  CONSTRAINT fk_flashcard_reviews_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_flashcard_reviews_card FOREIGN KEY (card_id, school_id)
    REFERENCES app.flashcards (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,

  CONSTRAINT ck_flashcard_reviews_interval CHECK (interval_days >= 0),
  CONSTRAINT ck_flashcard_reviews_ease CHECK (ease_factor >= 1.3),
  CONSTRAINT ck_flashcard_reviews_repetitions CHECK (repetitions >= 0),
  CONSTRAINT ck_flashcard_reviews_review_count CHECK (review_count >= 0)
);

-- ---------------------------------------------------------------------------------------------------
-- 2. Indexes
-- ---------------------------------------------------------------------------------------------------

-- List a student's decks newest-first. school_id leads for RLS predicate pushdown -- the same
-- shape ai_conversations (000021) and idx_quizzes_school_student_created_at (000099) use.
CREATE INDEX idx_flashcard_decks_school_student_created_at
  ON app.flashcard_decks (school_id, student_id, created_at DESC, id DESC);

-- The review "due next" read: the cards of one deck that are due now. uq_flashcards_deck_order
-- already serves the deck -> cards side; this index serves the reviews side (school, then student,
-- then card, then whether the review is due), the same school_id-leading shape every tenant lookup
-- in this codebase uses.
CREATE INDEX idx_flashcard_reviews_due
  ON app.flashcard_reviews (school_id, student_id, card_id, due_at);

-- ---------------------------------------------------------------------------------------------------
-- 3. Grants and RLS
-- ---------------------------------------------------------------------------------------------------

REVOKE ALL PRIVILEGES ON TABLE app.flashcard_decks, app.flashcards, app.flashcard_reviews FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.flashcard_decks, app.flashcards, app.flashcard_reviews
  TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'flashcard_decks');
SELECT app.apply_tenant_isolation('app', 'flashcards');
SELECT app.apply_tenant_isolation('app', 'flashcard_reviews');

RESET ROLE;
