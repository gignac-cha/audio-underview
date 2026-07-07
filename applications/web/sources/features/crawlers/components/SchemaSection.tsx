import type { CrawlerType } from '@audio-underview/schemas';
import { TextArea } from '../../../components/FormControls.tsx';
import { Section } from '../../../components/Section.tsx';
import type { SchemaErrors } from '../hooks/use-crawler-form.ts';
import type { FormState } from '../hooks/crawler-form-helpers.ts';

const WEB_INPUT_HELPER =
  'Web crawlers receive the fetched page body — schema is fixed and not editable.';

export interface SchemaSectionProps {
  form: FormState;
  crawlerType: CrawlerType;
  isEditable: boolean;
  schemaErrors: SchemaErrors;
  onChangeSchema: (field: 'input_schema' | 'output_schema', value: string) => void;
  onBlurSchema: (field: 'input_schema' | 'output_schema') => void;
}

/** 스키마 섹션 (detail 전용). web input은 고정, data input + 전 타입 output 편집 가능. */
export const SchemaSection = ({
  form,
  crawlerType,
  isEditable,
  schemaErrors,
  onChangeSchema,
  onBlurSchema,
}: SchemaSectionProps) => {
  const inputReadOnly = !isEditable || crawlerType === 'web';

  return (
    <>
      <Section title="Input schema">
        <TextArea
          monospace
          rows={5}
          value={form.input_schema}
          readOnly={inputReadOnly}
          error={schemaErrors.input_schema}
          helper={crawlerType === 'web' ? WEB_INPUT_HELPER : undefined}
          aria-label="Input schema"
          onChange={(event) => {
            onChangeSchema('input_schema', event.target.value);
          }}
          onBlur={() => {
            onBlurSchema('input_schema');
          }}
        />
      </Section>

      <Section title="Output schema">
        <TextArea
          monospace
          rows={5}
          value={form.output_schema}
          readOnly={!isEditable}
          error={schemaErrors.output_schema}
          aria-label="Output schema"
          onChange={(event) => {
            onChangeSchema('output_schema', event.target.value);
          }}
          onBlur={() => {
            onBlurSchema('output_schema');
          }}
        />
      </Section>
    </>
  );
};
