/**
 * Origin of the newscast worker the Function reads the public share payload from.
 *
 * A Pages project has only two variable sets (production and preview), so a
 * variable cannot differ per environment. The deploy job writes this file from
 * the environment's newscast worker URL before `wrangler pages deploy`; the
 * committed value is production's, which `deploy-share-viewer.yml` ships as is.
 */
export const NEWSCAST_WORKER_URL: string = 'https://audio-underview-newscast-worker.tes-cha.workers.dev';
