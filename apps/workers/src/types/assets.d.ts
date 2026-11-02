declare module "*.woff" {
  const path: string;
  export default path;
}

declare module "bidi-js" {
  interface EmbeddingLevels {
    levels: Uint8Array;
    paragraphs: { start: number; end: number; level: number }[];
  }

  interface Bidi {
    getEmbeddingLevels(text: string, direction?: "ltr" | "rtl"): EmbeddingLevels;
    getReorderSegments(
      text: string,
      levels: EmbeddingLevels,
      start?: number,
      end?: number,
    ): [number, number][];
    getMirroredCharactersMap(text: string, levels: EmbeddingLevels): Map<number, string>;
  }

  export default function bidiFactory(): Bidi;
}
