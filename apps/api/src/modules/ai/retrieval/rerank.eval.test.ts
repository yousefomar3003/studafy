/**
 * ST-163 re-ranker evaluation — nDCG on a golden set.
 *
 * This is the acceptance evidence for "re-rank improves eval nDCG on the golden set". The golden set
 * models real hybrid-retrieval output: each query has a candidate pool already ordered by its RRF
 * score, the order the retrieval route returns today, and a judged-relevant chunk. The pools are
 * honest about why a re-ranker exists — the fused order is diluted by the semantic leg's noise, so a
 * chunk that merely echoes one query token can outrank the chunk that answers the whole question.
 * The deterministic scorer lifts exactly those chunks (full query-token coverage) above the partial
 * matches.
 *
 * The assertion is comparative, never absolute: re-ranking must not regress any judged query
 * (tie-break on the fusion score makes that the only possible outcome when relevance tracks query
 * coverage) and must strictly beat the RRF baseline in aggregate.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { createDeterministicCrossEncoderReranker, rerankHits } from "./rerank";

import type { Rerankable } from "./rerank";

interface GoldenQuery {
  query: string;
  /** The candidate pool in the order hybrid retrieval returns it (RRF score descending). */
  candidates: Rerankable[];
  /** Chunk ids a human judge marked relevant to the query. */
  relevant: string[];
}

/**
 * The golden set. Candidate pools are written RRF-first, matching the retrieval route's current
 * output; `rrfScore` descends through the array. Relevant chunks carry every query token, the
 * distractors carry some or none — the pattern a noisy semantic leg produces in production.
 */
const GOLDEN_SET: GoldenQuery[] = [
  {
    query: "photosynthesis light energy chloroplast",
    candidates: [
      {
        chunkId: "d1",
        content: "Chloroplast pigments absorb light across the visible spectrum.",
        rrfScore: 0.054,
      },
      {
        chunkId: "d2",
        content: "Plant leaves capture light for growth in summer months.",
        rrfScore: 0.052,
      },
      {
        chunkId: "r1",
        content: "Photosynthesis converts light energy into chemical energy inside a chloroplast.",
        rrfScore: 0.05,
      },
      {
        chunkId: "d3",
        content: "Chemical energy in cells is stored in adenosine triphosphate molecules.",
        rrfScore: 0.048,
      },
      {
        chunkId: "d4",
        content: "Cellular respiration releases energy stored in glucose during the night.",
        rrfScore: 0.046,
      },
    ],
    relevant: ["r1"],
  },
  {
    query: "mitosis separates chromosomes during cell division",
    candidates: [
      {
        chunkId: "d1",
        content: "Chromosomes condense before the nucleus splits apart.",
        rrfScore: 0.054,
      },
      {
        chunkId: "d2",
        content: "Cell division drives tissue growth during development.",
        rrfScore: 0.052,
      },
      {
        chunkId: "d3",
        content: "Daughter cells inherit a full copy of the genome.",
        rrfScore: 0.05,
      },
      {
        chunkId: "r1",
        content: "Mitosis separates chromosomes during cell division to form daughter cells.",
        rrfScore: 0.048,
      },
      {
        chunkId: "d4",
        content: "The nucleus holds the genetic material of a living organism.",
        rrfScore: 0.046,
      },
    ],
    relevant: ["r1"],
  },
  {
    query: "newton second law relates force mass acceleration",
    candidates: [
      {
        chunkId: "d1",
        content: "Acceleration describes how velocity changes over time.",
        rrfScore: 0.055,
      },
      {
        chunkId: "r1",
        content: "Newton's second law relates force, mass, and acceleration together.",
        rrfScore: 0.053,
      },
      {
        chunkId: "d2",
        content: "Mass is the amount of matter contained in an object.",
        rrfScore: 0.051,
      },
      {
        chunkId: "d3",
        content: "Velocity measures how quickly a position changes.",
        rrfScore: 0.049,
      },
      { chunkId: "d4", content: "Momentum is the product of mass and velocity.", rrfScore: 0.047 },
    ],
    relevant: ["r1"],
  },
  {
    query: "abraham lincoln issued emancipation civil war",
    candidates: [
      {
        chunkId: "d1",
        content: "Emancipation changed the lives of enslaved people in America.",
        rrfScore: 0.054,
      },
      {
        chunkId: "d2",
        content: "War between northern and southern states began in 1861.",
        rrfScore: 0.052,
      },
      {
        chunkId: "r1",
        content: "Abraham Lincoln issued the Emancipation Proclamation during the Civil War.",
        rrfScore: 0.05,
      },
      {
        chunkId: "d3",
        content: "Lincoln's speeches inspired generations of American leaders.",
        rrfScore: 0.048,
      },
      {
        chunkId: "d4",
        content: "The American Revolution ended British rule over the colonies.",
        rrfScore: 0.046,
      },
    ],
    relevant: ["r1"],
  },
  {
    query: "molarity measures solution concentration moles",
    candidates: [
      {
        chunkId: "d1",
        content: "Concentration measures the strength of a chemical solution.",
        rrfScore: 0.054,
      },
      { chunkId: "d2", content: "Acids donate protons when dissolved in water.", rrfScore: 0.052 },
      {
        chunkId: "d3",
        content: "Dilution reduces the concentration of a prepared solution.",
        rrfScore: 0.05,
      },
      {
        chunkId: "r1",
        content: "Molarity measures solution concentration as moles of solute per liter.",
        rrfScore: 0.048,
      },
      { chunkId: "d4", content: "Pure water is a poor conductor of electricity.", rrfScore: 0.046 },
    ],
    relevant: ["r1"],
  },
  {
    query: "water cycle combines evaporation condensation precipitation",
    candidates: [
      {
        chunkId: "d1",
        content: "Evaporation turns liquid water into water vapor.",
        rrfScore: 0.055,
      },
      {
        chunkId: "r1",
        content: "The water cycle combines evaporation, condensation, and precipitation.",
        rrfScore: 0.053,
      },
      { chunkId: "d2", content: "Clouds form when moist air rises and cools.", rrfScore: 0.051 },
      {
        chunkId: "d3",
        content: "Precipitation falls as rain or snow from clouds.",
        rrfScore: 0.049,
      },
      {
        chunkId: "d4",
        content: "Condensation creates droplets that form visible clouds.",
        rrfScore: 0.047,
      },
    ],
    relevant: ["r1"],
  },
  {
    // The no-regression case: the full-coverage chunk is already first under RRF, and must stay first.
    query: "electrolysis uses electrodes immersed electrolyte",
    candidates: [
      {
        chunkId: "r1",
        content: "Electrolysis uses electrodes immersed in an electrolyte solution.",
        rrfScore: 0.06,
      },
      {
        chunkId: "d1",
        content: "Electrolytes conduct electricity when dissolved in water.",
        rrfScore: 0.054,
      },
      {
        chunkId: "d2",
        content: "Oxygen and hydrogen gases bubble at the electrodes.",
        rrfScore: 0.052,
      },
      { chunkId: "d3", content: "Pure water is a poor conductor of electricity.", rrfScore: 0.05 },
    ],
    relevant: ["r1"],
  },
];

const EVAL_K = 6;

function dcgAtK(order: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  let sum = 0;
  let rank = 1;
  for (const chunkId of order) {
    if (rank > k) break;
    if (relevant.has(chunkId)) sum += 1 / Math.log2(rank + 1);
    rank += 1;
  }
  return sum;
}

function idcgAtK(relevantCount: number, k: number): number {
  let sum = 0;
  for (let index = 0; index < Math.min(relevantCount, k); index += 1) {
    sum += 1 / Math.log2(index + 2);
  }
  return sum;
}

function ndcgAtK(order: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  if (relevant.size === 0) return 0;
  return dcgAtK(order, relevant, k) / idcgAtK(relevant.size, k);
}

describe("re-ranking on the golden set", () => {
  test("lifts every judged query and beats the RRF baseline in aggregate", async () => {
    const reranker = createDeterministicCrossEncoderReranker();

    let baselineNdcg = 0;
    let rerankedNdcg = 0;

    for (const golden of GOLDEN_SET) {
      const relevant = new Set(golden.relevant);
      const rrfOrder = golden.candidates.map((candidate) => candidate.chunkId);
      const { hits } = await rerankHits(golden.query, golden.candidates, reranker, {
        keep: EVAL_K,
      });
      const rerankedOrder = hits.map((hit) => hit.chunkId);

      const baseline = ndcgAtK(rrfOrder, relevant, EVAL_K);
      const reranked = ndcgAtK(rerankedOrder, relevant, EVAL_K);

      // Non-regression is per query, not averaged away: no judged query may rank worse.
      expect(
        reranked,
        `${golden.query}: re-rank must not regress nDCG@${EVAL_K}`,
      ).toBeGreaterThanOrEqual(baseline);
      // Every relevant chunk must survive the top-k cut — the point of the re-ranker.
      for (const id of relevant) {
        expect(rerankedOrder, `${golden.query}: relevant chunk ${id} dropped`).toContain(id);
      }

      baselineNdcg += baseline;
      rerankedNdcg += reranked;
    }

    // The acceptance claim: in aggregate the re-ranked order is strictly better than the RRF order.
    expect(rerankedNdcg).toBeGreaterThan(baselineNdcg);
  });
});
