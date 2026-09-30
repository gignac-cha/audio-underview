/**
 * How a deployable workspace is deployed: the workflow file under
 * `.github/workflows/` and, when that workflow deploys several workspaces, the
 * boolean input that selects this one.
 *
 * A `paused` target is still reported when it is affected but never dispatched.
 * Remove the reason once the target is ready to deploy on its own.
 */
export interface DeploymentTarget {
  workflow: string;
  input?: string;
  paused?: string;
}

const OAUTH_WORKFLOW = 'deploy-oauth-workers.yml';

// Never deployed yet. Deploying before their secrets exist ships a worker that
// fails every login, so they stay out until the secrets are registered.
const AWAITING_SECRETS = 'first deploy waits for its secrets to be registered';

function oauthWorker(provider: string, paused?: string): [string, DeploymentTarget] {
  return [`@audio-underview/${provider}-oauth-provider-worker`, { workflow: OAUTH_WORKFLOW, input: provider, paused }];
}

/** Every deployable workspace, keyed by package name. Anything else is a library bundled into these. */
export const DEPLOYMENT_TARGETS: ReadonlyMap<string, DeploymentTarget> = new Map([
  oauthWorker('google'),
  oauthWorker('apple'),
  oauthWorker('microsoft'),
  oauthWorker('facebook'),
  oauthWorker('github'),
  oauthWorker('discord'),
  oauthWorker('kakao'),
  oauthWorker('naver'),
  oauthWorker('threads', AWAITING_SECRETS),
  oauthWorker('tiktok', AWAITING_SECRETS),
  oauthWorker('line', AWAITING_SECRETS),
  oauthWorker('bluesky', AWAITING_SECRETS),
  oauthWorker('linkedin', AWAITING_SECRETS),
  oauthWorker('x', AWAITING_SECRETS),
  oauthWorker('twitch', AWAITING_SECRETS),
  ['@audio-underview/crawler-manager-worker', { workflow: 'deploy-crawler-workers.yml', input: 'crawler_manager' }],
  [
    '@audio-underview/crawler-code-runner-worker',
    {
      workflow: 'deploy-crawler-workers.yml',
      input: 'crawler_code_runner',
      paused: 'deploy job is disabled by the Cloudflare WorkerLoader limitation',
    },
  ],
  ['@audio-underview/scheduler-manager-worker', { workflow: 'deploy-scheduler-worker.yml' }],
  ['@audio-underview/user-vault-worker', { workflow: 'deploy-user-vault-worker.yml', paused: AWAITING_SECRETS }],
  ['@audio-underview/crawler-code-runner-function', { workflow: 'deploy-crawler-functions.yml', input: 'crawler_code_runner' }],
  ['@audio-underview/web', { workflow: 'deploy-web.yml' }],
]);
