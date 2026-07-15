# AI conversations, messages, citations, and usage

`app.ai_conversations`, `app.ai_messages`, `app.ai_message_citations`, and `app.ai_usage_meters` are
school-owned tables protected by enabled and forced RLS. Every table has a non-null `school_id`, a
direct foreign key to `app.schools(id)`, and a school-leading B-tree.

## Normalized citations

Migration `000022_normalize_ai_message_citations.sql` replaces the historical
`ai_messages.cited_chunk_ids uuid[]` column with an ordered junction:

| Column              | Meaning                                                        |
| ------------------- | -------------------------------------------------------------- |
| `school_id`         | Tenant key and direct school foreign key                       |
| `ai_message_id`     | Composite reference to the cited answer's message              |
| `material_chunk_id` | Composite reference to a chunk in the same school              |
| `citation_order`    | One-based position in the answer; duplicate chunks are allowed |

The primary key is `(school_id, ai_message_id, citation_order)`. Deleting a message or material
chunk cascades its citation rows. Deleting a chunk does not delete or rewrite the answer.

The migration backfills only chunk IDs that still exist in the message's school. Stale and
cross-school array values are omitted and counted in a migration `NOTICE`; valid positions are not
renumbered, so gaps document removed historical references. New writes insert the message and its
ordered citation rows in the same application transaction.

## Tenant integrity

Relationships between tenant tables always include `school_id` on both sides. RLS controls which
rows a runtime role can see, while the composite foreign keys make cross-school message, chunk,
student, conversation, and subscription relationships physically impossible even when RLS is
bypassed by an administrative connection.

`app.delete_expired_ai_messages()` continues to delete messages in bounded batches; the normalized
citations disappear through the message foreign key's `ON DELETE CASCADE` action.
