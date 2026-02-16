# Environment Generator

1Password Service Account를 통해 `.env` 파일을 생성합니다.

## 사전 조건

- [1Password CLI](https://1password.com/downloads/command-line/) 설치
- 1Password 개인 계정에 Service Account 토큰 저장 완료

## 사용법

```bash
eval $(op signin)
OP_SERVICE_ACCOUNT_TOKEN=$(pnpm run --silent environment:setup) pnpm run environment:generate
```

## 생성되는 파일

| 파일 | 용도 |
|------|------|
| `applications/web/.env` | 웹 앱 로컬 개발 |
| `.env.workers` | Worker 로컬 개발 |
| `.env.deploy` | 배포용 |
