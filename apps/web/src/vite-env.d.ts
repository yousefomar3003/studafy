/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Origin of the Studafy API. Defaults to http://localhost:3000 when unset. */
  readonly VITE_API_BASE_URL?: string;
  /** Origin of the realtime gateway. Defaults to ws://localhost:3001 when unset. */
  readonly VITE_REALTIME_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
