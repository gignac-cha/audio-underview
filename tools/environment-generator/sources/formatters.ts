/**
 * .env 파일 생성용 순수 함수 모음 — 1Password 호출 없이 단위 테스트 가능.
 */

/** 빈 문자열/placeholder 값은 .env에 쓰지 않는다. */
export function isValidSecretValue(value: string): boolean {
  if (!value) return false;
  if (value === 'REPLACE_ME') return false;
  return true;
}

/**
 * 큰따옴표로 감싼 .env 값에서 깨질 수 있는 문자를 escape.
 * (backslash → \\, double quote → \", newline → \n)
 */
export function escapeEnvironmentValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

/** `NAME="value"` 형식의 한 줄 생성. */
export function formatEnvironmentLine(variableName: string, value: string): string {
  return `${variableName}="${escapeEnvironmentValue(value)}"`;
}

/**
 * 파일에 들어갈 변수 이름 목록과 resolve된 값 맵으로 .env 파일 내용을 만든다.
 * resolve되지 않은 변수는 건너뛰고, 쓸 값이 하나도 없으면 undefined를 반환한다.
 */
export function buildEnvironmentFileContent(
  variableNames: readonly string[],
  resolvedVariables: ReadonlyMap<string, string>,
): string | undefined {
  const lines: string[] = [];

  for (const variableName of variableNames) {
    const value = resolvedVariables.get(variableName);
    if (value !== undefined) {
      lines.push(formatEnvironmentLine(variableName, value));
    }
  }

  if (lines.length === 0) {
    return undefined;
  }

  return lines.join('\n') + '\n';
}
