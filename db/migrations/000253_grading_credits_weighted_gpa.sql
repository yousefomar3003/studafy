-- Grading: credit hours, course levels and the weighted GPA (American and IB schools).
--
-- 1. SUBJECT CONFIG. A subject (grade default, section override or section-only subject) may say
--    how many credit hours it is worth, its course level and a GPA boost:
--
--      credits       credit hours (0-100, e.g. 1 or 0.5); NULL when the school does not use
--                    credits. Reported as credits attempted/earned; the coefficient
--                    (average_weight) still weights the average and GPA.
--      course_level  a short label shown beside the subject ("Honors", "AP", "HL", "SL").
--      gpa_boost     added to a passed subject's grade-band GPA points for the weighted GPA
--                    (Honors +0.5, AP +1); 0 means no boost. The unweighted GPA never changes.
--
-- 2. SNAPSHOTS (ADR-017). A finalized subject result records the credits, course level and boost
--    it was finalized with, and its weighted GPA points (the band's points plus the boost when
--    passed; the plain points when failed; NULL without a boost or band points). A finalized
--    overall result records the weighted GPA beside result_value (only for a GPA result where a
--    counted subject has a boost) and the credits attempted and earned. Rows finalized before this
--    migration keep NULL everywhere: no credits, no boost, no weighted GPA.
--
-- Expand only: new nullable columns, or a NOT NULL column with a default.

SET ROLE studafy_admin;

ALTER TABLE app.subject_configs
  ADD COLUMN credits numeric(5, 2),
  ADD COLUMN course_level text,
  ADD COLUMN gpa_boost numeric(4, 2) NOT NULL DEFAULT 0,
  ADD CONSTRAINT ck_subject_configs_credits CHECK (credits IS NULL OR (credits >= 0 AND credits <= 100)),
  ADD CONSTRAINT ck_subject_configs_course_level CHECK (
    course_level IS NULL OR (btrim(course_level) <> '' AND char_length(course_level) <= 40)
  ),
  ADD CONSTRAINT ck_subject_configs_gpa_boost CHECK (gpa_boost >= 0 AND gpa_boost <= 5);

COMMENT ON COLUMN app.subject_configs.credits IS
  'Credit hours the subject is worth (0-100); NULL when the school does not use credits. Reported as credits attempted/earned; average_weight still weights the average and GPA.';
COMMENT ON COLUMN app.subject_configs.course_level IS
  'A short course level label shown with the subject (Honors, AP, HL, SL); NULL for none.';
COMMENT ON COLUMN app.subject_configs.gpa_boost IS
  'Added to a passed subject''s GPA points for the weighted GPA (Honors 0.5, AP 1); 0 for none.';

ALTER TABLE app.student_subject_results
  ADD COLUMN credits numeric(5, 2),
  ADD COLUMN course_level text,
  ADD COLUMN gpa_boost numeric(4, 2),
  ADD COLUMN weighted_gpa_points numeric(5, 2),
  ADD CONSTRAINT ck_student_subject_results_credits
    CHECK (credits IS NULL OR (credits >= 0 AND credits <= 100)),
  ADD CONSTRAINT ck_student_subject_results_course_level
    CHECK (course_level IS NULL OR char_length(course_level) <= 40),
  ADD CONSTRAINT ck_student_subject_results_gpa_boost
    CHECK (gpa_boost IS NULL OR (gpa_boost >= 0 AND gpa_boost <= 5)),
  -- Weighted points exist only for a complete result whose band carries points.
  ADD CONSTRAINT ck_student_subject_results_weighted_gpa_points CHECK (
    weighted_gpa_points IS NULL
    OR (status = 'complete' AND gpa_points IS NOT NULL AND weighted_gpa_points >= 0)
  );

COMMENT ON COLUMN app.student_subject_results.credits IS
  'The subject''s credit hours when finalized; NULL without credits or on rows finalized before 000253.';
COMMENT ON COLUMN app.student_subject_results.course_level IS
  'The subject''s course level label when finalized (Honors, AP, HL...); NULL for none.';
COMMENT ON COLUMN app.student_subject_results.gpa_boost IS
  'The subject''s GPA boost when finalized; NULL on rows finalized before 000253 (no boost).';
COMMENT ON COLUMN app.student_subject_results.weighted_gpa_points IS
  'gpa_points plus gpa_boost when passed (gpa_points when failed); NULL without a boost or band points.';

ALTER TABLE app.student_overall_results
  ADD COLUMN weighted_result_value numeric(9, 3),
  ADD COLUMN credits_attempted numeric(7, 2),
  ADD COLUMN credits_earned numeric(7, 2),
  ADD CONSTRAINT ck_student_overall_results_weighted_result_value CHECK (
    weighted_result_value IS NULL
    OR (result_format = 'gpa' AND result_value IS NOT NULL AND weighted_result_value >= 0)
  ),
  ADD CONSTRAINT ck_student_overall_results_credits CHECK (
    (credits_attempted IS NULL) = (credits_earned IS NULL)
    AND (credits_earned IS NULL OR (credits_earned >= 0 AND credits_earned <= credits_attempted))
  );

COMMENT ON COLUMN app.student_overall_results.weighted_result_value IS
  'The GPA with boosted subjects'' weighted points, beside result_value; NULL unless a GPA result has a boosted counted subject.';
COMMENT ON COLUMN app.student_overall_results.credits_attempted IS
  'Credits of the counted, complete subjects that carry credits; NULL when none does.';
COMMENT ON COLUMN app.student_overall_results.credits_earned IS
  'Credits of the counted subjects passed; NULL when no counted subject carries credits.';

RESET ROLE;
