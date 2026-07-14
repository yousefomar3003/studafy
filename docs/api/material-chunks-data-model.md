# Material chunk data model

`app.material_chunks` is the school-owned retrieval corpus for AI search: the chunked text of a material,
its embedding, and a generated full-text vector. The SQL rationale — the normalization review, the index
decisions, the RLS + ANN hazard and its required settings, the RRF query, write amplification, and the
benchmark — is in [hybrid-search-and-rag-storage](../rag/hybrid-search-and-rag-storage.md).

```mermaid
erDiagram
  SCHOOLS ||--o{ MATERIALS : "owns"
  SCHOOLS ||--o{ MATERIAL_CHUNKS : "owns"
  MATERIALS ||--o{ MATERIAL_CHUNKS : "is chunked into (cascade on delete)"

  SCHOOLS {
    uuid id PK
    text slug UK
  }
  MATERIALS {
    uuid id PK_UK
    uuid school_id FK_UK
    uuid class_id FK
    text title
    text storage_key UK
    text mime_type
    boolean ai_visible
    material_ingest_status ingest_status
  }
  MATERIAL_CHUNKS {
    uuid id PK_UK
    uuid school_id FK_UK
    uuid material_id FK_UK
    integer chunk_index UK
    text content
    integer page_number "nullable"
    text section_title "nullable"
    vector embedding "vector(1536)"
    text embedding_model
    tsvector content_tsv "GENERATED ALWAYS STORED"
    timestamptz created_at
    timestamptz updated_at
  }
```

## Reading the diagram

**The business key is `(school_id, material_id, chunk_index)`** — a material has exactly one chunk at each
ordinal. That unique constraint is _also_ the relational lookup index; no separate index on those columns
is created, because it would be a duplicate btree.

**`chunk_index` is structural, not an attribute.** It orders the chunk sequence, and it is what lets a
retrieved chunk be expanded with its neighbours (retrieve 7, show 6–8).

**The material reference is composite** — `(material_id, school_id) → app.materials (id, school_id)` — so a
chunk can never point at another school's material. That is a schema guarantee and holds even where RLS
does not run. It is the one foreign key in this schema with `ON DELETE CASCADE`: a chunk is derived data
with no independent existence, and an embedding of a deleted document must not survive to be retrieved
and quoted back to a user.

**`content_tsv` is generated, never written.** `GENERATED ALWAYS AS (to_tsvector('english', content))
STORED`, so it cannot drift from `content` and a direct write to it is refused (`428C9`).

**There is no `jsonb` on this table.** `page_number` and `section_title` are typed atomic columns — they
are what a citation renders from — not an unparsed metadata blob.

**No material metadata is copied here.** No title, storage key, mime type, uploader, or class. Those
depend on `material_id`, which is a foreign key.

## Access rules

| Role            | Privileges on `app.material_chunks`    |
| --------------- | -------------------------------------- |
| `studafy_app`   | `SELECT`, `INSERT`, `UPDATE`, `DELETE` |
| `studafy_admin` | owner                                  |
| `PUBLIC`        | none                                   |

Tenant isolation is the canonical ST-034 policy on `school_id`, **enabled and forced**. It covers the
vector and full-text paths for free: RLS filters the rows a query returns regardless of which index
produced them, so an `<=>` ordering and an `@@` match are filtered exactly like a `SELECT *`.

## Retrieval

**Two settings are mandatory, and they are correctness requirements rather than tuning knobs:**

```sql
SET LOCAL hnsw.iterative_scan = 'relaxed_order';
SET LOCAL hnsw.ef_search = 100;
```

An HNSW index returns the _global_ nearest neighbours and RLS filters them afterwards, so with pgvector's
defaults a tenant-scoped ANN query **silently returns fewer rows than the `LIMIT` asked for** (measured:
15 of 50). Reciprocal Rank Fusion then hides the shortfall behind the keyword leg. The caller must assert
the semantic leg returned what it asked for. See
[the hazard section](../rag/hybrid-search-and-rag-storage.md#the-rls--ann-hazard-the-important-part).

The query vector must be a **literal or bound parameter** — joining it from a table silently disables the
index and forces an exact scan.
