# 환경 설계: staging·development·local·docker

작성일 2026-10-19. 기준 코드는 `main`(`f30ecf4`)이다. Linear TES-255의 "staging 한 벌"에 development·local·docker 환경을 더했다.

## 1. 목표와 범위

환경은 다섯이다. 모두 같은 소스를 설정만 바꿔 띄운다.

| 환경 | 어디서 | 데이터 | 띄우는 때 |
| -- | -- | -- | -- |
| production | Cloudflare·Supabase 클라우드 | 운영 데이터(`public` schema) | 머지하면 지금처럼 |
| staging | 클라우드 | 배포할 때마다 production 데이터를 복사하고, 그 위에 PR의 새 migration을 적용(`staging` schema) | PR에 push할 때마다 그 PR의 코드 |
| development | 클라우드 | production과 무관한 개발 데이터. 배포해도 남는다(`development` schema) | 브랜치를 골라 손으로(`workflow_dispatch`) |
| local | 내 컴퓨터(`wrangler dev`, Vite) | 클라우드의 `development` schema를 development와 같이 씀 | 개발할 때(6절) |
| docker | Docker 엔진(이 Mac은 느려서 m6의 Docker를 원격으로 씀) | 컨테이너 안의 DB. 클라우드와 완전히 분리 | `docker compose up`(7절) |

staging은 git rebase와 같다. 바탕은 언제나 지금의 production이고, PR이 바꾼 것만 그 위에 얹는다. staging에서 만든 데이터는 다음 배포 때 사라진다.

docker는 클라우드 없이 웹·워커·DB 전체를 compose 한 번으로 띄우는 환경이다. 데이터가 클라우드와 섞이지 않고, 지우고 다시 만들기 쉽다.

이것으로 풀리는 것:
- PR의 preview에서 로그인이 된다(지금은 400 `redirect_uri is not an allowed origin`).
- preview와 개발이 운영 데이터를 바꾸지 않는다.
- PR이 바꾼 워커·API·migration을, 운영과 같은 데이터 위에서 머지 전에 확인한다(PR #37·#38에서 못 했던 것).

정한 것:
- staging과 development는 각각 한 벌이다. 한 번에 한 브랜치가 쓰고, 마지막에 배포한 브랜치가 덮는다.
- PR마다 생기던 `<브랜치>.audio-underview.pages.dev` preview는 없앤다. PR 빌드는 staging 주소로만 배포한다.
- 범위 밖: PR마다 따로 띄우는 백엔드(Workers Previews), 배포되지 않은 로그인 워커 13개와 crawler-code-runner-worker의 staging·development.

## 2. 구성

환경을 나누는 워커는 웹이 부르는 다섯 개다: crawler-manager, scheduler-manager, user-vault(crawler-manager만 부름), Google·GitHub 로그인 워커.

| | production | staging | development |
| -- | -- | -- | -- |
| 웹 | `audio-underview.pages.dev` | `staging.audio-underview.pages.dev` | `development.audio-underview.pages.dev` |
| 워커 | `audio-underview-<이름>-worker` | `…-staging-worker`(`--env staging`) | `…-development-worker`(`--env development`) |
| Supabase | 같은 프로젝트, `public` | 같은 프로젝트, `staging` | 같은 프로젝트, `development` |
| R2·KV | 지금 것 | staging용 새 자원 | development용 새 자원 |
| user-vault 저장소 | Supabase `public`의 vault 테이블 | `staging`의 vault 테이블(복사하지 않음) | `development`의 vault 테이블 |
| Workflow | `audio-underview-scheduler-run-workflow` | `…-staging-workflow` | `…-development-workflow` |
| 코드 실행 Lambda | 지금 것 | 같이 씀(데이터를 저장하지 않음) | 같이 씀 |
| `JWT_SECRET` | 지금 값 | 새 값 | 새 값 |
| 허용 목록 | `https://audio-underview.pages.dev` | `https://staging.audio-underview.pages.dev` | `https://development.audio-underview.pages.dev`, `https://localhost:5173` |
| 로그인 | 지금 Google OAuth client·GitHub OAuth App | 같은 client·App에 staging callback 추가 | 같은 client·App에 development callback 추가 |
| Axiom | `audio-underview` dataset | 같은 dataset | 같은 dataset |

세 웹 주소는 모두 같은 Pages 프로젝트(`audio-underview`)다. staging과 development는 `--branch=staging`, `--branch=development`로 배포한 고정 주소다.

Workflow 이름은 Cloudflare 계정 단위라 환경마다 달라야 한다. `JWT_SECRET`을 환경마다 다르게 두는 이유는 토큰에 iss·aud가 없어서다. 같으면 한 환경의 토큰이 다른 환경에서도 통한다.

허용 목록은 지금처럼 정확히 일치로 두고, origin 비교 코드는 고치지 않는다. production에서는 지금 들어 있는 `http://localhost:5173`을 뺀다. 로컬 웹이 운영 데이터에 쓰지 못하게 하려는 것이다. 로컬 웹은 `@vitejs/plugin-basic-ssl` 때문에 `https://localhost:5173`으로 뜨므로, development 허용 목록에는 `https://` 주소를 둔다. 로컬 워커는 development 설정을 그대로 쓰므로, 클라우드 development 워커도 localhost를 받는다. `.dev.vars.development`의 값은 `[vars]`를 덮어쓴다(wrangler 4.151에서 확인). 하지만 문서에 없는 동작이라 기대지 않고, 로컬만 다른 허용 목록은 두지 않는다.

GitHub OAuth App은 2026-08-14부터 callback을 10개까지 둘 수 있다. Google은 한 client에 여러 개를 둘 수 있다.

## 3. 코드 변경

**connector가 schema를 받는다.** `SupabaseConnectorConfiguration`(`packages/supabase-connector/sources/types/database.ts:340`)에 `schema: string`을 더하고, `createSupabaseClient`(`sources/client.ts:11`)가 `db: { schema }`로 넘긴다. supabase-js는 이 값을 `Accept-Profile`·`Content-Profile` header로 보내고, PostgREST는 그 schema만 search_path에 넣는다. `Database` 타입은 `public` 기준이므로, 프로토타입처럼 schema 이름을 `'public'`으로 단언해 넘긴다. 테이블 구조는 세 schema가 같다.

**`schema`는 생략할 수 없게 한다.** 기본값을 `public`으로 두면, 한 곳이라도 넘기기를 잊었을 때 staging·development 워커가 운영 테이블에 쓴다. 세 환경이 같은 Supabase 키를 쓰므로 막아 줄 것이 없다. 생략할 수 없게 하면 빠진 곳을 typecheck가 잡는다. 실행 때도 막는다. 어떤 환경 블록에서 `SUPABASE_SCHEMA`가 빠지면 값이 `undefined`로 들어오고, supabase-js는 header를 보내지 않아 PostgREST가 첫 노출 schema인 `public`을 쓴다. 그래서 `createSupabaseClient`는 schema가 SQL 이름 모양(`^[a-z_][a-z0-9_]*$`)이 아니면 요청 전에 오류를 낸다.

**테스트로 붙잡아 둔다.** 다섯 워커에 `tests/wrangler-environments.test.ts`를 둔다. 운영과 각 환경의 이름, `SUPABASE_SCHEMA`, 허용 목록, cron, 그리고 어떤 환경도 운영 자원(워커·bucket·KV·Workflow)을 다시 쓰지 않는지를 `wrangler.toml`에서 읽어 확인한다. crawler-manager, scheduler-manager, user-vault는 `createSupabaseClient` 호출을 모두 세어, 모든 호출이 환경의 `SUPABASE_SCHEMA`를 넘기는지 본다.

**워커는 `SUPABASE_SCHEMA` 변수를 읽는다.** `wrangler.toml`의 `[vars]`에 `SUPABASE_SCHEMA = "public"`을, `[env.staging.vars]`에 `"staging"`을, `[env.development.vars]`에 `"development"`를, `[env.docker.vars]`에 `"public"`(컨테이너 안 DB)을 둔다. `createSupabaseClient`를 부르는 곳은 crawler-manager 7곳, scheduler-manager 20곳, user-vault, 로그인 워커 15개에 있다.

**user-vault는 D1 대신 Supabase를 쓴다(2026-10-20 결정).** 사용자의 AI 제공자 키(`provider_keys`), 크롤러 환경 변수(`environment_variables`), 키 사용 기록(`key_audit_log`)을 migration 015로 `public`에 만든다. 값은 지금처럼 KEK로 감싼 키로 암호화하고, KEK는 user-vault에만 있다. 다른 워커가 같은 키로 테이블을 읽어도 풀 수 없다. 운영 D1에는 테이블 두 개가 있지만 행이 없어서 옮길 데이터가 없었다. 그래서 D1 binding, `schema.sql`, CI의 D1 단계, docker의 D1 적용을 없앴다. 환경마다 vault 값은 따로 등록한다. 모두 `schema: environment.SUPABASE_SCHEMA`를 넘긴다. 배포하지 않는 로그인 워커 13개도 typecheck를 위해 같이 고친다.

**`[env.staging]`, `[env.development]`, `[env.docker]`를 다섯 워커의 `wrangler.toml`에 더한다.** 이어지지 않는 설정(vars, KV·R2, services, workflows, worker_loaders)은 환경마다 모두 다시 적는다. main, compatibility 설정, workers_dev, observability, cron은 이어진다(wrangler 4.151에서 확인). 운영 `wrangler deploy`는 `--env` 없이 돌므로, 환경이 생긴 뒤에는 경고만 하나 더 나오고 그대로 운영에 배포된다.
- staging scheduler-manager는 `crons = []`로 cron을 끈다. 복사한 production 스케줄이 staging에서 한 번 더 돌면, 외부 크롤링과 나중의 뉴스캐스트 TTS 요금이 두 번 든다. staging에서는 Run now로만 돌린다.
- development scheduler-manager는 cron을 그대로 둔다. development 스케줄은 development 데이터다.
- crawler-manager의 cron(15분마다 R2 정리)은 세 환경 모두 그대로 둔다.

워커 이름은 `audio-underview-<이름>-<env>-worker`다. wrangler는 이름을 적지 않으면 `<이름>-<env>`(`…-worker-staging`)로 배포하므로, 환경마다 `name`을 적는다. Workflow 이름도 같은 규칙(`…-staging-workflow`)이다. 이름에 종류가 없는 R2 bucket과 KV namespace는 끝에 `-<env>`를 붙인다.

crawler-manager의 staging 예:

```toml
[env.staging]
name = "audio-underview-crawler-manager-staging-worker"

[env.staging.vars]
ALLOWED_ORIGINS = "https://staging.audio-underview.pages.dev"
SUPABASE_SCHEMA = "staging"

[[env.staging.worker_loaders]]
binding = "LOADER"

[[env.staging.r2_buckets]]
binding = "CRAWLER_FILES"
bucket_name = "audio-underview-crawler-files-staging"

[[env.staging.services]]
binding = "USER_VAULT"
service = "audio-underview-user-vault-staging-worker"
```

워커 로직은 바꾸지 않는다. 웹 코드도 바꾸지 않는다(주소는 build 때 넣는다).

## 4. schema 만들기

`tools/environment-schema`에 Node 스크립트(`node scripts/build-environment-schema.ts <staging|development> [--reset]`)를 둔다. Supabase Management API `POST /v1/projects/{ref}/database/query`(SQL 실행, 문서상 beta)로, 한 번의 실행을 한 transaction 안에서 돌린다. 중간에 실패하면 이전 schema가 그대로 남는다. schema 이름은 `staging`과 `development`만 받고, `public`에 쓰는 SQL은 만들지 않는다.

**migration 파일을 다른 schema에 적용하는 법.** 파일마다 앞에 `SET LOCAL search_path TO <이름>;`를 붙이고, 본문의 `public.`을 `<이름>.`으로 바꿔 실행한다.
- 이름을 schema 없이 적은 문장(`CREATE TABLE crawlers`)은 search_path 때문에 그 schema에 생긴다.
- 011·012·013의 함수 6개는 `SET search_path = ''`로 실행되고 테이블을 `public.scheduler_runs`처럼 적는다. 바꾸지 않으면 staging 함수가 운영 테이블을 고친다. 지금 파일에서 `public.`은 이 함수들의 8줄에만 있다.
- `public . x`, `"public"."x"`처럼 점 앞뒤에 공백이 있거나 따옴표를 친 것도 바꾼다. `FROM PUBLIC`(역할)과 `nonpublic.`은 그대로 둔다.
- 앞으로 migration은 테이블을 schema 없이 쓰거나 `public.`으로만 쓴다. 다른 schema는 쓰지 않는다.
- 바꾸기로 다른 schema로 돌릴 수 없는 문장이 있으면 SQL을 보내기 전에 거절하고 파일과 줄을 알린다: `SCHEMA public`(GRANT·DROP 등), `public`이 든 search_path나 `set_config`, search_path를 기본값으로 되돌리는 문장(`RESET`, `DISCARD`, `TO DEFAULT`), `IN SCHEMA` 없는 `ALTER DEFAULT PRIVILEGES`, transaction을 끊는 문장(`BEGIN`, `COMMIT`, `ROLLBACK`, `AND CHAIN` 등). 지금 파일 14개에는 없다.

**권한.** Supabase는 2026-10-30부터 기존 프로젝트도 새로 만드는 테이블·sequence에 Data API 역할(anon, authenticated, service_role)의 권한을 저절로 주지 않는다. 그 전에 있던 테이블은 권한을 지킨다. 운영 `public`은 001~014로 만들었고 모두 그 전에 적용됐다(014는 2026-10-18). staging과 development가 운영과 같게 굴도록 아래처럼 한다.
- schema에는 `GRANT USAGE ON SCHEMA <이름> TO service_role;`만 준다. 기본 권한(`ALTER DEFAULT PRIVILEGES`)은 두지 않는다. 그러면 새 테이블은 migration이 직접 준 권한만 가진다.
- staging: 복사 뒤, production에도 있는 테이블·view·sequence마다 anon, authenticated, service_role이 `public`에서 가진 권한을 그대로 준다(`aclexplode(relacl)`로 읽음, grant option 포함). 그다음 PR의 새 migration을 적용한다. 열 단위 권한과 그 밖의 역할은 옮기지 않으므로, 차이가 나면 staging이 더 엄격하다.
- development: 001~014가 만든 테이블에만 `GRANT ALL … TO service_role`을 준다. anon과 authenticated는 주지 않는다. 예전 도구가 남긴 기본 권한은 지운다.
- 015부터의 migration은 만드는 테이블마다 같은 파일 안에 `GRANT … ON TABLE <테이블> TO service_role`이 있어야 한다. 없으면 SQL을 보내기 전에 거절하고 파일과 테이블을 알린다. 그 GRANT는 파일을 적용할 때 실행되는 자리(맨 바깥이나 DO 블록, 함수 본문은 안 됨)에 있고, 열 목록이 없고, 테이블을 만든 뒤에 와야 센다. `ON ALL TABLES IN SCHEMA public`은 `public`을 직접 적는 문장이라 거절된다. 이 검사는 테이블만 본다. view·sequence는 보지 않는다. 기준 번호는 도구의 `LAST_MIGRATION_WITH_AUTOMATIC_GRANTS`(14)다.

**staging: 배포할 때마다 production에서 다시 만든다.**
1. `DROP SCHEMA IF EXISTS staging CASCADE; CREATE SCHEMA staging;`와 권한.
2. production에 이미 적용된 migration을 번호 순서대로 적용한다. production 적용 기록은 `GET /v1/projects/{ref}/database/migrations`의 이름으로 본다(지금 migration workflow와 같은 이름 규칙: 파일 이름에서 번호를 뗀 것).
3. production 테이블의 행을 복사한다: `INSERT INTO staging.<테이블> (<열>) SELECT <열> FROM public.<테이블>`.
   - 먼저 staging 테이블을 비운다. 010이 system user와 system crawler를 무작위 ID로 넣고 007·010이 권한을 채우므로, 비우지 않으면 production 행과 키가 겹친다. 비운 뒤에는 staging이 production 행과 똑같다.
   - 열은 두 테이블에 다 있는 것만 쓴다. enum은 schema마다 따로인 타입이라, 타입이 다른 열은 text를 거쳐 바꾼다.
   - 외래 키 순서는 `pg_constraint`로 정한다(자기 참조는 되고, 순환이면 실패). `crawler_file_deletions`(R2 삭제 대기열)는 복사하지 않는다.
   - 적용한 파일이 만드는 테이블만 복사하고, 그중 하나라도 staging에 없으면 실패한다. production에 손으로 만든 테이블은 건너뛰고 요약에 적는다.
4. production에 아직 없는 migration(그 PR이 더한 것)을 번호 순서대로 적용한다.
5. `NOTIFY pgrst, 'reload schema'`. 그리고 확인한다: 함수 본문이나 함수의 `SET search_path`에 `public`이 남아 있지 않은지, 파일이 만드는 테이블이 모두 있는지. 함수 검사는 본문 전체를 보므로 주석에 `public.`을 써도 걸리고, 실행 때 이어 붙이는 SQL은 보지 못한다.

production은 2·3번에서 읽기만 한다. metadata(테이블, 외래 키)는 transaction 전에 `read_only: true`로 읽는다.

production 적용 기록이 파일과 맞지 않으면 staging이 production 행 없이 만들어지면서도 성공한 것처럼 끝난다. 그래서 SQL을 보내기 전에 거절하는 경우:
- production이 적은 이름 중 파일이 있는 것이 하나도 없을 때(이름 규칙이 다름)
- production에 테이블은 있는데 적용 기록이 비었을 때
- 적용 기록은 있는데 읽은 테이블이 하나도 없을 때
- 적용한 파일이 production 테이블을 하나도 만들지 않을 때
- production에 이미 있는 테이블을, production 기록에 없는 파일만 만들 때(기록이 잘림)

복사한 행 수가 돌아오지 않으면 요약에 "unknown"이라고 적는다.

**development: 데이터를 남기고 새 migration만 적용한다.**
- `development.schema_migrations(name, applied_at)`에 적용 기록을 둔다. 이름은 production과 같은 규칙(번호를 뗀 파일 이름)이다. 배포할 때 기록에 없는 파일만 번호 순서대로 적용한다. 적용할 것이 없으면 SQL을 보내지 않는다.
- 기록에 있는데 파일이 없는 이름이 있으면 실패하고 `--reset`을 쓰라고 알린다. schema는 있는데 기록 테이블이 없을 때도 같다.
- `--reset`이면 schema를 지우고 001부터 다시 만든다. 데이터는 비워진다. 브랜치의 migration이 바뀌거나 사라져서 기록과 맞지 않을 때 쓴다.
- 처음 배포하면 schema가 없으므로 `--reset`과 같다.
- 5번의 확인은 development에도 한다.

**노출 목록.** Data API가 두 schema를 받도록 노출 schema 목록에 더한다. 노출은 `ALTER ROLE authenticator SET pgrst.db_schemas = …`로 한다. 프로토타입 때 이 role 설정을 썼고, 이 설정은 대시보드 설정보다 먼저 쓰인다. 지금 값을 먼저 읽고 붙인다.
- 목록에는 **이미 있는 schema만** 넣는다. 2026-10-21에 아직 없던 `development`를 넣고 schema cache를 다시 읽게 했다. 그러자 PostgREST가 cache를 만들지 못해(`PGRST002`) 운영 `public`까지 Data API 전체가 1~2분 멈췄다. `development`를 빼자 바로 돌아왔다.
- 그래서 `staging`은 2026-10-21에 더했다(`public, graphql_public, prototype, staging`). `development`는 머지 뒤 첫 development 배포로 schema가 생긴 다음에 더한다.
- staging 재구성의 `DROP SCHEMA … CASCADE; CREATE SCHEMA …`는 한 transaction이라, 다른 연결에서는 schema가 사라진 순간이 보이지 않는다. 노출된 schema를 따로 지우면 같은 장애가 나므로, 지울 때는 먼저 목록에서 뺀다.

## 5. CI

**`deploy-staging.yml`(새로).** `pull_request`(main 대상, opened·synchronize·reopened)에서 돈다. 문서만 바꾼 PR과 fork PR은 건너뛴다. concurrency group은 `deploy-staging` 하나다(fork PR은 따로 둬서 대기 중인 실행을 밀어내지 않게 한다). `cancel-in-progress: false`로 두어 배포가 반쯤 끝난 채 끊기지 않게 한다.
1. schema: `build-environment-schema.ts staging`. `secrets.SUPABASE_ACCESS_TOKEN`, `vars.SUPABASE_PROJECT_ID`.
2. (없앰) 처음에는 user-vault D1에 `schema.sql`을 적용했지만, user-vault가 Supabase를 쓰게 되면서 이 단계가 없어졌다. vault 테이블은 1번 schema 단계에서 migration 015로 생긴다. CI의 Cloudflare token에는 D1 권한이 필요 없다.
3. 워커 다섯 개: `wrangler deploy --env staging`.
   - service binding 대상이 먼저 있게 user-vault → crawler-manager → scheduler-manager 순서로, 로그인 워커 둘은 나란히 배포한다.
   - 로그인 워커는 지금 운영 job처럼 `secrets`로 client ID·secret과 `FRONTEND_URL`(그 환경의 웹 주소)을 올린다.
   - PR이 워커를 바꾸지 않았어도 매번 다섯 개를 다 올린다. 다른 브랜치의 워커가 남아 있지 않게 하려는 것이다.
4. 웹: staging 주소(`vars.STAGING_*`)로 build하고 `pages deploy --branch=staging`. PR에 staging 주소와 "이 PR이 staging에 올라감"을 댓글로 남긴다.

**`deploy-development.yml`(새로).** `workflow_dispatch`로 돈다. 입력은 배포할 브랜치(Actions 화면의 "Use workflow from")와 `reset`(기본 false)이다. 순서는 staging과 같고, schema 단계가 `build-environment-schema.ts development`(`reset`이면 `--reset`)이다. 웹은 `pages deploy --branch=development`. concurrency group은 `deploy-development`. `workflow_dispatch` workflow는 파일이 main에 있어야 실행할 수 있으므로, development 배포는 이 작업을 머지한 뒤부터 쓴다. 이 PR의 확인은 staging으로 한다.

**`deploy-web.yml`.** `pull_request` trigger를 지운다. 운영 배포(main에서 Deploy: Affected Workspaces가 시작)만 남는다.

두 workflow는 한 파일의 재사용 workflow(`deploy-environment.yml`, `workflow_call`)로 묶고, 환경 이름만 넘긴다. 운영 배포 흐름은 바꾸지 않는다.

`--env`를 빠뜨리면 운영 워커를 덮어쓰므로, 아래로 막는다.
- wrangler 단계마다 `cloudflare/wrangler-action`의 `environment` 입력과 명령의 `--env`를 함께 적는다. action은 명령에 `--env`가 없을 때만 붙이고, secret 업로드에는 `environment` 입력만 쓴다(v3.15.0 source에서 확인). 그래서 배포와 secret 업로드에 `--env`가 정확히 한 번씩 붙는다.
- 첫 job(validate)이 배포 전에 확인한다: `<환경>_*` 변수가 비어 있지 않고 운영 변수와 다른지, 다섯 워커의 `wrangler.toml`에 `[env.<환경>]`과 `name = "audio-underview-<이름>-<환경>-worker"`가 있는지. wrangler는 설정에 없는 환경 이름을 받으면, 다른 환경이 하나도 없을 때 경고만 하고 운영 바인딩으로 배포하기 때문이다.
- staging 웹 배포에는 `gitHubToken`을 넘기지 않는다. 넘기면 GitHub의 `preview` environment에 deployment가 생기는데, 이제 그것을 정리할 것이 없다. PR 댓글에는 고정 주소만 적는다. 배포마다 생기는 `<hash>.audio-underview.pages.dev`는 허용 목록에 없어 로그인이 안 된다.
- 첫 배포 때 워커가 아직 없으면 `secret bulk`가 빈 워커를 먼저 만들고, 뒤의 배포가 그것을 바꾼다(wrangler 4.151 source에서 확인).

`deactivate-preview.yml`은 지운다. `preview` environment의 deployment를 끄던 것인데, 이제 거기에 배포하는 것이 없다.

**`test-tools.yml`(새로).** PR에서 `tools/environment-schema`와 `tools/deployment-planner`의 typecheck·테스트를 돌린다. schema 도구가 공유 DB에 무엇을 쓸지 정하기 때문이다. deployment-planner 테스트도 지금까지 CI에서 돌지 않았다.

## 6. 로컬 개발

로컬 웹(`pnpm --filter @audio-underview/web dev`, `https://localhost:5173`)은 로컬에서 띄운 워커를 부른다.

| | 로컬 |
| -- | -- |
| 띄우기 | 루트 `pnpm dev` 하나로 웹(Vite)과 워커 다섯 개를 함께 띄운다. 지금 `pnpm dev`는 turbo로 모든 패키지의 `dev`를 띄우므로(로그인 워커 15개 포함), 이 여섯 개만 띄우게 `--filter`를 단다. 다섯 워커의 `dev` script는 `wrangler dev --env development --port <포트> --inspector-port <포트>`로 바꾼다. 다섯을 한꺼번에 띄우면 모두 inspector 기본 포트 9229를 고르다 `Address already in use`로 죽기 때문에, inspector 포트를 9330~9334로 고정한다 |
| 포트 | Google 8787, GitHub 8788, crawler-manager 8789, scheduler-manager 8790, user-vault 8791로 고정한다. 로그인 callback이 `http://localhost:<포트>/callback`이라, 바뀌면 다시 등록해야 한다 |
| Supabase | 클라우드의 `development` schema(클라우드 development 워커와 같은 데이터) |
| R2·KV·Workflow | `wrangler dev`의 로컬 저장소(`.wrangler/state`). 클라우드 자원은 건드리지 않는다. user-vault의 테이블은 클라우드 `development` schema에 있다. 따로 띄운 워커끼리도 service binding이 이어지고, Dynamic Workers와 Workflow도 로컬에서 돈다(확인함). cron은 저절로 돌지 않아 wrangler가 알려 주는 주소로 직접 부른다 |
| secret | 워커마다 `.dev.vars.development`. `--env development`로 띄우면 이 파일만 읽는다 |
| 웹 주소 설정 | 로컬 워커 주소는 비밀이 아니므로 `applications/web/.env.development`에 적어 commit한다. Vite가 개발 서버에서만 읽는다. `VITE_GOOGLE_CLIENT_ID`는 `.env.development.local`(gitignore됨)에 둔다 |

`.dev.vars.development`에 넣는 값:
- crawler-manager, scheduler-manager, 로그인 워커 둘: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `JWT_SECRET`(development 값. 로컬 워커끼리 같아야 한다)
- 로그인 워커: client ID·secret, `FRONTEND_URL=https://localhost:5173`, `AXIOM_API_TOKEN`
- crawler-manager: `CODE_RUNNER_FUNCTION_URL`, `VAULT_INTERNAL_TOKEN`
- user-vault: `PROVIDER_KEY_KEK`, `VAULT_INTERNAL_TOKEN`

이 파일들은 `tools/environment-generator`(`pnpm environment:generate [development|docker]`)가 1Password에서 만든다. 파일 권한은 600이다. 예전 출력(`applications/web/.env`, `.env.workers`, `.env.deploy`)은 읽는 곳이 없어서 없앴다. 1Password 참조:
- 공유: `Supabase`(URL, secret key), `Google OAuth`·`GitHub OAuth`(client ID, client secret), `Axiom`(Log Ingest API token), `Crawler Code Runner Function`(URL)
- 환경마다: `Development Environment`·`Docker Environment`(JWT secret, vault internal token, provider key KEK. docker는 PostgREST JWT secret도)

`.gitignore`는 지금 `.dev.vars`만 막는다. `.dev.vars.*`를 더한다.

## 7. docker 환경

`docker/compose.yaml` 하나로 아래를 띄운다. 쓰는 법은 `docker/README.md`에 있다. 클라우드 자원(DB, R2, KV, Workflow)은 쓰지 않는다. 워커가 밖으로 부르는 것은 Google·GitHub 로그인과 토큰 확인, 코드 실행 Lambda(데이터를 저장하지 않음), 크롤러 코드가 부르는 주소와 그 DNS 조회(`cloudflare-dns.com`), user-vault가 저장한 키를 확인할 때의 provider API다.

```
export COMPOSE_ENV_FILES="$PWD/docker/.env.docker"
docker compose -f docker/compose.yaml up --build
```

| 서비스 | 하는 일 |
| -- | -- |
| database | Postgres 17. 데이터는 볼륨에 둔다. 처음 뜰 때 Supabase가 쓰는 역할(`service_role`은 BYPASSRLS, `anon`, `authenticated`, 로그인용 `authenticator`)과 기본 권한을 만든다. 이 SQL은 이미지에 넣는다. 비밀번호는 로컬 고정값이다(포트를 밖에 열지 않음) |
| migrate | 한 번 돌고 끝나는 컨테이너. migration 파일을 001부터 `public`에 파일마다 한 transaction으로 적용한다. 적용 기록은 `migration_history.applied_migrations`에 두어 PostgREST에 드러나지 않게 하고, 이미 적용한 파일은 건너뛴다 |
| rest | PostgREST v14(Supabase와 같은 major). `authenticator`로 접속하고 `public`을 노출한다. 한 번에 1000행까지(Supabase Data API 기본값) |
| gateway | nginx. supabase-js는 `<SUPABASE_URL>/rest/v1/…`로 부르므로, `/rest/v1/`을 PostgREST로 넘긴다 |
| workers | 한 컨테이너에서 다섯 워커를 각자 `wrangler dev --env docker --ip 0.0.0.0 --port <포트>`로 띄운다(`docker/workers/start-workers.ts`). 컨테이너를 나누면 dev registry가 `127.0.0.1`을 적어서 service binding이 이어지지 않는다. R2·KV·Workflow는 볼륨에 워커마다 따로 둔다(`--persist-to`). user-vault의 테이블은 migrate가 015로 컨테이너 Postgres에 만든다 |
| web | Vite 개발 서버(`--host 0.0.0.0 --port 5174`) |

- **Supabase 연결:** 워커의 `SUPABASE_URL`은 gateway 주소(`http://gateway:8000`)다. `SUPABASE_SECRET_KEY`는 시작할 때 PostgREST의 JWT secret으로 서명해 만든 `role: service_role` JWT다. supabase-js는 이 값을 header로 보내기만 하므로 클라우드 키 형식이 아니어도 된다. DB가 따로라 schema를 나눌 필요가 없어 `SUPABASE_SCHEMA`는 `public`이다.
- **wrangler 설정:** 다섯 워커에 `[env.docker]`를 더한다. 이름은 다른 환경처럼 `…-docker-worker`이고, 허용 목록은 docker 웹 주소다. 배포하지 않으므로 KV ID는 로컬 이름(`docker-oauth-state`)이다.
- **소스:** 원격 Docker에서는 bind mount가 m6의 경로를 본다. 그래서 소스를 이미지에 넣어 build한다. 고칠 때는 `compose watch`가 source 폴더를 컨테이너로 옮기고, `package.json`이나 lockfile이 바뀌면 다시 build한다. m6 원격 엔진에서 `watch`가 시작되는 것까지 확인했다.
- **접속과 로그인:** Google은 callback으로 https나 `localhost`만 받고 IP 주소는 받지 않는다. 그래서 브라우저는 `localhost`로 붙는다. 포트는 m6의 `127.0.0.1`에만 열고, `ssh -N -L …` 한 줄로 이 컴퓨터의 localhost에 넘겨받는다. 웹은 5174, 워커는 9787~9791이다. Vite는 https로 뜨므로 허용 목록은 `https://localhost:5174`다. 로그인 워커는 요청 주소로 callback을 만들므로 `http://localhost:9787/callback`, `http://localhost:9788/callback`이 나간다.
- **secret:** `docker/.env.docker`(gitignore)를 셸마다 한 번 `COMPOSE_ENV_FILES`로 정해 두고(`--env-file`로 넘겨도 된다), 서비스마다 필요한 값만 받는다. rest는 PostgREST JWT secret만, web은 Google client ID만, workers는 나머지(docker 전용 `JWT_SECRET`·`VAULT_INTERNAL_TOKEN`·`PROVIDER_KEY_KEK`, 로그인 client ID·secret, `CODE_RUNNER_FUNCTION_URL`)를 받는다. `tools/environment-generator`가 1Password에서 만든다. PostgREST JWT secret이 없으면 compose 명령이 바로 멈추므로, `down`·`logs`도 이 파일을 읽어야 한다. `COMPOSE_ENV_FILES`를 정해 둔 셸에서는 따로 붙일 것이 없다.
- **Axiom:** `packages/axiom-logger`는 끌 수 없어서 요청마다 `api.axiom.co`로 trace를 보낸다. docker에는 진짜 토큰을 넘기지 않고(고정 placeholder), workers 컨테이너에서 `api.axiom.co`를 `127.0.0.1`로 돌려 밖으로 나가지 않게 한다. 로그에 요청마다 "exporting spans failed" 한 줄이 남는다.
- **이미지:** m6는 arm64이고 Docker VMM이라 Rosetta가 없다. 쓰는 이미지(`node:26-trixie-slim`, `postgres:17-trixie`, `postgrest/postgrest:v14.18`, `nginx:1.30-alpine`)는 모두 arm64 판이 있다. workerd는 운영체제 인증서를 쓰므로 node 이미지에 `ca-certificates`를 넣는다(없으면 밖으로 나가는 https가 모두 실패한다). 워커·웹 이미지는 1.5GB쯤이다.
- **project 이름:** `audio-underview`로 고정한다. 한 엔진에서 두 checkout을 돌리려면 `-p`로 이름을 바꾸는데, 포트와 callback이 고정이라 동시에 띄울 수는 없다.
- **cron:** `wrangler dev`는 cron을 저절로 돌리지 않는다. README의 주소로 직접 부른다.

## 8. 한 번만 하는 준비

외부 계정을 바꾸는 일이라 하나씩 사용자 확인을 받고 한다.
1. Cloudflare(outlook 계정): staging·development용 R2 bucket(`audio-underview-crawler-files-<env>`), KV namespace(`audio-underview-oauth-state-<env>`)를 만들고 ID를 `wrangler.toml`에 적는다. **2026-10-20 완료.** KV ID는 비밀이 아니고 CI가 커밋된 `wrangler.toml`을 읽으므로, 운영 ID처럼 커밋한다. 같이 만든 D1 database(`audio-underview-user-vault-<env>`)는 user-vault가 Supabase로 옮기면서 쓰지 않게 됐다. 운영 D1과 함께 지울 대상이다.
2. 1Password `Audio Underview` vault에 `Staging Environment`·`Development Environment`·`Docker Environment` 항목을 만든다: JWT secret, vault internal token, provider key KEK. docker에는 PostgREST JWT secret도 둔다.
3. 워커 secret(`wrangler secret bulk --env staging|development`). 새 값은 2번 항목이고, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `CODE_RUNNER_FUNCTION_URL`, `AXIOM_API_TOKEN`은 운영과 같은 값이다. 로그인 워커의 client ID·secret과 `FRONTEND_URL`은 CI가 배포 때마다 올린다. 2·3번은 사용자가 터미널에서 스크립트 하나로 한다(값이 화면·명령 인자·파일에 남지 않음).
4. 로그인 callback(사용자 몫). 지금 Google OAuth client와 GitHub OAuth App에 더한다.
   - `https://audio-underview-google-oauth-provider-staging-worker.tes-cha.workers.dev/callback`
   - `https://audio-underview-google-oauth-provider-development-worker.tes-cha.workers.dev/callback`
   - `https://audio-underview-github-oauth-provider-staging-worker.tes-cha.workers.dev/callback`
   - `https://audio-underview-github-oauth-provider-development-worker.tes-cha.workers.dev/callback`
   - local: `http://localhost:8787/callback`(Google), `http://localhost:8788/callback`(GitHub)
   - docker: `http://localhost:9787/callback`(Google), `http://localhost:9788/callback`(GitHub)
5. Supabase 노출 schema 목록에 `staging`, `development`를 더한다(4절).
6. GitHub 변수: 환경마다 `<환경>_VITE_GOOGLE_OAUTH_WORKER_URL`, `<환경>_VITE_GITHUB_OAUTH_WORKER_URL`, `<환경>_VITE_CRAWLER_MANAGER_WORKER_URL`, `<환경>_VITE_SCHEDULER_MANAGER_WORKER_URL`, `<환경>_FRONTEND_URL`(`<환경>`은 `STAGING`, `DEVELOPMENT`). **2026-10-20 완료.**

## 9. 확인

- 로컬:
  - typecheck와 테스트. connector의 schema 전달, `public.` 바꾸기, 외래 키 순서, production 적용 여부로 파일 나누기를 테스트한다.
  - 다섯 워커의 `wrangler deploy --env staging --dry-run`과 `--env development --dry-run`.
- 첫 staging 배포 뒤:
  - staging 웹에서 Google·GitHub로 로그인하면 production과 같은 내 데이터가 보인다.
  - staging에서 크롤러를 만들어도 `public.crawlers` 행 수는 그대로다.
  - Run now가 돌고, 실행 기록이 staging에 남는다.
  - 다시 배포하면 staging에서 만든 크롤러가 사라지고 production 상태로 돌아온다.
  - 함수 본문에 `public.`이 없다.
- 첫 development 배포 뒤: 로그인하면 빈 데이터에서 시작하고, 다시 배포해도 만든 것이 남는다.
- 로컬: 로컬 웹에서 로컬 로그인 워커로 Google·GitHub 로그인이 되고, 크롤러를 만들면 `development.crawlers`에 생긴다. 시험 실행과 Run now가 로컬 워커에서 돈다.
- docker: `docker compose … up`으로 다 뜨고, localhost로 넘겨받은 웹에서 로그인하면 빈 데이터(system crawler 5개만)에서 시작한다. 크롤러 만들기, 시험 실행, Run now가 돌고, `docker compose down -v` 뒤에는 데이터가 비워진다.
- production: 다음 main 배포 뒤 운영 화면이 그대로 동작한다(`SUPABASE_SCHEMA = "public"`).

## 10. 위험과 확인할 것

- 세 환경이 같은 Supabase 키를 쓴다. 운영 데이터와의 벽은 schema 설정뿐이다. 그래서 `schema`를 생략할 수 없게 하고(타입과 실행 때 모두), 환경 블록마다 값을 테스트하고, 함수 본문을 검사한다.
- docker의 `SUPABASE_SCHEMA`는 `public`이다. compose 밖에서 클라우드 키로 `wrangler dev --env docker`를 띄우면 운영 테이블에 쓴다. docker 환경은 compose로만 띄운다.
- staging에는 다른 사용자의 데이터도 복사된다. staging에서는 머지 전 코드가 돌므로, 권한 검사에 버그가 있으면 staging 주소로 남의 복사본이 보일 수 있다.
- staging은 Supabase 데이터만 복사한다.
  - 복사된 실행 기록의 파일은 staging R2에 없어서 열리지 않는다.
  - user-vault의 세 테이블(AI 제공자 키, 크롤러 환경 변수, 키 사용 기록)은 production KEK로 암호화돼 있어 복사하지 않는다. staging에서 다시 등록한다. 로그인은 user-vault와 상관없다(`users`·`accounts`는 복사된다).
- 머지하면 운영 migration(015)과 user-vault 배포가 순서 없이 동시에 시작된다. 그사이 잠깐 user-vault가 없는 테이블을 찾을 수 있다. 운영 user-vault에는 머지 전에 `SUPABASE_URL`, `SUPABASE_SECRET_KEY` secret을 올려 둔다.
- production 허용 목록에서 localhost를 빼면, 로컬 웹을 운영 워커에 붙여 쓰던 방식은 더 이상 안 된다.
- SQL 실행 API는 문서상 beta·experimental이다. 바뀌면 같은 일을 DB 직접 연결(`psql`)로 한다.
- 구현하며 확인한 것(2026-10-19~20):
  - 따로 띄운 `wrangler dev`끼리 service binding이 이어진다. 시작 순서는 상관없다. Dynamic Workers와 Workflow도 로컬에서 돈다.
  - docker: 컨테이너가 다르면 service binding이 이어지지 않는다. dev registry가 워커 주소를 `127.0.0.1:<포트>`로 적기 때문이다. 그래서 다섯 워커를 한 컨테이너에서 띄운다(7절). linux/arm64에서 workerd가 돌고, m6 원격 엔진에서 `compose watch`가 시작된다.
  - 여러 문장을 한 번에 보낸 `BEGIN … COMMIT`은 중간에 실패하면 아무것도 남지 않는다(Postgres 17에서 확인. Supabase API로는 아직 안 해 봄).
  - service binding 대상이 먼저 있게 CI가 user-vault → crawler-manager → scheduler-manager 순서로 배포한다.
- 첫 staging 배포 때 확인할 것:
  - SQL 실행 API가 `BEGIN … COMMIT`이 든 큰 SQL(지금 약 50KB)을 한 번에 받는지, 시간 안에 끝나는지
  - `read_only: true`로 metadata를 읽을 수 있는지. 안 되면 그 읽기에서 `read_only`를 뺀다
  - API는 superuser가 아닌 `postgres` 역할로 SQL을 돌린다. 지금까지의 확인은 superuser로 했다
  - `db_extra_search_path`에 `public`이 있으면, staging에 없는 이름이 `public`으로 넘어가는지. `SET search_path`가 없는 함수(`reorder_scheduler_stages`)를 staging에서 불러 staging 행만 바뀌는지 본다
- development에 새 migration 여러 개를 한 번에 적용하면 한 transaction이 된다. 한 파일이 enum 값을 더하고 다음 파일이 그 값을 쓰면 실패하므로, `--reset`하거나 나눠서 배포한다. 기록에는 checksum이 없어서, 이미 적용한 파일을 고치면 알아채지 못한다(`--reset`).
- 이 컴퓨터에서는 8788 포트를 다른 서비스(account-usage-dashboard)가 쓰고 있다. `pnpm dev` 중에는 `localhost:8788`이 GitHub 로그인 워커로 간다.
- 로컬 `wrangler dev`에서 Run now가 SchedulerRunWorkflow를 시작한 직후 scheduler-manager에 "code had hung" 오류가 한 번 찍힌다(docker에서 봄). 실행 기록은 제대로 남는다. 원인은 아직 모른다.
- 로컬 워커와 클라우드 development 워커는 같은 `development` schema를 쓴다. 로컬 R2는 내 컴퓨터에만 있으므로, 클라우드 development에서 만든 실행 기록의 파일은 로컬에서 열리지 않는다(반대도 같다).
- staging과 development는 각각 한 번에 한 브랜치만 쓴다.
- Supabase는 2026-10-30부터 기존 프로젝트도 새로 만드는 테이블에 Data API 권한을 저절로 주지 않는다. 015부터의 migration은 테이블마다 `GRANT … TO service_role`을 적어야 하고, 빠지면 schema 도구가 거절한다(4절). staging·development도 기본 권한을 두지 않아, GRANT가 빠진 migration이 staging에서만 되는 일이 없다. docker의 Postgres는 예전 Supabase처럼 기본 권한을 두어 이 차이를 잡지 못하므로, PR의 `test-tools.yml`이 실제 migration 폴더로 이 검사를 돌려 막는다.
