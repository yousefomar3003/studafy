# Hybrid search and RAG storage

`app.material_chunks` (ST-047, migration `000019`) is the tenant-scoped retrieval corpus behind the AI
ingestion queue: the chunked text of a material, its embedding, and a generated `tsvector`. It supports
**hybrid retrieval** — pgvector cosine ANN fused with GIN-backed full-text search via Reciprocal Rank
Fusion — under forced Row-Level Security.

Measured on PostgreSQL **16.14** with pgvector **0.8.5** (`pgvector/pgvector:pg16`).

## Stated assumptions

- **The embedding model and dimension are chosen here for the first time.** Nothing in the repository
  declared either. `vector(1536)` matches OpenAI `text-embedding-3-small` / `ada-002`, per the ST-047
  ticket. `docs/database/extensions.md` requires an embedding table to "store the model identity +
  version and a consistent dimension", so `embedding_model` is a `NOT NULL` column, not an implicit
  convention.
- **The table is not partitioned**, though the ticket's title suggests it. Declarative partitioning gives
  each partition its **own independent HNSW graph**, so a global top-k would have to descend every one
  and merge — N traversals for a k obtainable from one, losing recall at each merge. An HNSW index wants
  to be one graph. The ticket explicitly permits this ("otherwise standard RLS").

## Normalization review

| Table                 | Primary key | Candidate keys                                                 | Foreign keys                                                                             |
| --------------------- | ----------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `app.material_chunks` | `id` (uuid) | `(id, school_id)`; **`(school_id, material_id, chunk_index)`** | `school_id → app.schools(id)`; `(material_id, school_id) → app.materials(id, school_id)` |

**1NF.** One chunk is one row. No CSV, no nested list, no array of chunks. `page_number` (`integer`) and
`section_title` (`text`) are typed, atomic anchors — they are what a citation renders from ("page 12,
'Photosynthesis'") — not an unparsed metadata string. **There is no `jsonb` column on this table at all.**

**2NF.** Every attribute depends on the whole key. The table holds a chunk's slice of text and the things
derived from it, and nothing else. `chunk_index` is a **structural ordering column, not a repeating
group**: it is what makes the chunk sequence reconstructible in order and what lets a retrieved chunk be
expanded with its neighbours (retrieve chunk 7, show 6–8 — the standard RAG context-window move). It is
part of the business key, not an attribute of it.

**3NF.** No transitive dependencies. There is no material title, storage key, mime type, file size,
uploader, class, or school name on this table. All of those depend on `material_id`, which is a foreign
key; copying them here would duplicate `app.materials` and go stale the moment a material is renamed. A
chunk reaches its document metadata through `material_id`.

**Tenant integrity is schema-level, not policy-level.** `fk_material_chunks_material` is composite —
`(material_id, school_id) → app.materials (id, school_id)` — so a chunk can never point at another
school's material. This holds where RLS does not run: for a superuser, for a `BYPASSRLS` role, inside a
`SECURITY DEFINER` function. RLS is a row filter; it is not a referential guarantee, and the two are not
substitutes.

**`ON DELETE CASCADE`** on that foreign key is the single place this schema departs from its otherwise
universal `RESTRICT`, and it is deliberate. A chunk is derived data with no independent existence. Under
`RESTRICT`, deleting a material would be impossible until every chunk had been purged by hand — and the
likely outcome is a purge that is forgotten, leaving embeddings of a deleted document still being
retrieved and quoted back to users. Cascading makes deletion mean deletion.

**`content_tsv` is `GENERATED ALWAYS AS (to_tsvector('english', content)) STORED`**, not a trigger. It
cannot drift from `content`, and it cannot be written to directly (`428C9`). The two-argument
`to_tsvector(regconfig, text)` is required: the one-argument form reads `default_text_search_config` and
is therefore only `STABLE`, and a generated column's expression must be `IMMUTABLE`.

## Embedding regeneration

`docs/database/extensions.md` requires this to be documented. `content` is the source of truth and is
retained in full; the embedding is **derived** and is never authoritative. A model change therefore
re-derives every vector from `content`:

1. Deploy the new model behind a new `embedding_model` value.
2. Re-embed in batches, `WHERE embedding_model <> '<new model>'`, updating `embedding` and
   `embedding_model` together in one statement.
3. Rebuild the HNSW index once at the end (see write amplification below).

**Never mix models in one table.** Cosine distance between vectors from two different models is a
well-formed number and a meaningless one, so the failure mode is silently worse results, not an error.
`embedding_model` is what makes a partial or failed re-embed detectable and answerable by a query.

## Indexes

```sql
CREATE INDEX idx_material_chunks_embedding_hnsw
  ON app.material_chunks USING hnsw (embedding public.vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX idx_material_chunks_content_tsv
  ON app.material_chunks USING gin (content_tsv);
```

**Zero redundancy.** The relational lookup path the ticket asks for —
`(school_id, material_id, chunk_index)` — is **already the btree built by the unique constraint
`uq_material_chunks_material_chunk`**. A separate `CREATE INDEX` on those columns would be a second
identical btree with doubled write cost. It is deliberately not created.

**HNSW, not IVFFlat.** `extensions.md` warns "never create a vector index on an empty table to satisfy a
task". That warning targets **IVFFlat**, which computes cluster centroids at build time and is genuinely
useless when built on an empty table. **HNSW builds incrementally** and is correct from empty. Against
that document's own decision framework: table `app.material_chunks`; column `embedding`; 1536 dimensions;
cosine (`<=>`, `vector_cosine_ops`) because OpenAI embeddings are trained for it; query pattern top-50 ANN
under a tenant filter, fused with FTS; recall target ~100% against exact; ~10^5–10^6 rows expected;
write-once-per-ingestion, read-per-question; latency budget 150 ms.

## The RLS + ANN hazard (the important part)

**An HNSW index returns the GLOBAL nearest neighbours. The RLS tenant predicate is applied as a FILTER to
those candidates — the graph traversal has no idea what a school is.** So an ANN query under RLS can
return _fewer rows than the `LIMIT` asked for_. It does not raise. It just quietly under-returns, and the
smaller a school's share of the corpus, the worse it gets.

Measured, 100,000 chunks, 4 tenants, acting school owns 25,000, `LIMIT 50`:

| Configuration                                                | rows returned | recall vs exact |
| ------------------------------------------------------------ | ------------- | --------------- |
| `iterative_scan = off` (**pgvector default**)                | **15**        | 15/50           |
| `iterative_scan = strict_order`                              | 50            | 22/50           |
| `iterative_scan = relaxed_order`, `ef_search = 40` (default) | 50            | 29/50           |
| **`iterative_scan = relaxed_order`, `ef_search = 100`**      | **50**        | **50/50**       |

Plan at the default, showing the failure directly:

```text
Limit (actual rows=15 loops=1)
  ->  Index Scan using idx_material_chunks_embedding_hnsw on material_chunks (actual rows=15 loops=1)
        Filter: (school_id = (current_setting('app.school_id'::text))::uuid)
        Rows Removed by Filter: 25
```

**This is compounded by Reciprocal Rank Fusion, which hides it.** RRF is a `FULL OUTER JOIN`, so a short —
or entirely empty — semantic leg still produces a full result set, carried by the keyword leg. A test that
checks only latency and result count will report a comfortable pass on a retrieval system whose vector
search has silently died. **The semantic leg must be asserted on its own terms**, and the benchmark does
exactly that before it measures anything.

### Required retrieval settings

```sql
SET LOCAL hnsw.iterative_scan = 'relaxed_order';
SET LOCAL hnsw.ef_search = 100;
```

`SET LOCAL`, not `SET`: the runtime is behind PgBouncer in transaction pooling mode, where a session-level
GUC leaks into the next request (`docs/runbooks/pgbouncer-conventions.md`).

### Production fallback

The application **must not assume** the semantic leg returned `k` rows:

- If it returns fewer than the requested minimum, **retry once with a bounded higher `ef_search`** (e.g.
  200; do not raise it without bound — at `ef_search = 400` measured recall _fell_ to 38/50 while latency
  rose by an order of magnitude).
- **Below roughly 50,000 chunks for a single tenant**, an exact tenant-scoped scan is the right answer and
  the planner already picks it (see below). It is exact, and it is inside budget.

### Two traps worth naming

- **The query vector must be a literal or a bound parameter.** Joining it from a table (`FROM query_vecs
q ... ORDER BY c.embedding <=> q.v`) makes the `ORDER BY` non-constant, pgvector cannot use the index,
  and you silently get a full exact scan.
- **A degenerate corpus destroys ANN silently.** During development, an _uncorrelated_ `LATERAL` in the
  seed (`CROSS JOIN LATERAL (SELECT array_agg(random()) ...)` with no reference to the outer row) was
  evaluated **once** by PostgreSQL and reused, producing one identical embedding for all 25,000 chunks of
  a tenant. The HNSW graph collapsed to four distinct points, every ANN query returned the single nearest
  tenant's duplicates, RLS filtered them all away for everyone else, and the semantic leg returned zero
  rows — while the benchmark still "passed" on latency. The benchmark now asserts corpus validity
  (distinct embeddings, non-zero distance spread) before it measures.

## Query plans, at 100,000 chunks

**ANN leg.** With the settings above and the acting school owning 25,000 rows, PostgreSQL chooses a
**parallel exact scan and a top-N sort**, not the HNSW graph:

```text
Limit (actual rows=50 loops=1)
  ->  Gather Merge (actual rows=50 loops=1)   Workers Launched: 2
        ->  Sort (actual rows=17 loops=3)   Sort Method: top-N heapsort
              ->  Parallel Seq Scan on material_chunks (actual rows=8333 loops=3)
                    Filter: (school_id = (current_setting('app.school_id'::text))::uuid)
                    Rows Removed by Filter: 25000
```

**This is the planner being right, not a defect.** The plan is _exact_ (100% recall) and inside the
latency budget. Scanning 25,000 × 1536 dimensions in parallel is genuinely cheaper than descending an HNSW
graph over 100,000 and then throwing three quarters of the candidates away. **HNSW earns its place once a
single tenant's own corpus is large enough that the exact scan costs more than a graph descent** — it is
selected at `ef_search = 40` on this same corpus, and it is what keeps the table viable as tenants grow.
The index is not dead weight; it is insurance that is not yet being claimed.

> Honest scope note: the ST-047 ticket asks to "verify that the planner resolves to an `Index Scan` using
> the HNSW index rather than a sequential scan". **At this corpus shape it does not, and forcing it would
> mean choosing an approximate plan over an exact one that is already fast enough.** The requirement is
> recorded as not met, rather than satisfied by disabling `enable_seqscan` and calling it evidence.

**Keyword leg.** Also index-backed, but via the tenant btree rather than GIN:

```text
Limit (actual rows=25 loops=1)
  ->  Bitmap Heap Scan on material_chunks (actual rows=25 loops=1)
        Filter: (content_tsv @@ '''thylakoid'' & ''membran'''::tsquery)
        ->  Bitmap Index Scan on uq_material_chunks_material_chunk (actual rows=25000 loops=1)
              Index Cond: (school_id = (current_setting('app.school_id'::text))::uuid)
```

Same reasoning: the RLS predicate is always present, the tenant btree can satisfy it, and with the school
owning a quarter of the corpus the planner prefers to bitmap that and filter. The GIN index is chosen as
the keyword predicate becomes selective relative to the tenant's slice.

## The RRF hybrid query

```sql
BEGIN;
SET LOCAL ROLE studafy_app;
SELECT set_config('app.school_id', $school, true);
SET LOCAL hnsw.iterative_scan = 'relaxed_order';
SET LOCAL hnsw.ef_search = 100;

WITH semantic AS (
  SELECT id, row_number() OVER (ORDER BY embedding <=> $vector) AS rank
  FROM app.material_chunks
  ORDER BY embedding <=> $vector
  LIMIT 50
), keyword AS (
  SELECT c.id, row_number() OVER (ORDER BY ts_rank(c.content_tsv, q.query) DESC) AS rank
  FROM app.material_chunks c,
       websearch_to_tsquery('english', $phrase) AS q(query)
  WHERE c.content_tsv @@ q.query
  ORDER BY ts_rank(c.content_tsv, q.query) DESC
  LIMIT 50
)
SELECT COALESCE(s.id, k.id) AS id,
       COALESCE(1.0 / (60 + s.rank), 0) + COALESCE(1.0 / (60 + k.rank), 0) AS rrf_score
FROM semantic s
FULL OUTER JOIN keyword k ON k.id = s.id
ORDER BY rrf_score DESC
LIMIT 10;
COMMIT;
```

`k = 60` is the constant from the original RRF paper. Both legs are RLS-filtered independently, so the
fused result cannot contain another school's chunk — asserted in `packages/db/tests/material-chunks.test.ts`.

## Write amplification

Ingestion pays for the ANN index on every row. Measured, 2,000-row batch:

|                                    | elapsed   |
| ---------------------------------- | --------- |
| INSERT with the HNSW index live    | 4,470 ms  |
| INSERT with the HNSW index dropped | 529 ms    |
| **Amplification**                  | **×8.45** |

So a bulk ingestion should **drop the HNSW index, load, and rebuild**. Building the graph once over
100,000 loaded rows took **540 s** on the development container (`maintenance_work_mem = 256MB`,
`max_parallel_maintenance_workers = 2`); seeding those rows took 48 s. Raising `maintenance_work_mem`
speeds the build, but each parallel worker takes its own allocation — asking for too much gets a backend
OOM-killed and takes the postmaster with it.

The HNSW build also needs shared memory for its parallel workers. Docker's default 64 MB `/dev/shm` is not
enough (`could not resize shared memory segment ... No space left on device`); `db/compose.yml` sets
`shm_size: 1gb`.

## Benchmark

`packages/db/tests/material-chunks-benchmark.test.ts`, gated on `MATERIAL_CHUNKS_BENCHMARK=1`.

100,000 chunks across 4 tenants; the measured school owns 25,000; top-50 per leg; 5 warmup + 30 measured
iterations; forced RLS on both legs; a validity guard on the corpus and a non-empty, tenant-pure guard on
the semantic leg **before** any timing is taken.

**Result: the acceptance gate is met.** Both the end-to-end median and the server-side mean
(`pg_stat_statements`) for the RRF hybrid query are **under the 150 ms target**, with the semantic leg
returning a full 50 rows, all of them the acting school's.

```
docker compose -f db/compose.yml up -d --wait
MATERIAL_CHUNKS_BENCHMARK=1 TEST_DATABASE_URL=postgresql://… \
  bun test tests/material-chunks-benchmark.test.ts   # in packages/db
```

## Known gaps

- **No application writer or retrieval API yet.** This ticket delivers the storage model; the
  `ai-ingestion` queue processor is still a placeholder.
- **HNSW is not the chosen plan at current tenant sizes** (see above). It is correct, exact, and fast
  without it; the index exists for the growth case.
- **The `ef_search = 400` result (recall 38/50, ~4 s) is not understood** and is recorded as an anomaly.
  Do not raise `ef_search` without measuring recall — higher is not monotonically better.
- **No reranker.** RRF fuses ranks; it does not re-score. A cross-encoder rerank on the fused top-k is the
  obvious next quality step.
