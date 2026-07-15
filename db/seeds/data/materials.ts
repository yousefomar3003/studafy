// Educational materials and their retrieval corpus. Two materials are attached to the Science class;
// the ingested one is chunked into app.material_chunks with deterministic 1536-dim embeddings and the
// page/section anchors a citation is rendered from. storage_key must match
// ^permanent/<school_id>/<x>/<y>$ (migration 000011). Returns the chunk ids so the AI module can cite
// real chunks.
import { deterministicEmbedding, seedDate, uuid } from "../support";

import type { FullCtx, MaterialsCtx, Sql } from "../support";

const EMBEDDING_MODEL = "mock-embedding-3-small";

const CHUNKS: readonly { content: string; page: number; section: string }[] = [
  {
    content: "Photosynthesis converts light energy into chemical energy stored in glucose.",
    page: 1,
    section: "Overview",
  },
  {
    content: "Chlorophyll in the chloroplasts absorbs mostly red and blue light.",
    page: 2,
    section: "Light Absorption",
  },
  {
    content: "The light-dependent reactions occur in the thylakoid membranes.",
    page: 3,
    section: "Light Reactions",
  },
  {
    content: "The Calvin cycle fixes carbon dioxide into three-carbon sugars.",
    page: 4,
    section: "Calvin Cycle",
  },
  {
    content: "Water is split during photolysis, releasing oxygen as a by-product.",
    page: 5,
    section: "Photolysis",
  },
  {
    content: "Net productivity depends on light intensity, temperature, and CO2 concentration.",
    page: 6,
    section: "Limiting Factors",
  },
];

export async function seedMaterials(sql: Sql, ctx: FullCtx): Promise<MaterialsCtx> {
  const { schoolId, classes, teachers } = ctx;
  const scienceClass = classes[0]!;
  const teacher = teachers.find((t) => t.key === "instructor-science")!;

  const ingestedMaterialId = uuid();
  const pendingMaterialId = uuid();
  await sql`
    INSERT INTO app.materials ${sql(
      [
        {
          id: ingestedMaterialId,
          school_id: schoolId,
          class_id: scienceClass.id,
          uploaded_by_user_id: teacher.userId,
          last_edited_by_user_id: teacher.userId,
          title: "Photosynthesis Study Guide",
          description: "Reference notes used by the AI tutor.",
          storage_key: `permanent/${schoolId}/materials/photosynthesis-study-guide.pdf`,
          original_file_name: "photosynthesis-study-guide.pdf",
          mime_type: "application/pdf",
          size_bytes: 482_318,
          checksum_sha256: null,
          ai_visible: true,
          ingest_status: "ready",
          ingest_error: null,
          ingested_at: seedDate(-4),
        },
        {
          id: pendingMaterialId,
          school_id: schoolId,
          class_id: scienceClass.id,
          uploaded_by_user_id: teacher.userId,
          last_edited_by_user_id: teacher.userId,
          title: "Cell Biology Slides",
          description: "Awaiting ingestion.",
          storage_key: `permanent/${schoolId}/materials/cell-biology-slides.pdf`,
          original_file_name: "cell-biology-slides.pdf",
          mime_type: "application/pdf",
          size_bytes: 1_204_990,
          checksum_sha256: null,
          ai_visible: false,
          ingest_status: "uploaded",
          ingest_error: null,
          ingested_at: null,
        },
      ],
      "id",
      "school_id",
      "class_id",
      "uploaded_by_user_id",
      "last_edited_by_user_id",
      "title",
      "description",
      "storage_key",
      "original_file_name",
      "mime_type",
      "size_bytes",
      "checksum_sha256",
      "ai_visible",
      "ingest_status",
      "ingest_error",
      "ingested_at",
    )}
  `;

  const chunkIds = CHUNKS.map(() => uuid());
  await sql`
    INSERT INTO app.material_chunks ${sql(
      CHUNKS.map((chunk, index) => ({
        id: chunkIds[index]!,
        school_id: schoolId,
        material_id: ingestedMaterialId,
        chunk_index: index,
        content: chunk.content,
        page_number: chunk.page,
        section_title: chunk.section,
        embedding: deterministicEmbedding(index + 1),
        embedding_model: EMBEDDING_MODEL,
      })),
      "id",
      "school_id",
      "material_id",
      "chunk_index",
      "content",
      "page_number",
      "section_title",
      "embedding",
      "embedding_model",
    )}
  `;

  return { chunkIds };
}
