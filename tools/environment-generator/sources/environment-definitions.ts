/**
 * 1Password 참조 ↔ 환경변수 ↔ 출력 파일 매핑 정의.
 *
 * 참조 경로는 레거시 vault 구조(`op://Audio Underview/...`)를 기반으로
 * 재작성된 패키지 구조의 새 키에 맞춰 조정한 것이다.
 * "신규" 표시가 있는 항목은 실제 vault 항목명 확인 필요 —
 * vault에 아직 없다면 같은 이름으로 항목을 만들거나 참조 경로를 수정할 것.
 */

export interface SecretMapping {
  reference: string;
  variableName: string;
}

export const SECRET_MAPPINGS: SecretMapping[] = [
  // --- applications/web/.env (Vite 빌드타임) ---
  // 레거시 provider별 worker URL(VITE_GOOGLE_OAUTH_WORKER_URL 등)은
  // 단일 authentication-worker URL로 통합 (ADR-1)
  {
    reference: 'op://Audio Underview/Authentication Worker/URL', // 신규 — 실제 vault 항목명 확인 필요
    variableName: 'VITE_AUTHENTICATION_WORKER_URL',
  },
  {
    reference: 'op://Audio Underview/Crawler Manager Worker/URL',
    variableName: 'VITE_CRAWLER_MANAGER_WORKER_URL',
  },
  {
    reference: 'op://Audio Underview/Scheduler Manager Worker/URL', // 신규 — 실제 vault 항목명 확인 필요
    variableName: 'VITE_SCHEDULER_MANAGER_WORKER_URL',
  },
  {
    reference: 'op://Audio Underview/Crawler Code Runner Function/URL',
    variableName: 'VITE_CRAWLER_CODE_RUNNER_FUNCTION_URL',
  },

  // --- <root>/.env.workers: authentication-worker 공통 secret ---
  {
    reference: 'op://Audio Underview/JWT/secret', // 신규 — 실제 vault 항목명 확인 필요
    variableName: 'JWT_SECRET',
  },
  {
    reference: 'op://Audio Underview/Supabase/URL', // 신규 — 실제 vault 항목명 확인 필요
    variableName: 'SUPABASE_URL',
  },
  {
    reference: 'op://Audio Underview/Supabase/secret key', // 신규 — 실제 vault 항목명 확인 필요
    variableName: 'SUPABASE_SECRET_KEY',
  },
  {
    reference: 'op://Audio Underview/Frontend/URL',
    variableName: 'FRONTEND_URL',
  },
  {
    reference: 'op://Audio Underview/Frontend/allowed origins',
    variableName: 'ALLOWED_ORIGINS',
  },

  // --- <root>/.env.workers: OAuth provider 10개 (authentication-worker 주입용) ---
  {
    reference: 'op://Audio Underview/Google OAuth/client ID',
    variableName: 'GOOGLE_CLIENT_ID',
  },
  {
    reference: 'op://Audio Underview/Google OAuth/client secret',
    variableName: 'GOOGLE_CLIENT_SECRET',
  },
  {
    reference: 'op://Audio Underview/Apple OAuth/client ID', // Services ID
    variableName: 'APPLE_CLIENT_ID',
  },
  {
    reference: 'op://Audio Underview/Apple OAuth/team ID',
    variableName: 'APPLE_TEAM_ID',
  },
  {
    reference: 'op://Audio Underview/Apple OAuth/key ID',
    variableName: 'APPLE_KEY_ID',
  },
  {
    reference: 'op://Audio Underview/Apple OAuth/private key', // PEM
    variableName: 'APPLE_PRIVATE_KEY',
  },
  {
    reference: 'op://Audio Underview/Microsoft OAuth/client ID',
    variableName: 'MICROSOFT_CLIENT_ID',
  },
  {
    reference: 'op://Audio Underview/Microsoft OAuth/client secret',
    variableName: 'MICROSOFT_CLIENT_SECRET',
  },
  {
    reference: 'op://Audio Underview/Facebook OAuth/client ID',
    variableName: 'FACEBOOK_CLIENT_ID',
  },
  {
    reference: 'op://Audio Underview/Facebook OAuth/client secret',
    variableName: 'FACEBOOK_CLIENT_SECRET',
  },
  {
    // worker env 이름은 GITHUB_* — GitHub Actions secret 이름만 OAUTH_GITHUB_* (예약 prefix 회피)
    reference: 'op://Audio Underview/GitHub OAuth/client ID',
    variableName: 'GITHUB_CLIENT_ID',
  },
  {
    reference: 'op://Audio Underview/GitHub OAuth/client secret',
    variableName: 'GITHUB_CLIENT_SECRET',
  },
  {
    reference: 'op://Audio Underview/Discord OAuth/client ID',
    variableName: 'DISCORD_CLIENT_ID',
  },
  {
    reference: 'op://Audio Underview/Discord OAuth/client secret',
    variableName: 'DISCORD_CLIENT_SECRET',
  },
  {
    reference: 'op://Audio Underview/Kakao OAuth/client ID', // REST API Key
    variableName: 'KAKAO_CLIENT_ID',
  },
  {
    reference: 'op://Audio Underview/Kakao OAuth/client secret', // optional — vault에 없으면 skip됨
    variableName: 'KAKAO_CLIENT_SECRET',
  },
  {
    reference: 'op://Audio Underview/Naver OAuth/client ID',
    variableName: 'NAVER_CLIENT_ID',
  },
  {
    reference: 'op://Audio Underview/Naver OAuth/client secret',
    variableName: 'NAVER_CLIENT_SECRET',
  },
  {
    reference: 'op://Audio Underview/LinkedIn OAuth/client ID', // 신규 provider — 실제 vault 항목명 확인 필요
    variableName: 'LINKEDIN_CLIENT_ID',
  },
  {
    reference: 'op://Audio Underview/LinkedIn OAuth/client secret', // 신규 provider — 실제 vault 항목명 확인 필요
    variableName: 'LINKEDIN_CLIENT_SECRET',
  },
  {
    reference: 'op://Audio Underview/X OAuth/client ID', // 신규 provider — 실제 vault 항목명 확인 필요
    variableName: 'X_CLIENT_ID',
  },
  {
    reference: 'op://Audio Underview/X OAuth/client secret', // 신규 provider — 실제 vault 항목명 확인 필요
    variableName: 'X_CLIENT_SECRET',
  },

  // --- <root>/.env.deploy: 배포 자격증명 (레거시와 동일) ---
  {
    reference: 'op://Audio Underview/Cloudflare/API token',
    variableName: 'CLOUDFLARE_API_TOKEN',
  },
  {
    reference: 'op://Audio Underview/Cloudflare/account ID',
    variableName: 'CLOUDFLARE_ACCOUNT_ID',
  },
  {
    reference: 'op://Audio Underview/AWS/access key ID',
    variableName: 'AWS_ACCESS_KEY_ID',
  },
  {
    reference: 'op://Audio Underview/AWS/secret access key',
    variableName: 'AWS_SECRET_ACCESS_KEY',
  },
  {
    reference: 'op://Audio Underview/AWS/Lambda execution role ARN',
    variableName: 'AWS_LAMBDA_EXECUTION_ROLE_ARN',
  },
  {
    reference: 'op://Audio Underview/AWS/region',
    variableName: 'AWS_REGION',
  },
];

export interface EnvironmentFileDefinition {
  /** 프로젝트 루트 기준 상대 경로 세그먼트 */
  outputPathSegments: string[];
  variableNames: string[];
}

export const ENVIRONMENT_FILES: EnvironmentFileDefinition[] = [
  {
    outputPathSegments: ['applications', 'web', '.env'],
    variableNames: [
      'VITE_AUTHENTICATION_WORKER_URL',
      'VITE_CRAWLER_MANAGER_WORKER_URL',
      'VITE_SCHEDULER_MANAGER_WORKER_URL',
      'VITE_CRAWLER_CODE_RUNNER_FUNCTION_URL',
    ],
  },
  {
    // authentication-worker secret 주입용 (`wrangler secret put` 소스) + 공통 값
    outputPathSegments: ['.env.workers'],
    variableNames: [
      'JWT_SECRET',
      'SUPABASE_URL',
      'SUPABASE_SECRET_KEY',
      'FRONTEND_URL',
      'ALLOWED_ORIGINS',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'APPLE_CLIENT_ID',
      'APPLE_TEAM_ID',
      'APPLE_KEY_ID',
      'APPLE_PRIVATE_KEY',
      'MICROSOFT_CLIENT_ID',
      'MICROSOFT_CLIENT_SECRET',
      'FACEBOOK_CLIENT_ID',
      'FACEBOOK_CLIENT_SECRET',
      'GITHUB_CLIENT_ID',
      'GITHUB_CLIENT_SECRET',
      'DISCORD_CLIENT_ID',
      'DISCORD_CLIENT_SECRET',
      'KAKAO_CLIENT_ID',
      'KAKAO_CLIENT_SECRET',
      'NAVER_CLIENT_ID',
      'NAVER_CLIENT_SECRET',
      'LINKEDIN_CLIENT_ID',
      'LINKEDIN_CLIENT_SECRET',
      'X_CLIENT_ID',
      'X_CLIENT_SECRET',
    ],
  },
  {
    // GitHub secrets/vars 등록용 로컬 사본 (레거시와 동일)
    outputPathSegments: ['.env.deploy'],
    variableNames: [
      'CLOUDFLARE_API_TOKEN',
      'CLOUDFLARE_ACCOUNT_ID',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_LAMBDA_EXECUTION_ROLE_ARN',
      'AWS_REGION',
    ],
  },
];
