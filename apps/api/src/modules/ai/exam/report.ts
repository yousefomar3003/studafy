import { AI_EXAM_WEAK_TOPIC_THRESHOLD } from "@studafy/constants";

import type { TransactionSql } from "postgres";

/**
 * Per-topic weakness report (ST-171): "scoring report maps weaknesses to materials with cited study
 * references."
 *
 * No report is denormalized/persisted -- consistent with the codebase's stated normalization rule
 * (`quiz_questions`' migration: "a citation is rendered by joining back to `app.material_chunks` /
 * `app.materials` at read time"). This computes it fresh from `app.exam_item_answers`, which is the
 * one thing submit actually persists, every time it is asked for: once by the submit route to build
 * its response, and again by any later `GET` of a `submitted` session -- both call this, so the two
 * can never drift apart.
 *
 * "Topic" is the material an item was grounded on: coarser than the chunk (a section within a
 * material is not a stable, nameable unit the way a whole material is) and finer than "the exam"
 * (which would not tell a student where to go re-study).
 */

export interface TopicStudyReference {
  chunkId: string;
  pageNumber: number | null;
  sectionTitle: string | null;
}

export interface ExamTopicReport {
  materialId: string;
  materialTitle: string | null;
  correct: number;
  total: number;
  /** Rounded to the nearest whole percent. */
  percentage: number;
  /** True at or below `AI_EXAM_WEAK_TOPIC_THRESHOLD`. */
  weak: boolean;
  /** Citations of this topic's incorrect items only -- what to go re-read, not everything asked. */
  studyReferences: TopicStudyReference[];
}

export interface ExamReport {
  correctCount: number;
  totalItems: number;
  /** Rounded to the nearest whole percent; 0 for an exam with no items. */
  percentage: number;
  topics: ExamTopicReport[];
}

export async function loadExamReport(
  tx: TransactionSql,
  input: { examSessionId: string; schoolId: string },
): Promise<ExamReport> {
  const rows = await tx<
    {
      material_id: string;
      material_title: string | null;
      is_correct: boolean;
      chunk_id: string;
      page_number: number | null;
      section_title: string | null;
    }[]
  >`
    SELECT
      m.id AS material_id, m.title AS material_title, eia.is_correct,
      mc.id AS chunk_id, mc.page_number, mc.section_title
    FROM app.exam_items ei
    JOIN app.exam_item_answers eia
      ON eia.exam_item_id = ei.id AND eia.school_id = ei.school_id
    JOIN app.material_chunks mc ON mc.id = ei.material_chunk_id
    JOIN app.materials m ON m.id = mc.material_id
    WHERE ei.exam_session_id = ${input.examSessionId}::uuid AND ei.school_id = ${input.schoolId}::uuid
    ORDER BY m.title, ei.item_order ASC
  `;

  interface TopicAccumulator {
    materialId: string;
    materialTitle: string | null;
    correct: number;
    total: number;
    studyReferences: Map<string, TopicStudyReference>;
  }

  const topics = new Map<string, TopicAccumulator>();
  for (const row of rows) {
    let topic = topics.get(row.material_id);
    if (!topic) {
      topic = {
        materialId: row.material_id,
        materialTitle: row.material_title,
        correct: 0,
        total: 0,
        studyReferences: new Map(),
      };
      topics.set(row.material_id, topic);
    }
    topic.total += 1;
    if (row.is_correct) {
      topic.correct += 1;
    } else if (!topic.studyReferences.has(row.chunk_id)) {
      topic.studyReferences.set(row.chunk_id, {
        chunkId: row.chunk_id,
        pageNumber: row.page_number,
        sectionTitle: row.section_title,
      });
    }
  }

  const topicReports: ExamTopicReport[] = [...topics.values()].map((topic) => {
    const percentage = topic.total === 0 ? 0 : Math.round((topic.correct / topic.total) * 100);
    return {
      materialId: topic.materialId,
      materialTitle: topic.materialTitle,
      correct: topic.correct,
      total: topic.total,
      percentage,
      weak: percentage <= AI_EXAM_WEAK_TOPIC_THRESHOLD,
      studyReferences: [...topic.studyReferences.values()],
    };
  });

  const correctCount = topicReports.reduce((sum, topic) => sum + topic.correct, 0);
  const totalItems = topicReports.reduce((sum, topic) => sum + topic.total, 0);
  const percentage = totalItems === 0 ? 0 : Math.round((correctCount / totalItems) * 100);

  return { correctCount, totalItems, percentage, topics: topicReports };
}
