/**
 * 도메인 전역 길이/크기 제한.
 *
 * 참고: 레거시는 crawler-manager가 code를 1MB까지 허용하고 code-runner가 10,000자에서
 * 거부하는 불일치가 있었다 (스펙 §8.1). 저장은 되지만 실행이 불가능한 crawler를 만들 수
 * 있었으므로, 재작성에서는 실행 가능한 상한인 10,000자로 통일한다.
 */
export const MAXIMUM_NAME_LENGTH = 255;
export const MAXIMUM_URL_PATTERN_LENGTH = 2_048;
export const MAXIMUM_CRAWLER_CODE_LENGTH = 10_000;
export const MAXIMUM_CRON_EXPRESSION_LENGTH = 100;

export const DEFAULT_LIST_OFFSET = 0;
export const DEFAULT_LIST_LIMIT = 20;
export const MAXIMUM_LIST_LIMIT = 100;
