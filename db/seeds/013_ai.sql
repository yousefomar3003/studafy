-- Seed AI subscriptions, conversations, messages, and usage meters.
-- Depends on: 004 (students), 008 (material_chunks for citations).

SET LOCAL ROLE studafy_admin;

-- Subscriptions: one per student, mix of active and trialing
INSERT INTO app.ai_subscriptions (school_id, student_id, status, current_period_start, current_period_end)
SELECT
  current_setting('app.school_id')::uuid,
  s.id,
  'active',
  '2026-07-01 00:00:00+00'::timestamptz,
  '2026-08-01 00:00:00+00'::timestamptz
FROM app.students s
WHERE s.school_id = current_setting('app.school_id')::uuid AND s.admission_number = 'ADM-2026-001'
ON CONFLICT (school_id, student_id) DO NOTHING;

INSERT INTO app.ai_subscriptions (school_id, student_id, status, current_period_start, current_period_end)
SELECT
  current_setting('app.school_id')::uuid,
  s.id,
  'active',
  '2026-07-01 00:00:00+00'::timestamptz,
  '2026-08-01 00:00:00+00'::timestamptz
FROM app.students s
WHERE s.school_id = current_setting('app.school_id')::uuid AND s.admission_number = 'ADM-2026-002'
ON CONFLICT (school_id, student_id) DO NOTHING;

INSERT INTO app.ai_subscriptions (school_id, student_id, status, current_period_start, current_period_end)
SELECT
  current_setting('app.school_id')::uuid,
  s.id,
  'trialing',
  '2026-07-10 00:00:00+00'::timestamptz,
  '2026-08-10 00:00:00+00'::timestamptz
FROM app.students s
WHERE s.school_id = current_setting('app.school_id')::uuid AND s.admission_number = 'ADM-2026-003'
ON CONFLICT (school_id, student_id) DO NOTHING;

INSERT INTO app.ai_subscriptions (school_id, student_id, status, current_period_start, current_period_end)
SELECT
  current_setting('app.school_id')::uuid,
  s.id,
  'trialing',
  '2026-07-12 00:00:00+00'::timestamptz,
  '2026-08-12 00:00:00+00'::timestamptz
FROM app.students s
WHERE s.school_id = current_setting('app.school_id')::uuid AND s.admission_number = 'ADM-2026-004'
ON CONFLICT (school_id, student_id) DO NOTHING;

INSERT INTO app.ai_subscriptions (school_id, student_id, status, current_period_start, current_period_end)
SELECT
  current_setting('app.school_id')::uuid,
  s.id,
  'trialing',
  '2026-07-14 00:00:00+00'::timestamptz,
  '2026-08-14 00:00:00+00'::timestamptz
FROM app.students s
WHERE s.school_id = current_setting('app.school_id')::uuid AND s.admission_number = 'ADM-2026-005'
ON CONFLICT (school_id, student_id) DO NOTHING;

-- Conversations: two for Alice, one for Bob
INSERT INTO app.ai_conversations (school_id, student_id, model)
SELECT
  current_setting('app.school_id')::uuid,
  s.id,
  'gpt-4o'
FROM app.students s
WHERE s.school_id = current_setting('app.school_id')::uuid AND s.admission_number = 'ADM-2026-001'
ON CONFLICT DO NOTHING;

INSERT INTO app.ai_conversations (school_id, student_id, model)
SELECT
  current_setting('app.school_id')::uuid,
  s.id,
  'gpt-4o-mini'
FROM app.students s
WHERE s.school_id = current_setting('app.school_id')::uuid AND s.admission_number = 'ADM-2026-001'
ON CONFLICT DO NOTHING;

INSERT INTO app.ai_conversations (school_id, student_id, model)
SELECT
  current_setting('app.school_id')::uuid,
  s.id,
  'gpt-4o'
FROM app.students s
WHERE s.school_id = current_setting('app.school_id')::uuid AND s.admission_number = 'ADM-2026-002'
ON CONFLICT DO NOTHING;

-- Messages in Alice's first conversation
INSERT INTO app.ai_messages (school_id, conversation_id, question, answer, prompt_tokens, completion_tokens, total_tokens, expires_at)
SELECT
  current_setting('app.school_id')::uuid,
  c.id,
  'What is the quadratic formula?',
  'The quadratic formula is x = (-b +/- sqrt(b^2 - 4ac)) / 2a, used to solve quadratic equations of the form ax^2 + bx + c = 0.',
  25,
  80,
  105,
  '2026-08-01 00:00:00+00'::timestamptz
FROM app.ai_conversations c
WHERE c.school_id = current_setting('app.school_id')::uuid
  AND c.student_id = (SELECT id FROM app.students WHERE school_id = current_setting('app.school_id')::uuid AND admission_number = 'ADM-2026-001')
  AND c.model = 'gpt-4o'
  AND c.created_at = (
    SELECT MIN(c2.created_at)
    FROM app.ai_conversations c2
    WHERE c2.school_id = current_setting('app.school_id')::uuid
      AND c2.student_id = (SELECT id FROM app.students WHERE school_id = current_setting('app.school_id')::uuid AND admission_number = 'ADM-2026-001')
      AND c2.model = 'gpt-4o'
  )
ON CONFLICT DO NOTHING;

INSERT INTO app.ai_messages (school_id, conversation_id, question, answer, prompt_tokens, completion_tokens, total_tokens, expires_at)
SELECT
  current_setting('app.school_id')::uuid,
  c.id,
  'Can you show me an example?',
  'Sure! For the equation 2x^2 + 5x - 3 = 0, a=2, b=5, c=-3. Plugging in: x = (-5 +/- sqrt(25 + 24)) / 4 = (-5 +/- 7) / 4. So x = 0.5 or x = -3.',
  45,
  120,
  165,
  '2026-08-01 00:00:00+00'::timestamptz
FROM app.ai_conversations c
WHERE c.school_id = current_setting('app.school_id')::uuid
  AND c.student_id = (SELECT id FROM app.students WHERE school_id = current_setting('app.school_id')::uuid AND admission_number = 'ADM-2026-001')
  AND c.model = 'gpt-4o'
  AND c.created_at = (
    SELECT MIN(c2.created_at)
    FROM app.ai_conversations c2
    WHERE c2.school_id = current_setting('app.school_id')::uuid
      AND c2.student_id = (SELECT id FROM app.students WHERE school_id = current_setting('app.school_id')::uuid AND admission_number = 'ADM-2026-001')
      AND c2.model = 'gpt-4o'
  )
ON CONFLICT DO NOTHING;

-- Message in Alice's second conversation
INSERT INTO app.ai_messages (school_id, conversation_id, question, answer, prompt_tokens, completion_tokens, total_tokens, expires_at)
SELECT
  current_setting('app.school_id')::uuid,
  c.id,
  'Explain photosynthesis in simple terms.',
  'Photosynthesis is how plants convert sunlight, water, and CO2 into glucose (food) and oxygen. Think of it as a recipe: sunlight is the oven, water and CO2 are ingredients, and glucose + oxygen are the result.',
  30,
  95,
  125,
  '2026-08-10 00:00:00+00'::timestamptz
FROM app.ai_conversations c
WHERE c.school_id = current_setting('app.school_id')::uuid
  AND c.student_id = (SELECT id FROM app.students WHERE school_id = current_setting('app.school_id')::uuid AND admission_number = 'ADM-2026-001')
  AND c.model = 'gpt-4o-mini'
  AND c.created_at = (
    SELECT MIN(c2.created_at)
    FROM app.ai_conversations c2
    WHERE c2.school_id = current_setting('app.school_id')::uuid
      AND c2.student_id = (SELECT id FROM app.students WHERE school_id = current_setting('app.school_id')::uuid AND admission_number = 'ADM-2026-001')
      AND c2.model = 'gpt-4o-mini'
  )
ON CONFLICT DO NOTHING;

-- Usage meters for all 5 students
INSERT INTO app.ai_usage_meters (school_id, student_id, ai_subscription_id, total_tokens)
SELECT
  current_setting('app.school_id')::uuid,
  s.id,
  ai_sub.id,
  500
FROM app.students s
JOIN app.ai_subscriptions ai_sub ON ai_sub.school_id = s.school_id AND ai_sub.student_id = s.id
WHERE s.school_id = current_setting('app.school_id')::uuid AND s.admission_number = 'ADM-2026-001'
ON CONFLICT (school_id, student_id, ai_subscription_id) DO NOTHING;

INSERT INTO app.ai_usage_meters (school_id, student_id, ai_subscription_id, total_tokens)
SELECT
  current_setting('app.school_id')::uuid,
  s.id,
  ai_sub.id,
  120
FROM app.students s
JOIN app.ai_subscriptions ai_sub ON ai_sub.school_id = s.school_id AND ai_sub.student_id = s.id
WHERE s.school_id = current_setting('app.school_id')::uuid AND s.admission_number = 'ADM-2026-002'
ON CONFLICT (school_id, student_id, ai_subscription_id) DO NOTHING;

INSERT INTO app.ai_usage_meters (school_id, student_id, ai_subscription_id, total_tokens)
SELECT
  current_setting('app.school_id')::uuid,
  s.id,
  ai_sub.id,
  0
FROM app.students s
JOIN app.ai_subscriptions ai_sub ON ai_sub.school_id = s.school_id AND ai_sub.student_id = s.id
WHERE s.school_id = current_setting('app.school_id')::uuid AND s.admission_number = 'ADM-2026-003'
ON CONFLICT (school_id, student_id, ai_subscription_id) DO NOTHING;

INSERT INTO app.ai_usage_meters (school_id, student_id, ai_subscription_id, total_tokens)
SELECT
  current_setting('app.school_id')::uuid,
  s.id,
  ai_sub.id,
  0
FROM app.students s
JOIN app.ai_subscriptions ai_sub ON ai_sub.school_id = s.school_id AND ai_sub.student_id = s.id
WHERE s.school_id = current_setting('app.school_id')::uuid AND s.admission_number = 'ADM-2026-004'
ON CONFLICT (school_id, student_id, ai_subscription_id) DO NOTHING;

INSERT INTO app.ai_usage_meters (school_id, student_id, ai_subscription_id, total_tokens)
SELECT
  current_setting('app.school_id')::uuid,
  s.id,
  ai_sub.id,
  0
FROM app.students s
JOIN app.ai_subscriptions ai_sub ON ai_sub.school_id = s.school_id AND ai_sub.student_id = s.id
WHERE s.school_id = current_setting('app.school_id')::uuid AND s.admission_number = 'ADM-2026-005'
ON CONFLICT (school_id, student_id, ai_subscription_id) DO NOTHING;
