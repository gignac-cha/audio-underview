# CLAUDE.md

## Commit Message Convention

**커밋 메시지 첫 줄은 `<type>(<scope>): <description>` 형식을 따르되, type은 줄임말을 풀어서 사용합니다.**

| Conventional | Full Name |
|--------------|-----------|
| feat | feature |
| docs | document |
| fix | fix |
| refactor | refactor |
| test | test |
| chore | chore |
| style | style |
| perf | performance |
| build | build |
| ci | ci |

**scope는 변경이 속한 workspace 패키지 이름을 사용하고, 특정 패키지에 한정되지 않는 변경은 생략합니다.**

```bash
# Correct
feature(web): add user authentication system

# Incorrect
feat(web): add user authentication system
```

## Branch Naming Convention

**브랜치 이름은 `<type>/<kebab-case-description>` 형식을 사용하고, type은 커밋 메시지와 동일하게 줄임말을 풀어서 사용합니다.**

## Pull Request Title Convention

**PR 제목은 커밋 메시지 첫 줄과 동일한 형식을 사용합니다.**

## Nullish Coalescing Operator

**`||` 대신 `??`를 사용합니다.** `||`는 falsy 값(0, '', false 등)을 모두 대체하지만, `??`는 null과 undefined만 대체합니다.

```typescript
// Correct
const value = input ?? 'default';

// Incorrect
const value = input || 'default';
```

## TypeScript Import Extensions

**import 시 반드시 `.ts` 확장자를 명시합니다.**

```typescript
// Correct
import { something } from './module.ts';

// Incorrect
import { something } from './module';
```

## Node.js Native TypeScript Execution

**Node.js v25 이상에서 TypeScript를 직접 실행합니다.**

```bash
# Correct
node script.ts

# Incorrect
ts-node script.ts
tsx script.ts
node --loader ts-node/esm script.ts
node --experimental-strip-types script.ts
tsc && node script.js
```

## Web Search

**외부 표준, 라이브러리, 도구에 대한 정보는 기억에 의존하지 않고 웹 검색으로 확인한 뒤 답합니다.**

## Naming Conventions

**폴더명, 파일명, 코드에서 줄임말을 사용하지 않고 의미를 풀어서 명시합니다.**

| Abbreviation | Full Name |
|--------------|-----------|
| apps | applications |
| src | sources |
| docs | documents |
| tmp | temporaries |
| params | parameters |
| args | arguments_ (예약어이므로 뒤에 _ 추가) |

**단, 다음은 풀어 쓰지 않고 대체어를 사용합니다:**

| Abbreviation | Replacement |
|--------------|-------------|
| dist | outputs |
| utils | tools |
| config | options |

**여러 항목을 담는 이름에는 복수형을 사용합니다.**

| Singular | Plural |
|----------|--------|
| script | scripts |
| test | tests |
| type | types |
| component | components |
| service | services |
| handler | handlers |
| controller | controllers |
| middleware | middlewares |
| model | models |
| schema | schemas |

**단, 하나의 개체를 구현하는 파일 이름에는 단수형을 사용합니다.**

**축약어는 대문자로, prefix는 소문자. 단독으로 변수명에 사용할 때는 소문자:**

- ID, URL, JSON, UUID, HTML, CSS, HTTP, HTTPS, API, REST, SQL, DOM, XML, URI, ASCII, UTF, TCP, UDP, IP, DNS, SSH, SSL, TLS, JWT, OAuth, CORS, CRUD, GUID, MIME, YAML, TOML, WASM, CLI, SDK, CDN, CMS, CRM, ERP, SPA, SSR, SSG, PWA, AWS, GCP, NPM, NVM, PNG, JPG, GIF, SVG, PDF, CSV, TSV, Markdown

## Package Management with pnpm

**의존성은 `package.json`을 직접 수정해 추가·변경하지 않고 항상 `pnpm add`를 사용합니다. 새 패키지 생성은 `pnpm init`, 전체 의존성 설치는 `pnpm install`을 사용합니다. `scripts` 등 의존성 외 필드는 직접 수정할 수 있습니다.**

```bash
pnpm init
pnpm add <package-name>@latest
pnpm add <workspace-package-name>@workspace:*
```

## Git Operations

**git 쓰기 작업(commit, push, branch, merge, PR 생성 등)은 사용자가 명시적으로 요청했을 때만 수행합니다. 이 문서의 컨벤션은 형식 규칙일 뿐, git 작업을 수행하라는 지시가 아닙니다.**
