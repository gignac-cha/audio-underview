import { describe, expect, it } from 'vitest';
import {
  ACTIVE_RUN_UNIQUE_INDEX,
  DatabaseOperationError,
  isForeignKeyViolation,
  isNoRowsError,
  isUniqueViolation,
} from '../sources/errors.ts';
import { resolveListRange } from '../sources/pagination.ts';

describe('error classification', () => {
  it('detects unique violations by SQLSTATE code', () => {
    expect(isUniqueViolation({ code: '23505', message: 'duplicate key' })).toBe(true);
  });

  it('detects unique violations by message fallback', () => {
    expect(isUniqueViolation({ message: 'UNIQUE constraint violated' })).toBe(true);
  });

  it('filters by constraint name when provided', () => {
    const error = {
      code: '23505',
      message: `duplicate key value violates unique constraint "${ACTIVE_RUN_UNIQUE_INDEX}"`,
    };
    expect(isUniqueViolation(error, ACTIVE_RUN_UNIQUE_INDEX)).toBe(true);
    expect(isUniqueViolation(error, 'some_other_index')).toBe(false);
  });

  it('unwraps DatabaseOperationError causes', () => {
    const wrapped = new DatabaseOperationError('create', 'scheduler run', {
      code: '23505',
      message: `violates unique constraint "${ACTIVE_RUN_UNIQUE_INDEX}"`,
    });
    expect(isUniqueViolation(wrapped, ACTIVE_RUN_UNIQUE_INDEX)).toBe(true);
  });

  it('detects foreign key violations', () => {
    expect(isForeignKeyViolation({ code: '23503', message: 'fk' })).toBe(true);
    expect(
      isForeignKeyViolation({ message: 'update violates foreign key constraint' }),
    ).toBe(true);
    expect(isForeignKeyViolation({ code: '23505', message: 'dup' })).toBe(false);
  });

  it('detects PostgREST no-rows errors', () => {
    expect(isNoRowsError({ code: 'PGRST116', message: 'no rows' })).toBe(true);
    expect(isNoRowsError({ code: '23505' })).toBe(false);
  });

  it('formats DatabaseOperationError messages (레거시 형식 유지)', () => {
    const error = new DatabaseOperationError('list', 'crawlers', { message: 'timeout' });
    expect(error.message).toBe('Failed to list crawlers: timeout');
  });
});

describe('resolveListRange', () => {
  it('applies defaults (offset 0, limit 20)', () => {
    expect(resolveListRange()).toEqual({ from: 0, to: 19 });
  });

  it('clamps limit to 1–100', () => {
    expect(resolveListRange({ limit: 0 })).toEqual({ from: 0, to: 0 });
    expect(resolveListRange({ limit: 500 })).toEqual({ from: 0, to: 99 });
  });

  it('clamps negative offsets to 0', () => {
    expect(resolveListRange({ offset: -5 })).toEqual({ from: 0, to: 19 });
  });

  it('computes PostgREST range bounds', () => {
    expect(resolveListRange({ offset: 40, limit: 20 })).toEqual({ from: 40, to: 59 });
  });
});
