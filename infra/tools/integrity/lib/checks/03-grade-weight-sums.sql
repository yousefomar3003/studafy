-- integrity check: grade-weight-sums
--
-- The active assessment categories of one gradebook must weight to exactly 100%: the application
-- layer enforces this and returns a machine-readable INVALID_GRADEBOOK_WEIGHT_TOTAL error
-- (migration 000052). This check mirrors that invariant at the SQL level for this school. A NULL
-- sum (gradebook has zero active categories -- e.g. the demo seed, which creates none) is vacuously
-- fine and is never a finding; the check passes even if no gradebook in the school has categories
-- at all. The row-level CHECK (0 <= weight <= 100) is not re-derived here; only the sum invariant is.
--
-- One JSON line on stdout. Run via:
--   psql -X -tA -v ON_ERROR_STOP=1 -v school_id=<uuid> -f 03-grade-weight-sums.sql
-- The first statement prints set_config's return value; consume only the last output line.

SELECT set_config('app.school_id', :'school_id', false);

CREATE TEMP TABLE findings (
  gradebook_id      text NOT NULL,
  class_code        text,
  active_categories integer NOT NULL,
  sum_weight        text NOT NULL,
  detail            text NOT NULL
);

INSERT INTO findings (gradebook_id, class_code, active_categories, sum_weight, detail)
SELECT gb.id::text                              AS gradebook_id,
       c.code                                   AS class_code,
       count(ac.*)::integer                     AS active_categories,
       sum(ac.weight)::text                     AS sum_weight,
       format('gradebook for class %s has %s active assessment categor(ies) weighing %s; active weights must total exactly 100',
         c.code, count(ac.*), sum(ac.weight))   AS detail
FROM app.gradebooks AS gb
JOIN app.classes AS c ON c.id = gb.class_id AND c.school_id = gb.school_id
LEFT JOIN app.assessment_categories AS ac
  ON ac.gradebook_id = gb.id
 AND ac.school_id = gb.school_id
 AND ac.is_active
WHERE gb.school_id = current_setting('app.school_id')::uuid
GROUP BY gb.id, c.code
HAVING count(ac.*) > 0
   AND sum(ac.weight) <> 100;

SELECT json_build_object(
  'check', 'grade-weight-sums',
  'status', CASE WHEN (SELECT count(*) FROM findings) = 0 THEN 'pass' ELSE 'fail' END,
  'findings_count', (SELECT count(*) FROM findings),
  'findings', COALESCE((
    SELECT json_agg(json_build_object(
      'gradebook_id', gradebook_id,
      'class_code', class_code,
      'active_categories', active_categories,
      'sum_weight', sum_weight,
      'detail', detail
    ) ORDER BY class_code, gradebook_id)
    FROM (SELECT * FROM findings ORDER BY class_code LIMIT 100) f
  ), '[]'::json),
  'summary', (SELECT
    CASE WHEN (SELECT count(*) FROM findings) = 0
      THEN 'every gradebook with active assessment categories weighs exactly 100 (gradebooks with none are skipped)'
      ELSE (SELECT
        'found ' || count(*) || ' gradebook(s) whose active assessment category weights do not total exactly 100: ' ||
        string_agg(class_code || ' (' || sum_weight || ')', ', ')
        FROM findings)
    END
  )
);