-- Seed educational materials with RAG-ready chunks.
-- Depends on: 006 (classes), 003 (users for uploaded_by).
-- storage_key must match: ^permanent/<school_id>/[^/]+/[^/]+$

SET LOCAL ROLE studafy_admin;

-- Materials (one per class for the first 4 classes)
INSERT INTO app.materials (school_id, class_id, uploaded_by_user_id, last_edited_by_user_id, title, description, storage_key, original_file_name, mime_type, size_bytes, ai_visible, ingest_status, ingested_at)
SELECT
  current_setting('app.school_id')::uuid,
  cl.id,
  u.id,
  u.id,
  'Algebra Fundamentals',
  'Core algebra concepts, equations, and problem-solving techniques',
  'permanent/' || current_setting('app.school_id') || '/math/algebra-fundamentals.pdf',
  'algebra-fundamentals.pdf',
  'application/pdf',
  2457600,
  true,
  'ready',
  CURRENT_TIMESTAMP
FROM app.classes cl
CROSS JOIN app.users u
WHERE cl.school_id = current_setting('app.school_id')::uuid AND cl.code = 'CLASS-MATH-101-SP26'
  AND u.school_id = current_setting('app.school_id')::uuid AND u.normalized_email = 'teacher.math@demo-academy.local'
ON CONFLICT (storage_key) DO NOTHING;

INSERT INTO app.materials (school_id, class_id, uploaded_by_user_id, last_edited_by_user_id, title, description, storage_key, original_file_name, mime_type, size_bytes, ai_visible, ingest_status, ingested_at)
SELECT
  current_setting('app.school_id')::uuid,
  cl.id,
  u.id,
  u.id,
  'Biology Lab Manual',
  'Laboratory procedures, safety guidelines, and experiment worksheets',
  'permanent/' || current_setting('app.school_id') || '/sci/biology-lab-manual.pdf',
  'biology-lab-manual.pdf',
  'application/pdf',
  3145728,
  true,
  'ready',
  CURRENT_TIMESTAMP
FROM app.classes cl
CROSS JOIN app.users u
WHERE cl.school_id = current_setting('app.school_id')::uuid AND cl.code = 'CLASS-SCI-201-SP26'
  AND u.school_id = current_setting('app.school_id')::uuid AND u.normalized_email = 'teacher.science@demo-academy.local'
ON CONFLICT (storage_key) DO NOTHING;

INSERT INTO app.materials (school_id, class_id, uploaded_by_user_id, last_edited_by_user_id, title, description, storage_key, original_file_name, mime_type, size_bytes, ai_visible, ingest_status, ingested_at)
SELECT
  current_setting('app.school_id')::uuid,
  cl.id,
  u.id,
  u.id,
  'Writing Guide',
  'Essay structure, citation formats, and grammar reference',
  'permanent/' || current_setting('app.school_id') || '/eng/writing-guide.pdf',
  'writing-guide.pdf',
  'application/pdf',
  1048576,
  true,
  'ready',
  CURRENT_TIMESTAMP
FROM app.classes cl
CROSS JOIN app.users u
WHERE cl.school_id = current_setting('app.school_id')::uuid AND cl.code = 'CLASS-ENG-101-SP26'
  AND u.school_id = current_setting('app.school_id')::uuid AND u.normalized_email = 'teacher.english@demo-academy.local'
ON CONFLICT (storage_key) DO NOTHING;

INSERT INTO app.materials (school_id, class_id, uploaded_by_user_id, last_edited_by_user_id, title, description, storage_key, original_file_name, mime_type, size_bytes, ai_visible, ingest_status, ingested_at)
SELECT
  current_setting('app.school_id')::uuid,
  cl.id,
  u.id,
  u.id,
  'World History Timeline',
  'Key historical events from ancient civilizations to modern era',
  'permanent/' || current_setting('app.school_id') || '/hist/world-history-timeline.pdf',
  'world-history-timeline.pdf',
  'application/pdf',
  5242880,
  true,
  'ready',
  CURRENT_TIMESTAMP
FROM app.classes cl
CROSS JOIN app.users u
WHERE cl.school_id = current_setting('app.school_id')::uuid AND cl.code = 'CLASS-HIST-101-SP26'
  AND u.school_id = current_setting('app.school_id')::uuid AND u.normalized_email = 'ta.history@demo-academy.local'
ON CONFLICT (storage_key) DO NOTHING;

-- Material chunks for RAG (2-3 chunks per material)
INSERT INTO app.material_chunks (school_id, material_id, chunk_index, content, embedding, embedding_model)
SELECT
  current_setting('app.school_id')::uuid,
  m.id,
  0,
  'Algebra is the study of mathematical symbols and the rules for manipulating these symbols. It is a unifying thread of almost all of mathematics. Elementary algebra differs from arithmetic in the use of abstractions, such as using letters to stand for numbers that are either unknown or allowed to take on many values.',
  array_fill(0.1::real, ARRAY[1536])::public.vector,
  'text-embedding-3-small'
FROM app.materials m
WHERE m.school_id = current_setting('app.school_id')::uuid
  AND m.storage_key = 'permanent/' || current_setting('app.school_id') || '/math/algebra-fundamentals.pdf'
ON CONFLICT DO NOTHING;

INSERT INTO app.material_chunks (school_id, material_id, chunk_index, content, embedding, embedding_model)
SELECT
  current_setting('app.school_id')::uuid,
  m.id,
  1,
  'A polynomial is an expression consisting of variables and coefficients, that involves only the operations of addition, subtraction, multiplication, and non-negative integer exponents. Polynomials appear in many areas of mathematics and science.',
  array_fill(0.2::real, ARRAY[1536])::public.vector,
  'text-embedding-3-small'
FROM app.materials m
WHERE m.school_id = current_setting('app.school_id')::uuid
  AND m.storage_key = 'permanent/' || current_setting('app.school_id') || '/math/algebra-fundamentals.pdf'
ON CONFLICT DO NOTHING;

INSERT INTO app.material_chunks (school_id, material_id, chunk_index, content, embedding, embedding_model)
SELECT
  current_setting('app.school_id')::uuid,
  m.id,
  0,
  'Biology is the scientific study of life and living organisms. It examines the structure, function, growth, origin, evolution, and distribution of living things. Biology covers a wide range of topics from molecular biology to ecology.',
  array_fill(0.3::real, ARRAY[1536])::public.vector,
  'text-embedding-3-small'
FROM app.materials m
WHERE m.school_id = current_setting('app.school_id')::uuid
  AND m.storage_key = 'permanent/' || current_setting('app.school_id') || '/sci/biology-lab-manual.pdf'
ON CONFLICT DO NOTHING;

INSERT INTO app.material_chunks (school_id, material_id, chunk_index, content, embedding, embedding_model)
SELECT
  current_setting('app.school_id')::uuid,
  m.id,
  0,
  'Good writing begins with clear organization. An essay typically consists of an introduction that presents the thesis, body paragraphs that support it with evidence and analysis, and a conclusion that synthesizes the argument.',
  array_fill(0.4::real, ARRAY[1536])::public.vector,
  'text-embedding-3-small'
FROM app.materials m
WHERE m.school_id = current_setting('app.school_id')::uuid
  AND m.storage_key = 'permanent/' || current_setting('app.school_id') || '/eng/writing-guide.pdf'
ON CONFLICT DO NOTHING;
