-- studafy:migration transaction=off
-- Upload consistency for the Student AI programme's content bonus (phase 4 of the AI revenue share
-- programme; docs/billing/ai-upload-consistency.md).
--
-- Upload consistency is the share of school days on which a class's teachers published a lesson or
-- material, averaged across the classes that have Student AI. The API computes it on read
-- (apps/api/src/modules/licensing/upload-consistency.ts) for any [from, to] -- the school's and the
-- super admin's dashboards, and the revenue share engine for the school days a payment covers -- by
-- asking, for the measured classes, on which days each published something:
--
--   SELECT DISTINCT class_id, (published_at AT TIME ZONE <school timezone>)::date
--   FROM app.materials
--   WHERE school_id = $school AND source_kind = 'class' AND class_id = ANY($classes)
--     AND published_at >= $from AND published_at < $to
--
-- published_at is stamped once, when a class material first becomes visible to its students
-- (trg_materials_published, 000228/000232). Students' own AI sources (`personal`) and assignment AI
-- sources (`assignment`) are not teachers' class content and never count, so they stay out of the
-- index too. Without it each read walks every material the class ever had through
-- idx_materials_school_class_created_at; with it the read is a range scan of exactly the published
-- class materials in the period.
--
-- No snapshot table: the read is that one index range scan plus the school's calendar (a few
-- hundred days at most), cheap enough to run per request; the revenue share engine records the
-- percentage it used with each share it calculates, so nothing needs to be frozen here.
--
-- Built concurrently, so teachers' uploads (the table's writers) are never blocked, and on its own,
-- because CREATE INDEX CONCURRENTLY cannot share a migration with other statements.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_materials_school_class_published
  ON app.materials (school_id, class_id, published_at)
  WHERE source_kind = 'class' AND published_at IS NOT NULL;
