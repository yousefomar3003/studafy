/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Origin of the Studafy API. Defaults to http://localhost:3000 when unset. */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
