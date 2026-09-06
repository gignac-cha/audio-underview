import { z } from 'zod';

/**
 * plain JSON object (배열/null 불가). 레거시의 `isPlainObject` 검증과 동일한 의미.
 */
export const plainObjectSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => !Array.isArray(value), { message: 'Expected a plain JSON object' });

export type PlainObject = z.infer<typeof plainObjectSchema>;
