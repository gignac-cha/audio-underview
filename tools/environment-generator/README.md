# Environment Generator

1Password Service Account를 통해 환경별 secret 파일을 생성합니다. 생성되는 파일은 모두 gitignore 대상입니다.

## 사전 조건

- [1Password CLI](https://1password.com/downloads/command-line/) 설치
- 1Password 개인 계정에 Service Account 토큰 저장 완료

## 사용법

```bash
eval $(op signin)
OP_SERVICE_ACCOUNT_TOKEN=$(pnpm run --silent environment:setup) pnpm run environment:generate
```

환경 이름(`development` 또는 `docker`)을 하나 넘기면 그 환경의 파일만 생성하고, 생략하면 둘 다 생성합니다.

```bash
OP_SERVICE_ACCOUNT_TOKEN=$(pnpm run --silent environment:setup) pnpm run environment:generate docker
```

1Password에서 읽지 못한 항목(없는 항목, 빈 값, `REPLACE_ME`)은 건너뛰고, 그 변수는 파일에서 빠집니다. 파일마다 빠진 변수를 경고로 알려 줍니다.

## 생성되는 파일

| 환경 | 파일 | 용도 |
|------|------|------|
| development | `workers/<워커>/.dev.vars.development` (워커 다섯 개) | `wrangler dev --env development`가 읽음. 이 파일이 있으면 `.dev.vars`는 읽지 않음 |
| development | `applications/web/.env.development.local` | 웹 앱 로컬 개발(`VITE_GOOGLE_CLIENT_ID`) |
| docker | `docker/.env.docker` | `docker compose --env-file`. 서비스마다 필요한 값만 받음(`docker/README.md`) |

워커별 변수는 각 워커의 `Environment` 인터페이스와 `wrangler.toml`에 적힌 secret 목록에서 정했습니다(user-vault에는 Supabase 키가 없습니다). 로그인 워커 둘의 `FRONTEND_URL`은 secret이 아니라 `https://localhost:5173`으로 고정해 씁니다.

## 1Password 항목

vault `Audio Underview`에서 읽습니다.

| 항목 | 필드 | 쓰는 곳 |
|------|------|------|
| `Supabase` | `URL`, `secret key` | development 워커(`SUPABASE_URL`, `SUPABASE_SECRET_KEY`) |
| `Google OAuth` | `client ID`, `client secret` | Google 로그인 워커, 웹, docker |
| `GitHub OAuth` | `client ID`, `client secret` | GitHub 로그인 워커, docker |
| `Axiom` | `API token` | development 로그인 워커(docker에는 넣지 않음) |
| `Crawler Code Runner Function` | `URL` | crawler-manager, docker |
| `Development Environment` | `JWT secret`, `vault internal token`, `provider key KEK` | development 워커 |
| `Docker Environment` | `JWT secret`, `vault internal token`, `provider key KEK`, `PostgREST JWT secret` | docker |

`Development Environment`와 `Docker Environment`의 값은 다른 환경과 겹치지 않게 따로 만듭니다.
