import {
  PROVIDER_TEXT_MAXIMUM_LENGTH,
  redactSecrets,
  truncateText,
  redactAndTruncate,
} from './secret-redaction.ts';

const TRUNCATION_MARKER = '… [truncated]';

describe('redactSecrets', () => {
  describe('redacts credentials', () => {
    test.each([
      ['key=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789xyz', 'key=sk-[REDACTED]'],
      ['sk-ant-api03-AAaaBBbbCCcc-99', 'sk-[REDACTED]'],
      ['sk_live_51H8xYzAbCdEfGhIj', 'sk_[REDACTED]'],
      ['AIzaSyD-1234567890abcdefgHIJKLmnop', 'AIza[REDACTED]'],
      [
        'API key not valid: AQ.Ab8RN6-a_b.c1234 for this project',
        'API key not valid: AQ.[REDACTED] for this project',
      ],
      ['xai-abcdef1234567890ABCDEF', 'xai-[REDACTED]'],
      ['gsk_aBcD1234EfGh5678IjKl', 'gsk_[REDACTED]'],
      ['sk-***abcd', 'sk-[REDACTED]'],
      ['sk-••••••••abcd', 'sk-[REDACTED]'],
      [
        'You have insufficient quota in org-9dF2kQwErTyUiOpA (proj_aBcD1234).',
        'You have insufficient quota in org-[REDACTED] (proj_[REDACTED]).',
      ],
      ['ya29.a0AfB_byC1234567890-_abcdef', 'ya29.[REDACTED]'],
      ['ghp_16C7e42F292c6912E7710c838347Ae178B4a', 'gh_[REDACTED]'],
      ['gho_16C7e42F292c6912E7710c838347Ae178B4a', 'gh_[REDACTED]'],
      ['ghu_16C7e42F292c6912E7710c838347Ae178B4a', 'gh_[REDACTED]'],
      ['ghs_16C7e42F292c6912E7710c838347Ae178B4a', 'gh_[REDACTED]'],
      ['ghr_16C7e42F292c6912E7710c838347Ae178B4a', 'gh_[REDACTED]'],
      [
        'rejected token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMTExMTExMS0xMTExLTUxMTEifQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
        'rejected token eyJ[REDACTED]',
      ],
      ['bearer eyJhbGciOiJIUzI1NiJ9.payload.signature', 'Bearer [REDACTED]'],
    ])('%s', (input, expected) => {
      expect(redactSecrets(input)).toBe(expected);
    });
  });

  describe('leaves ordinary text unchanged', () => {
    test.each([
      'see the FAQ.Section2 for details',
      'invalid_api_key (401)',
      'stop_reason=max_tokens',
      'after the reorg-chart landed',
      'task-force scheduling',
      'risk-score too high',
      'disk-usage exceeded',
      'desk_assignment pending',
    ])('%s', (input) => {
      expect(redactSecrets(input)).toBe(input);
    });
  });
});

describe('truncateText', () => {
  test('returns text unchanged when it is at or below the maximum length', () => {
    expect(truncateText('abc', 3)).toBe('abc');
    expect(truncateText('ab', 3)).toBe('ab');
  });

  test('cuts text above the maximum length and appends the truncation marker', () => {
    expect(truncateText('abcd', 3)).toBe(`abc${TRUNCATION_MARKER}`);
  });

  test('uses 200 as the default maximum length', () => {
    expect(PROVIDER_TEXT_MAXIMUM_LENGTH).toBe(200);

    const atLimit = 'a'.repeat(200);
    expect(truncateText(atLimit)).toBe(atLimit);

    const overLimit = 'b'.repeat(201);
    expect(truncateText(overLimit)).toBe(`${'b'.repeat(200)}${TRUNCATION_MARKER}`);
  });
});

describe('redactAndTruncate', () => {
  test('does not leave the beginning of a key at the cut', () => {
    const text = `${'a'.repeat(195)} sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ`;

    // Truncating before redacting would leave a key fragment too short to be matched.
    expect(redactSecrets(truncateText(text))).toContain('sk-a');

    const result = redactAndTruncate(text);
    expect(result).not.toContain('sk-a');
    expect(result).not.toContain('ant-api03');
    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  test('redacts a long body and then truncates it', () => {
    const key = `sk-proj-${'A'.repeat(64)}`;
    const text = `Incorrect API key provided: ${key}. ${'details '.repeat(50)}`;

    const result = redactAndTruncate(text);

    expect(result).not.toContain(key);
    expect(result).not.toContain('AAAA');
    expect(result.startsWith('Incorrect API key provided: sk-[REDACTED]. ')).toBe(true);
    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(result.length).toBe(PROVIDER_TEXT_MAXIMUM_LENGTH + TRUNCATION_MARKER.length);
  });

  test('accepts a custom maximum length', () => {
    expect(redactAndTruncate('token xai-abcdef1234567890ABCDEF here', 10)).toBe(
      `token xai-${TRUNCATION_MARKER}`,
    );
  });
});
