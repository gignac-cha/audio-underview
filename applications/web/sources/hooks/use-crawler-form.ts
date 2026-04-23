import { useEffect, useMemo, useRef, useState } from 'react';
import type { CrawlerRow } from '@audio-underview/supabase-connector';
import {
  BLANK_FORM,
  computeIsDirty,
  deriveFormState,
  tryParseSchema,
  type FormState,
  type SchemaErrors,
  type SchemaField,
} from './crawler-form-helpers.ts';

export function useCrawlerForm(isCreateMode: boolean) {
  const [form, setForm] = useState<FormState | undefined>(isCreateMode ? BLANK_FORM : undefined);
  const [pristine, setPristine] = useState<FormState | undefined>(isCreateMode ? BLANK_FORM : undefined);
  const [schemaErrors, setSchemaErrors] = useState<SchemaErrors>({});

  const isDirty = useMemo(() => computeIsDirty(form, pristine), [form, pristine]);
  const hasSchemaError = !!schemaErrors.input_schema || !!schemaErrors.output_schema;

  const formRef = useRef(form);
  useEffect(() => {
    formRef.current = form;
  });

  const resetFromCrawler = (crawler: CrawlerRow) => {
    const initial = deriveFormState(crawler);
    setForm(initial);
    setPristine(initial);
    setSchemaErrors({});
  };

  const resetToPristine = () => {
    if (!pristine) return;
    setForm(pristine);
    setSchemaErrors({});
  };

  const markSaved = (submitted: FormState, next: FormState): boolean => {
    const wasApplied = formRef.current === submitted;
    setForm((current) => (current === submitted ? next : current));
    setPristine(next);
    return wasApplied;
  };

  const validateSchemaField = (field: SchemaField, raw: string) => {
    setSchemaErrors((previous) => {
      const next = { ...previous };
      const parsed = tryParseSchema(raw);
      if (parsed === undefined) {
        next[field] = 'Must be a valid JSON object.';
      } else {
        delete next[field];
      }
      return next;
    });
  };

  const changeSchema = (field: SchemaField, raw: string) => {
    setForm((previous) => (previous ? { ...previous, [field]: raw } : previous));
    setSchemaErrors((previous) => {
      if (!previous[field] || tryParseSchema(raw) === undefined) return previous;
      const next = { ...previous };
      delete next[field];
      return next;
    });
  };

  const setSchemaError = (field: SchemaField, message: string) => {
    setSchemaErrors((previous) => ({ ...previous, [field]: message }));
  };

  return {
    form,
    setForm,
    schemaErrors,
    isDirty,
    hasSchemaError,
    resetFromCrawler,
    resetToPristine,
    markSaved,
    validateSchemaField,
    changeSchema,
    setSchemaError,
  };
}
