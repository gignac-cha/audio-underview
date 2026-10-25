/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Origin of the newscast pipeline worker, e.g.
   * `https://audio-underview-newscast-worker.tes-cha.workers.dev`. Public
   * information (no credentials) — the share token in the URL is the only
   * capability the viewer carries.
   */
  readonly VITE_NEWSCAST_WORKER_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
