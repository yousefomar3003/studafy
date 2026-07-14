-- Creates app.material_chunks: the school-owned store for chunked material text, its embeddings, and a
-- generated full-text vector. This is the retrieval corpus behind the AI ingestion queue
-- (packages/constants/src/queues.ts -> AI_INGESTION), whose processor is still a placeholder: ST-039
-- gave app.materials an ai_visible flag and an ingest lifecycle but deliberately left the output
-- homeless -- docs/database/assessment-content.md records that "chunks, embeddings, extracted bodies,
-- and model output are out of scope" and require a separate normalized model. This is that model.
-- The full design note is docs/rag/hybrid-search-and-rag-storage.md.
--
-- The table supports HYBRID retrieval: an approximate nearest-neighbour leg over pgvector cosine
-- distance, and a lexical leg over a GIN-indexed tsvector, fused with Reciprocal Rank Fusion in SQL.
-- The two legs fail in different directions -- embeddings miss exact identifiers, rare proper nouns, and
-- negation; keyword search misses paraphrase -- so a corpus that only supports one of them is
-- structurally worse at recall than one that supports both. Both legs are RLS-filtered independently,
-- so a fused result cannot contain another school's chunk.
--
-- STATED ASSUMPTION ON THE EMBEDDING MODEL. The repository declares no embedding model and no dimension
-- anywhere: this migration is the first place either is chosen. vector(1536) is the ST-047 ticket's
-- requirement and matches OpenAI's text-embedding-3-small / ada-002 output. Per the standing pgvector
-- policy in docs/database/extensions.md ("a future embedding table must ... store the model identity +
-- version and a consistent dimension"), embedding_model is stored alongside every row rather than being
-- left implicit. See the regeneration procedure in the design note.
--
-- WHY THIS TABLE IS NOT PARTITIONED. Every other high-volume table here is (attendance, 000012; audit
-- logs, 000018), so the omission is deliberate. Declarative partitioning would give EACH partition its
-- own independent HNSW graph, and a global top-k ANN query would have to descend every one of them and
-- merge the results -- paying N graph traversals for a k it could have got from one, and losing recall
-- at every merge boundary. An HNSW index wants to be one graph. Tenant scoping is achieved by RLS and by
-- the school-leading key below, not by physical separation.
--
-- Normalization: this table holds a chunk's slice of text and nothing else. No material title, no
-- storage key, no mime type, no uploader, no class, no school name. Those are attributes of the
-- material, they live on app.materials, and copying them here would be a transitive dependency that
-- silently goes stale the moment a material is renamed. A chunk is reached through material_id.

SET ROLE studafy_admin;

-- One chunk: one contiguous slice of one material's extracted text, with its embedding.
--
-- chunk_index is the chunk's ordinal within its material, and it is a structural column, not a repeating
-- group: it is what makes the chunk sequence reconstructible in order, and what lets a retrieved chunk be
-- expanded with its neighbours (the standard RAG "context window" move -- retrieve chunk 7, show 6..8).
-- It is part of the business key, not an attribute.
--
-- page_number and section_title are typed, atomic columns rather than an unparsed metadata blob. They are
-- the anchors a citation is rendered from ("page 12, 'Photosynthesis'"), and an unindexable JSON string
-- would make that a parsing problem at read time. There is deliberately no jsonb column on this table.
--
-- content is the normalized source text, retained in full. The embedding is DERIVED data and is never the
-- source of truth: a model change re-derives every embedding from content, so content must survive
-- independently of any model. content_tsv is likewise derived, but by the database rather than by an
-- application -- see below.
CREATE TABLE app.material_chunks (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_material_chunks PRIMARY KEY,
  school_id uuid NOT NULL,
  material_id uuid NOT NULL,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  page_number integer,
  section_title text,
  embedding public.vector(1536) NOT NULL,
  embedding_model text NOT NULL,
  -- GENERATED ... STORED, not a trigger. The tsvector cannot drift from content, because PostgreSQL
  -- recomputes it on every write of content and refuses any direct write to it. A trigger-maintained
  -- column can be bypassed (a trigger can be disabled, and an ALTER TABLE ... DISABLE TRIGGER is not
  -- loud); a generated column cannot.
  --
  -- The two-argument to_tsvector(regconfig, text) is required: the one-argument form reads
  -- default_text_search_config and is therefore only STABLE, and a generated column's expression must be
  -- IMMUTABLE. Naming 'english' explicitly also means the stored tokens do not depend on a server
  -- setting that could differ between the local container and RDS.
  content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- The house tenant-checked identity, so a future child table can reference a chunk without being able
  -- to cross a school boundary.
  CONSTRAINT uq_material_chunks_id_school UNIQUE (id, school_id),
  -- The real business key: a material has exactly one chunk at each ordinal. This constraint is ALSO the
  -- relational lookup index -- (school_id, material_id, chunk_index) is precisely the composite the
  -- access path needs, school_id leading -- so no separate CREATE INDEX is issued for it. Declaring one
  -- would build a second identical btree. See the index rationale in the design note.
  CONSTRAINT uq_material_chunks_material_chunk UNIQUE (school_id, material_id, chunk_index),

  CONSTRAINT fk_material_chunks_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Composite, so a chunk can never point at another school's material. This is a SCHEMA-level guarantee
  -- and it holds even where RLS does not run -- for a superuser, for a role with BYPASSRLS, and inside a
  -- SECURITY DEFINER function. RLS is a row filter, not a referential guarantee, and the two are not
  -- substitutes for one another.
  --
  -- ON DELETE CASCADE is the single place this schema departs from its otherwise universal RESTRICT, and
  -- it is deliberate. A chunk is derived data with no independent existence or meaning: it is a slice of
  -- a material, and a material with no rows in app.materials is not a thing a chunk can be a slice of.
  -- Under RESTRICT, deleting a material would be impossible until every chunk had been purged by hand,
  -- and the likely outcome is a purge that is forgotten -- leaving embeddings of a deleted document
  -- still being retrieved and quoted back to users. Cascading is the behaviour that makes deletion
  -- mean deletion.
  CONSTRAINT fk_material_chunks_material FOREIGN KEY (material_id, school_id)
    REFERENCES app.materials (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,

  CONSTRAINT ck_material_chunks_chunk_index CHECK (chunk_index >= 0),
  CONSTRAINT ck_material_chunks_content CHECK (content = btrim(content) AND content <> ''),
  CONSTRAINT ck_material_chunks_page_number CHECK (page_number IS NULL OR page_number > 0),
  CONSTRAINT ck_material_chunks_section_title CHECK (
    section_title IS NULL OR (section_title = btrim(section_title) AND section_title <> '')
  ),
  -- Mixing embedding models in one table is a silent recall bug, not a type error: cosine distance
  -- between vectors produced by two different models is a well-formed number and a meaningless one, so
  -- the failure is bad results rather than an exception. Recording the model per row makes a model change
  -- detectable, makes a partial re-embed detectable, and makes the "which rows still need regenerating"
  -- query answerable. The dimension itself is enforced by the vector(1536) type.
  CONSTRAINT ck_material_chunks_embedding_model CHECK (
    embedding_model = btrim(embedding_model) AND embedding_model <> ''
  ),
  CONSTRAINT ck_material_chunks_timestamps CHECK (updated_at >= created_at)
);

-- The ANN index. Cosine (vector_cosine_ops, the <=> operator) because OpenAI embeddings are trained for
-- cosine similarity; L2 on un-normalized vectors of this family ranks differently and worse.
--
-- HNSW rather than IVFFlat. docs/database/extensions.md warns "never create a vector index on an empty
-- table to satisfy a task", and that warning is aimed squarely at IVFFlat, which computes its cluster
-- centroids AT BUILD TIME and is therefore genuinely useless when built on an empty or unrepresentative
-- table. HNSW has no such dependency: it builds its graph incrementally as rows arrive, so an index
-- created here, before ingestion, is correct and stays correct. The same document's decision framework is
-- answered in full in the design note (table, column, dimension, operator, query pattern, recall target,
-- expected rows, write frequency, latency target) -- this is not a speculative index.
--
-- m = 16 and ef_construction = 64 are the ticket's parameters and pgvector's defaults for m. They are a
-- deliberate middle: raising them buys recall at the cost of build time and index size, and the measured
-- build cost is recorded in the design note rather than guessed at.
CREATE INDEX idx_material_chunks_embedding_hnsw
  ON app.material_chunks USING hnsw (embedding public.vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- The lexical index, over the generated column. GIN rather than GiST: GIN is slower to update and larger,
-- but substantially faster to search, and this corpus is written once per ingestion and read on every
-- question -- which is exactly the trade GIN is for.
CREATE INDEX idx_material_chunks_content_tsv
  ON app.material_chunks USING gin (content_tsv);

-- No further index is created. In particular there is NO
--   CREATE INDEX ... ON app.material_chunks (school_id, material_id, chunk_index)
-- because uq_material_chunks_material_chunk above already maintains exactly that btree. A second one
-- would be a redundant copy: same columns, same order, same leading school_id, doubled write cost.

REVOKE ALL PRIVILEGES ON TABLE app.material_chunks FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.material_chunks TO studafy_app;

-- The canonical ST-034 tenant policy: ENABLE + FORCE row level security, and one permissive policy whose
-- USING and WITH CHECK are both school_id = current_setting('app.school_id')::uuid. It covers the vector
-- and full-text access paths for free, because RLS is applied to the rows a query returns regardless of
-- which index produced them -- an <=> ordering and an @@ match are filtered exactly like a SELECT *.
--
-- One consequence is load-bearing enough to state here, because it is easy to get silently wrong and it
-- is not an error when you do: an HNSW index returns the global nearest neighbours, and the RLS predicate
-- is applied as a FILTER to those candidates -- the graph traversal has no idea what a school is. So
-- `ORDER BY embedding <=> $1 LIMIT 10` can return fewer than 10 rows, because the k the index found were
-- mostly other tenants' and got discarded. It does not raise; it just quietly under-returns, and the
-- smaller a school's share of the corpus, the worse it gets.
--
-- The fix, and the reason it is safe to run one HNSW graph across all tenants: pgvector 0.8's iterative
-- scans. A retrieval query must set
--     SET LOCAL hnsw.iterative_scan = 'relaxed_order';
-- which makes the scan keep pulling candidates from the graph until the LIMIT is genuinely satisfied
-- after filtering. SET LOCAL, not SET: the runtime is behind PgBouncer in transaction pooling mode, where
-- a session-level GUC leaks into the next request (docs/runbooks/pgbouncer-conventions.md). The
-- integration tests assert the under-return failure directly, so a regression here surfaces as a failing
-- test rather than as quietly worse answers.
SELECT app.apply_tenant_isolation('app', 'material_chunks');

RESET ROLE;
