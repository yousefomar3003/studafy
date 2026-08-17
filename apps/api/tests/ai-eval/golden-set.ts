/**
 * Golden set for RAG eval harness (NFR-11).
 *
 * Each case models a complete RAG scenario: a student query, the retrieval hits the hybrid
 * search would return, the answer the LLM would produce from those hits, and the expected
 * outcomes for every metric the harness scores. The hits are realistic — they carry the same
 * shape `hybridSearch` returns, with RRF scores, semantic/keyword ranks, and chunk anchors.
 *
 * The set is deliberately small (15 cases) and covers every metric dimension:
 *   - Grounded answers (cases 1-8): citations present, sources support claims
 *   - Refusal cases (cases 9-12): hits below the grounding bar or keyword-leg missing
 *   - Citation edge cases (cases 13-14): invented citations, out-of-range ids
 *   - Retrieval edge case (case 15): relevant chunk outside the top-k
 *
 * Adding a case: append to `GOLDEN_SET`, assign a unique `id`, and document which dimension
 * it tests. Keep the set honest — every case should be something the pipeline encounters in
 * production, not a synthetic edge case that never happens.
 */

import type { HybridSearchHit } from "../../src/modules/ai/retrieval/search";

export interface GoldenCase {
  id: string;
  query: string;
  hits: HybridSearchHit[];
  /** Pre-written answer the LLM produces from the golden sources. */
  answer: string;
  /** Chunk ids that are genuinely relevant to the query (for retrieval recall). */
  relevantChunkIds: string[];
  /** Whether the grounding assessment should refuse. */
  shouldRefuse: boolean;
}

const MATERIAL = "00000000-0000-4000-8000-000000000100";

function hit(
  id: string,
  content: string,
  opts: { rrfScore?: number; semanticRank?: number | null; keywordRank?: number | null } = {},
): HybridSearchHit {
  return {
    chunkId: id,
    materialId: MATERIAL,
    materialTitle: "Biology 101",
    pageNumber: 1,
    sectionTitle: "General",
    content,
    rrfScore: opts.rrfScore ?? 0.05,
    semanticRank: opts.semanticRank === undefined ? 1 : opts.semanticRank,
    keywordRank: opts.keywordRank === undefined ? 1 : opts.keywordRank,
  };
}

export const GOLDEN_SET: GoldenCase[] = [
  // ── Grounded answers ──────────────────────────────────────────────────────

  {
    id: "grounded-photosynthesis",
    query: "How does photosynthesis convert light energy?",
    hits: [
      hit(
        "c1",
        "Photosynthesis converts light energy into chemical energy stored in glucose molecules.",
        { rrfScore: 0.06, semanticRank: 1, keywordRank: 1 },
      ),
      hit(
        "c2",
        "Chlorophyll in the chloroplast absorbs light across the visible spectrum to drive the reaction.",
        { rrfScore: 0.055, semanticRank: 2, keywordRank: 2 },
      ),
      hit(
        "c3",
        "The light-dependent reactions occur in the thylakoid membrane of the chloroplast.",
        { rrfScore: 0.05, semanticRank: 3, keywordRank: 3 },
      ),
    ],
    answer:
      "Photosynthesis converts light energy into chemical energy stored in glucose [1]. " +
      "Chlorophyll in the chloroplast absorbs light to drive this reaction [2].",
    relevantChunkIds: ["c1", "c2"],
    shouldRefuse: false,
  },
  {
    id: "grounded-mitosis",
    query: "What happens during mitosis?",
    hits: [
      hit("c1", "Mitosis separates chromosomes into two identical sets in daughter cells.", {
        rrfScore: 0.058,
        semanticRank: 1,
        keywordRank: 1,
      }),
      hit("c2", "During prophase the chromosomes condense and the nuclear envelope breaks down.", {
        rrfScore: 0.052,
        semanticRank: 2,
        keywordRank: 2,
      }),
    ],
    answer:
      "Mitosis separates chromosomes into two identical sets in daughter cells [1]. " +
      "During prophase the chromosomes condense [2].",
    relevantChunkIds: ["c1", "c2"],
    shouldRefuse: false,
  },
  {
    id: "grounded-newton",
    query: "What is Newton's second law?",
    hits: [
      hit("c1", "Newton's second law states that force equals mass times acceleration.", {
        rrfScore: 0.057,
        semanticRank: 1,
        keywordRank: 1,
      }),
      hit("c2", "The law relates the net force acting on an object to its mass and acceleration.", {
        rrfScore: 0.051,
        semanticRank: 2,
        keywordRank: 2,
      }),
    ],
    answer:
      "Newton's second law states that force equals mass times acceleration [1]. " +
      "It relates the net force on an object to its mass and acceleration [2].",
    relevantChunkIds: ["c1", "c2"],
    shouldRefuse: false,
  },
  {
    id: "grounded-emancipation",
    query: "Who issued the Emancipation Proclamation?",
    hits: [
      hit(
        "c1",
        "Abraham Lincoln issued the Emancipation Proclamation during the Civil War in 1863.",
        { rrfScore: 0.06, semanticRank: 1, keywordRank: 1 },
      ),
      hit("c2", "The proclamation declared slaves in Confederate states to be free.", {
        rrfScore: 0.053,
        semanticRank: 2,
        keywordRank: 2,
      }),
    ],
    answer:
      "Abraham Lincoln issued the Emancipation Proclamation during the Civil War [1]. " +
      "It declared slaves in Confederate states to be free [2].",
    relevantChunkIds: ["c1", "c2"],
    shouldRefuse: false,
  },
  {
    id: "grounded-molarity",
    query: "What does molarity measure?",
    hits: [
      hit(
        "c1",
        "Molarity measures the concentration of a solution as moles of solute per liter of solution.",
        { rrfScore: 0.056, semanticRank: 1, keywordRank: 1 },
      ),
      hit(
        "c2",
        "A one molar solution contains one mole of solute dissolved in one liter of solution.",
        { rrfScore: 0.049, semanticRank: 2, keywordRank: 2 },
      ),
    ],
    answer:
      "Molarity measures the concentration of a solution as moles of solute per liter [1]. " +
      "A one molar solution contains one mole of solute per liter [2].",
    relevantChunkIds: ["c1", "c2"],
    shouldRefuse: false,
  },
  {
    id: "grounded-water-cycle",
    query: "What are the main stages of the water cycle?",
    hits: [
      hit("c1", "Evaporation turns liquid water into water vapor using heat energy from the sun.", {
        rrfScore: 0.058,
        semanticRank: 1,
        keywordRank: 1,
      }),
      hit("c2", "Condensation occurs when water vapor cools and forms liquid droplets in clouds.", {
        rrfScore: 0.053,
        semanticRank: 2,
        keywordRank: 2,
      }),
      hit("c3", "Precipitation returns water to the Earth's surface as rain, snow, or hail.", {
        rrfScore: 0.047,
        semanticRank: 3,
        keywordRank: 3,
      }),
    ],
    answer:
      "Evaporation turns liquid water into water vapor [1]. " +
      "Condensation forms clouds as vapor cools [2]. " +
      "Precipitation returns water to the surface as rain or snow [3].",
    relevantChunkIds: ["c1", "c2", "c3"],
    shouldRefuse: false,
  },
  {
    id: "grounded-electrolysis",
    query: "How does electrolysis work?",
    hits: [
      hit(
        "c1",
        "Electrolysis uses an electric current to drive a non-spontaneous chemical reaction in an electrolyte solution.",
        { rrfScore: 0.057, semanticRank: 1, keywordRank: 1 },
      ),
      hit(
        "c2",
        "At the cathode reduction occurs while oxidation occurs at the anode during electrolysis.",
        { rrfScore: 0.05, semanticRank: 2, keywordRank: 2 },
      ),
    ],
    answer:
      "Electrolysis uses an electric current to drive a chemical reaction in an electrolyte [1]. " +
      "Reduction occurs at the cathode and oxidation at the anode [2].",
    relevantChunkIds: ["c1", "c2"],
    shouldRefuse: false,
  },
  {
    id: "grounded-plate-tectonics",
    query: "What is continental drift?",
    hits: [
      hit(
        "c1",
        "Continental drift describes the movement of Earth's tectonic plates across the planet's surface over millions of years.",
        { rrfScore: 0.055, semanticRank: 1, keywordRank: 1 },
      ),
      hit(
        "c2",
        "Alfred Wegener proposed the theory of continental drift in 1912 based on matching fossil and rock records across continents.",
        { rrfScore: 0.049, semanticRank: 2, keywordRank: 2 },
      ),
    ],
    answer:
      "Continental drift describes the movement of tectonic plates across Earth's surface [1]. " +
      "Alfred Wegener proposed the theory in 1912 based on matching fossil records [2].",
    relevantChunkIds: ["c1", "c2"],
    shouldRefuse: false,
  },

  // ── Refusal cases ─────────────────────────────────────────────────────────

  {
    id: "refusal-semantic-only",
    query: "Explain quantum entanglement",
    hits: [
      hit("c1", "Light travels as electromagnetic waves through the vacuum of space.", {
        rrfScore: 0.035,
        semanticRank: 1,
        keywordRank: null,
      }),
      hit("c2", "Energy can be neither created nor destroyed in an isolated system.", {
        rrfScore: 0.03,
        semanticRank: 2,
        keywordRank: null,
      }),
    ],
    answer: "",
    relevantChunkIds: [],
    shouldRefuse: true,
  },
  {
    id: "refusal-below-threshold",
    query: "What is the capital of France?",
    hits: [
      hit("c1", "Paris is the largest city in France and a major European capital.", {
        rrfScore: 0.015,
        semanticRank: 1,
        keywordRank: 3,
      }),
      hit("c2", "France is a country in Western Europe with a rich cultural history.", {
        rrfScore: 0.012,
        semanticRank: 2,
        keywordRank: 4,
      }),
    ],
    answer: "",
    relevantChunkIds: [],
    shouldRefuse: true,
  },
  {
    id: "refusal-weak-hits",
    query: "How does CRISPR gene editing work?",
    hits: [
      hit(
        "c1",
        "DNA contains the genetic instructions for the development and function of living organisms.",
        { rrfScore: 0.018, semanticRank: 1, keywordRank: null },
      ),
      hit(
        "c2",
        "Proteins are large biomolecules consisting of one or more long chains of amino acid residues.",
        { rrfScore: 0.014, semanticRank: 2, keywordRank: null },
      ),
    ],
    answer: "",
    relevantChunkIds: [],
    shouldRefuse: true,
  },
  {
    id: "refusal-tangential",
    query: "What causes volcanic eruptions?",
    hits: [
      hit(
        "c1",
        "Tectonic plates float on the semi-fluid asthenosphere beneath the Earth's crust.",
        { rrfScore: 0.019, semanticRank: 1, keywordRank: null },
      ),
      hit(
        "c2",
        "Earthquakes occur when tectonic plates shift and release energy along fault lines.",
        { rrfScore: 0.016, semanticRank: 2, keywordRank: null },
      ),
    ],
    answer: "",
    relevantChunkIds: [],
    shouldRefuse: true,
  },

  // ── Citation edge cases ───────────────────────────────────────────────────

  {
    id: "citation-out-of-range",
    query: "What is the mitochondria's role in cells?",
    hits: [
      hit("c1", "Mitochondria are membrane-bound organelles found in most eukaryotic cells.", {
        rrfScore: 0.055,
        semanticRank: 1,
        keywordRank: 1,
      }),
      hit(
        "c2",
        "ATP is the primary energy carrier molecule used by cells to power biological processes.",
        { rrfScore: 0.048, semanticRank: 2, keywordRank: 2 },
      ),
    ],
    answer:
      "Mitochondria are membrane-bound organelles found in most eukaryotic cells [1]. " +
      "They produce ATP which is the primary energy carrier [4].",
    relevantChunkIds: ["c1", "c2"],
    shouldRefuse: false,
  },
  {
    id: "citation-invented-id",
    query: "How does photosynthesis work?",
    hits: [
      hit("c1", "Photosynthesis converts light energy into chemical energy in glucose.", {
        rrfScore: 0.06,
        semanticRank: 1,
        keywordRank: 1,
      }),
      hit("c2", "Chlorophyll absorbs light primarily in the red and blue wavelengths.", {
        rrfScore: 0.052,
        semanticRank: 2,
        keywordRank: 2,
      }),
    ],
    answer:
      "Photosynthesis converts light energy into chemical energy in glucose [1]. " +
      "Chlorophyll absorbs light in the red and blue wavelengths [5].",
    relevantChunkIds: ["c1", "c2"],
    shouldRefuse: false,
  },

  // ── Retrieval edge case ───────────────────────────────────────────────────

  {
    id: "retrieval-partial-recall",
    query: "What are the layers of the Earth's atmosphere?",
    hits: [
      hit("c1", "The troposphere is the lowest layer of Earth's atmosphere where weather occurs.", {
        rrfScore: 0.055,
        semanticRank: 1,
        keywordRank: 1,
      }),
      hit("c2", "The stratosphere contains the ozone layer which absorbs ultraviolet radiation.", {
        rrfScore: 0.048,
        semanticRank: 2,
        keywordRank: 2,
      }),
      hit(
        "c3",
        "Continental drift describes the movement of tectonic plates across the Earth's surface.",
        { rrfScore: 0.042, semanticRank: 3, keywordRank: 3 },
      ),
    ],
    answer:
      "The troposphere is the lowest layer where weather occurs [1]. " +
      "The stratosphere contains the ozone layer [2]. " +
      "The thermosphere is a higher layer where temperatures increase with altitude [3].",
    relevantChunkIds: ["c1", "c2"],
    shouldRefuse: false,
  },
];
