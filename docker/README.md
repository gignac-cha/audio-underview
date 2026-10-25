# docker 환경

웹, 워커 여섯 개(Google·GitHub 로그인, crawler-manager, scheduler-manager, user-vault, newscast), 그리고 이 환경만의 DB를 compose 하나로 띄운다. 설계는 `documents/2026-10-19-staging-environment.md` 7절이다.

데이터는 클라우드에 두지 않는다. Supabase, R2, KV, Workflow, Axiom 모두 쓰지 않는다. 워커가 밖으로 보내는 요청은 아래뿐이다.
- 로그인: Google·GitHub의 OAuth 주소. crawler-manager와 scheduler-manager도 로그인 토큰을 확인하러 Google(`www.googleapis.com/oauth2/v3/userinfo`)과 GitHub(`api.github.com/user`)를 부른다.
- 크롤러 코드 실행: 코드 실행 Lambda(`CODE_RUNNER_FUNCTION_URL`, 데이터를 저장하지 않음). 크롤러 코드가 가져오는 주소와, 그 주소를 찾는 DNS over HTTPS(`cloudflare-dns.com`).
- user-vault: 사용자가 provider key를 저장할 때 그 key를 확인하러 provider API(OpenAI, Anthropic, Gemini, xAI 등)를 부른다. newscast가 대본·음성을 만들 때도 사용자의 key로 같은 provider API를 user-vault가 대신 부른다.

Axiom에는 아무것도 보내지 않는다. 로그인 워커는 trace를 늘 Axiom으로 보내는데(`packages/axiom-logger`에 끄는 설정이 없다), 이 환경에서는 진짜 token을 주지 않고, `workers` 컨테이너 안에서 `api.axiom.co`가 컨테이너 자신(`127.0.0.1`)을 가리키게 해 두었다. 그래서 보내기는 컨테이너를 나가기 전에 실패하고, 로그에 `exporting spans failed!`가 찍힌다. 그대로 두면 된다.

## 구성

| 서비스 | 하는 일 | 포트 |
| -- | -- | -- |
| `database` | Postgres 17. 처음 뜰 때 Supabase 역할(`anon`, `authenticated`, `service_role`, `authenticator`)을 만든다 | 밖에 열지 않음 |
| `migrate` | `packages/supabase-connector/migrations`를 번호 순서대로 `public`에 적용하고 끝난다. 적용한 파일은 `migration_history.applied_migrations`에 남겨 다음에는 건너뛴다 | 없음 |
| `rest` | PostgREST v14. `authenticator`로 접속하고 `public`을 내보낸다 | 밖에 열지 않음 |
| `gateway` | nginx. `<SUPABASE_URL>/rest/v1/…`을 PostgREST로 넘긴다 | 밖에 열지 않음(망 안에서 `http://gateway:8000`) |
| `workers` | 워커 여섯 개를 `wrangler dev --env docker`로 한 컨테이너에서 띄운다 | 9787 Google, 9788 GitHub, 9789 crawler-manager, 9790 scheduler-manager, 9791 user-vault, 9792 newscast |
| `web` | Vite 개발 서버(https) | 5174 |

포트는 Docker 호스트의 `127.0.0.1`에만 연다. 브라우저는 `localhost`로 붙는다. Google은 callback으로 IP 주소를 받지 않기 때문이다.

`web`의 `VITE_*_WORKER_URL`은 위 포트의 `localhost` 주소다(`VITE_NEWSCAST_WORKER_URL`은 `http://localhost:9792`). share-viewer(공개 공유 화면)는 이 환경에 없다. 공유 링크를 열어 보려면 `applications/share-viewer`를 따로 띄우고 `VITE_SHARE_VIEWER_URL`을 그 주소로 준다.

워커를 컨테이너 하나에 모은 이유: `wrangler dev`는 다른 `wrangler dev` 프로세스의 워커를 로컬 dev registry로 찾는다. registry에는 워커마다 `127.0.0.1:<포트>`(그 워커의 workerd debug port)가 적히는데, 컨테이너끼리는 `127.0.0.1`을 나눠 쓰지 않아서 컨테이너를 나누면 service binding이 이어지지 않는다.

워커 컨테이너가 시작할 때 하는 일(`docker/workers/start-workers.ts`):
- 워커마다 `.dev.vars.docker`를 컨테이너 안에 쓴다. 값은 `docker/.env.docker`에서 온다. 이미지에는 secret이 없다.
- 워커 여섯 개가 모두 `SUPABASE_URL`과 `SUPABASE_SECRET_KEY`를 받는다. user-vault도 암호화한 provider key와 환경 변수를 이 환경의 DB에 둔다.
- `SUPABASE_SECRET_KEY`는 `POSTGREST_JWT_SECRET`으로 서명한 `role: service_role` JWT다. `SUPABASE_URL`은 `http://gateway:8000`, 로그인 워커의 `FRONTEND_URL`은 `https://localhost:5174`다. 로그인 워커의 `AXIOM_API_TOKEN`은 Axiom이 받지 않는 고정값(`docker-environment-sends-no-traces`)이다.
- R2·KV·Workflow 데이터는 `worker-state` 볼륨의 워커별 디렉터리(`/worker-state/<워커 디렉터리>`)에 둔다. 그래서 Google과 GitHub 워커는 같은 KV id(`docker-oauth-state`)를 써도 로컬 데이터는 따로다.

## 1. `docker/.env.docker` 만들기

1Password에서 만든다(`tools/environment-generator/README.md`).

```bash
eval $(op signin)
OP_SERVICE_ACCOUNT_TOKEN=$(pnpm run --silent environment:setup) pnpm run environment:generate docker
```

들어가는 값: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `CODE_RUNNER_FUNCTION_URL`, `JWT_SECRET`, `VAULT_INTERNAL_TOKEN`, `PROVIDER_KEY_KEK`, `POSTGREST_JWT_SECRET`. `POSTGREST_JWT_SECRET`은 32자 이상이어야 한다(PostgREST 조건). 예전에 만든 파일에 `AXIOM_API_TOKEN`이 남아 있어도 어느 서비스에도 넘어가지 않는다. 지워도 된다.

compose는 이 파일을 env file로 읽고(3절), 서비스마다 `compose.yaml`의 `environment`에 적힌 값만 넘긴다.

| 서비스 | 받는 값 |
| -- | -- |
| `rest` | `POSTGREST_JWT_SECRET`(PostgREST가 읽는 이름 `PGRST_JWT_SECRET`으로) |
| `web` | `GOOGLE_CLIENT_ID`(웹이 읽는 이름 `VITE_GOOGLE_CLIENT_ID`로) |
| `workers` | 나머지 전부. 워커마다 쓰는 것만 `.dev.vars.docker`에 나눠 쓴다 |
| `database`, `migrate`, `gateway` | 없음 |

## 2. 이 컴퓨터에서 m6의 Docker 엔진 쓰기

이 컴퓨터는 느려서 m6(`192.168.100.4`)의 Docker를 쓴다. m6의 비대화형 SSH에는 `docker` 명령이 없으므로, m6의 엔진 socket을 이 컴퓨터로 넘겨받아 이 컴퓨터의 `docker`로 부른다.

```bash
ssh -i ~/.ssh/mini.m6.id_rsa -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes -o StreamLocalBindUnlink=yes \
  -N -L "$HOME/.docker/m6.sock:/Users/mini/.docker/run/docker.sock" mini@192.168.100.4 &
export DOCKER_HOST="unix://$HOME/.docker/m6.sock"
docker version   # Server가 linux/arm64로 나오면 된다
```

m6는 arm64이고 Docker VMM이라 Rosetta가 없다. 여기서 쓰는 이미지(`node:26-trixie-slim`, `postgres:17-trixie`, `postgrest/postgrest:v14.18`, `nginx:1.30-alpine`)는 모두 linux/arm64 판이 있다.

원격 엔진에서는 bind mount가 m6의 경로를 가리킨다. 그래서 소스는 이미지에 넣어 build하고, 고친 것은 `watch`로 넣는다.

## 3. 띄우기

저장소 루트에서 실행한다. compose가 읽을 파일을 셸마다 한 번 정해 두면, 뒤의 명령에는 따로 붙이지 않는다.

```bash
export COMPOSE_ENV_FILES="$PWD/docker/.env.docker"
docker compose -f docker/compose.yaml up --build
```

처음에는 `database`가 역할을 만들고, `migrate`가 migration을 적용한 뒤 끝나고, 그다음 `rest`, `gateway`, `workers`, `web`이 뜬다.

`COMPOSE_ENV_FILES`는 `--env-file`을 쓰지 않을 때 compose가 읽을 env file을 정하는 환경 변수다([Docker 문서](https://docs.docker.com/compose/how-tos/environment-variables/envvars/)). compose는 명령마다 `compose.yaml`을 읽으며 이 파일의 값을 채워 넣고, `rest`와 `workers`가 `POSTGREST_JWT_SECRET`을 꼭 요구한다. 그래서 `up`뿐 아니라 이 환경의 compose 명령(`watch`, `down`, `logs`, `ps` 등)이 모두 이 파일을 읽어야 한다.
- 상대 경로는 명령을 실행하는 디렉터리 기준이다(Compose 5.6.0에서 확인). 절대 경로로 적으면 어느 디렉터리에서 불러도 된다.
- `--env-file`을 같이 쓰면 그쪽이 먼저다. 같은 이름의 셸 환경 변수가 있으면 그 값이 파일보다 먼저다.
- 파일이 없으면 `couldn't find env file: …`로, 파일에 `POSTGREST_JWT_SECRET`이 없으면 `required variable POSTGREST_JWT_SECRET is missing a value`로 compose가 시작 전에 멈춘다. 1절로 파일을 만든다.
- `COMPOSE_ENV_FILES`가 있으면 compose는 프로젝트 디렉터리의 `.env`를 읽지 않는다. 같은 셸에서 다른 compose 프로젝트를 쓸 때는 먼저 `unset COMPOSE_ENV_FILES`를 한다.

## 4. 고치면서 쓰기: `watch`

```bash
docker compose -f docker/compose.yaml watch
```

`up --build --watch`로 띄워도 된다. 원격 엔진에서도 동작한다.
- `workers/`, `packages/`, `applications/web/`의 소스를 고치면 컨테이너로 바로 넣는다(sync). `wrangler dev`와 Vite가 바뀐 파일을 보고 다시 읽는다.
- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`을 고치면 이미지를 다시 build한다(rebuild).
- migration 파일을 더하면 `migrate`를 다시 build해서 돌린다. 새 파일만 적용된다.

## 5. 이 컴퓨터의 localhost로 포트 넘겨받기

compose를 m6에서 띄웠으면 웹과 워커 포트를 한 번에 넘겨받는다.

```bash
ssh -i ~/.ssh/mini.m6.id_rsa -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes -N \
  -L 5174:127.0.0.1:5174 -L 9787:127.0.0.1:9787 -L 9788:127.0.0.1:9788 \
  -L 9789:127.0.0.1:9789 -L 9790:127.0.0.1:9790 -L 9791:127.0.0.1:9791 \
  -L 9792:127.0.0.1:9792 mini@192.168.100.4
```

그다음 `https://localhost:5174`를 연다. 인증서는 Vite가 만든 자체 서명이라 처음 한 번 경고가 뜬다.

로그인 워커는 OAuth `redirect_uri`를 요청이 들어온 주소로 만든다(`<요청 origin>/callback`). 브라우저가 `localhost:9787`·`localhost:9788`로 붙으므로 provider에 가는 주소는 `http://localhost:9787/callback`(Google), `http://localhost:9788/callback`(GitHub)이다. 두 주소는 Google OAuth client와 GitHub OAuth App에 등록돼 있어야 한다.

## 6. 데이터 지우기

```bash
docker compose -f docker/compose.yaml down -v
```

DB 볼륨(`database-data`)과 워커 로컬 저장소 볼륨(`worker-state`)이 지워진다. 다음 `up`은 빈 DB에 역할과 migration부터 다시 만든다.

## 7. 다른 checkout에서 띄우기

compose 프로젝트 이름은 `compose.yaml`에 `audio-underview`로 고정돼 있다. 그래서 같은 엔진에서 다른 checkout(다른 worktree 등)으로 같은 명령을 부르면 같은 컨테이너와 볼륨을 쓰고, 한쪽의 `down -v`가 다른 쪽 데이터도 지운다. 다른 checkout에서는 `-p`로 이름을 바꾼다. `-p`가 `compose.yaml`의 이름보다 먼저다(`COMPOSE_PROJECT_NAME` 환경 변수도 된다).

```bash
export COMPOSE_ENV_FILES="$PWD/docker/.env.docker"
docker compose -p audio-underview-second -f docker/compose.yaml up --build
```

`COMPOSE_ENV_FILES`는 절대 경로라서, 첫 checkout에서 설정한 셸을 그대로 쓰면 그 checkout의 `.env.docker`를 읽는다. 그래서 그 checkout의 루트에서 다시 설정하거나 새 셸을 연다. 그 checkout의 compose 명령마다 같은 `-p`를 붙인다. 포트(5174, 9787~9792)는 이름과 상관없이 같아서 둘을 동시에 띄울 수는 없다. 한쪽을 `stop`이나 `down`(볼륨은 남음)으로 내린 뒤 다른 쪽을 띄운다.

## 알아 둘 것

- DB는 PostgREST만 붙인다. Supabase Auth·Storage·Realtime·Edge Functions는 없다. 워커는 supabase-js로 테이블과 `rpc`(`set_scheduler_next_runs`, `fail_scheduler_runs`, `reorder_scheduler_stages`, `delete_expired_crawler_files`, `delete_crawler_file_deletions`)만 부르므로 PostgREST로 충분하다.
- DB 비밀번호(`postgres`, `authenticator`)는 `compose.yaml`에 적힌 고정값이다. DB와 PostgREST 포트는 밖에 열지 않아서 compose 망 안에서만 닿는다.
- `migrate`는 `postgres`로 접속해 파일마다 transaction 하나로 적용한다(운영 migration workflow처럼 파일 하나가 한 번의 실행이다). 새 테이블에는 기본 권한으로 `service_role` 권한이 붙는다.
- `wrangler dev`는 cron을 저절로 돌리지 않는다. crawler-manager의 파일 정리와 scheduler-manager의 스케줄 확인은 포트를 넘겨받은 뒤(5절) 손으로 부른다: `curl "http://localhost:9789/cdn-cgi/local/scheduled"`, `curl "http://localhost:9790/cdn-cgi/local/scheduled"`.
