# CLAUDE.md

## Project Conventions

### 1. Naming Conventions - No Abbreviations

**폴더명, 파일명, 코드에서 줄임말을 사용하지 않습니다. 의미를 명확하게 풀어서 명시하고, 가능한 한 복수형을 사용합니다.**

| Abbreviation | Full Name |
|--------------|-----------|
| apps | applications |
| src | sources |
| docs | documents |
| tmp | temporaries |
| params | parameters |
| args | arguments_ (예약어이므로 뒤에 _ 추가) |
| dist | outputs |
| utils | tools |
| config | options |

**복수형 사용:**
- script → scripts
- test → tests
- type → types
- component → components
- service → services
- handler → handlers
- controller → controllers
- middleware → middlewares
- model → models
- schema → schemas

**축약어는 대문자로, prefix는 소문자:**
- ID, URL, JSON, UUID, HTML, CSS, HTTP, HTTPS, API, REST, SQL, DOM, XML, URI, ASCII, UTF, TCP, UDP, IP, DNS, SSH, SSL, TLS, JWT, OAuth, CORS, CRUD, GUID, MIME, YAML, TOML, WASM, CLI, SDK, CDN, CMS, CRM, ERP, SPA, SSR, SSG, PWA, AWS, GCP, NPM, NVM, PNG, JPG, GIF, SVG, PDF, CSV, TSV, Markdown

### 2. TypeScript Import Extensions

**import 시 반드시 `.ts` 확장자를 명시합니다.**

```typescript
// Correct
import { something } from './module.ts';

// Incorrect
import { something } from './module';
```

### 3. Node.js Native TypeScript Execution

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

### 4. Nullish Coalescing Operator

**`||` 대신 `??`를 사용합니다.**

```typescript
// Correct
const value = input ?? 'default';

// Incorrect
const value = input || 'default';
```

`||`는 falsy 값(0, '', false 등)을 모두 대체하지만, `??`는 null과 undefined만 대체합니다.

### 5. Commit Message Convention

**커밋 메시지 첫 줄은 Conventional Commits 형식을 따르되, 줄임말을 풀어서 사용합니다.**

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

**형식:**
```
<type>: <description>

[optional body]

[optional footer]
```

**예시:**
```bash
# Correct
feature: add user authentication system
document: update API reference
fix: resolve memory leak in worker thread
refactor: simplify database connection logic
test: add unit tests for payment module
chore: update dependencies

# Incorrect
feat: add user authentication system
docs: update API reference
```
