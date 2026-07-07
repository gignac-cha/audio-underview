import { useCallback, useRef, useState } from 'react';
import {
  BLANK_FORM,
  computeIsDirty,
  formsAreEqual,
  tryParseSchema,
  type FormState,
  type SchemaField,
} from './crawler-form-helpers.ts';

export interface SchemaErrors {
  input_schema?: string;
  output_schema?: string;
}

const SCHEMA_ERROR_MESSAGE = 'Must be a valid JSON object.';

/** 폼 상태/pristine/dirty/schemaErrors + reset/markSaved/setField/changeSchema/validateSchema. */
export const useCrawlerForm = () => {
  const [form, setForm] = useState<FormState>(BLANK_FORM);
  const [pristine, setPristine] = useState<FormState>(BLANK_FORM);
  const [schemaErrors, setSchemaErrors] = useState<SchemaErrors>({});

  // markSaved에서 "저장 중 추가 입력" 여부를 최신 form으로 판단하기 위한 ref.
  const formRef = useRef(form);
  formRef.current = form;

  const isDirty = computeIsDirty(form, pristine);

  const setField = useCallback((field: keyof FormState, value: string) => {
    setForm((previous) => ({ ...previous, [field]: value }));
  }, []);

  /** 스키마 텍스트 변경 — 기존 error가 있고 값이 유효해지면 즉시 해제 (스펙 §4.3.6). */
  const changeSchema = useCallback((field: SchemaField, value: string) => {
    setForm((previous) => ({ ...previous, [field]: value }));
    setSchemaErrors((previous) => {
      if (previous[field] === undefined) {
        return previous;
      }
      return tryParseSchema(value).ok ? { ...previous, [field]: undefined } : previous;
    });
  }, []);

  /** onBlur 검증 — JSON object 아니면 인라인 error. */
  const validateSchema = useCallback((field: SchemaField) => {
    setSchemaErrors((previous) => {
      const valid = tryParseSchema(formRef.current[field]).ok;
      return { ...previous, [field]: valid ? undefined : SCHEMA_ERROR_MESSAGE };
    });
  }, []);

  const setSchemaError = useCallback((field: SchemaField, message: string) => {
    setSchemaErrors((previous) => ({ ...previous, [field]: message }));
  }, []);

  /** 새 스냅샷으로 초기화 (서버 seed). */
  const reset = useCallback((next: FormState) => {
    setForm(next);
    setPristine(next);
    setSchemaErrors({});
  }, []);

  /** 편집 취소 — 마지막 pristine으로 폼을 되돌린다. */
  const restore = useCallback(() => {
    setForm(pristine);
    setSchemaErrors({});
  }, [pristine]);

  /**
   * 저장 성공 반영. 제출 시점 form과 현재 form이 동일할 때만 true(→ view 복귀 가능);
   * 저장 중 사용자가 추가 입력했으면 false로 신호해 그 입력을 덮지 않는다 (보존 §3).
   */
  const markSaved = useCallback((submitted: FormState): boolean => {
    setPristine(submitted);
    return formsAreEqual(formRef.current, submitted);
  }, []);

  const hasSchemaError =
    schemaErrors.input_schema !== undefined || schemaErrors.output_schema !== undefined;

  return {
    form,
    isDirty,
    schemaErrors,
    hasSchemaError,
    setField,
    changeSchema,
    validateSchema,
    setSchemaError,
    reset,
    restore,
    markSaved,
  };
};
