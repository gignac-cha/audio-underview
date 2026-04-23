import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useCreateCrawler, useGetCrawler, useUpdateCrawler } from './use-crawler-manager.ts';
import { useToast } from './use-toast.ts';
import { useCrawlerForm } from './use-crawler-form.ts';
import { useEditorMode } from './use-editor-mode.ts';
import { useBeforeUnload } from './use-before-unload.ts';
import { deriveFormState, tryParseSchema } from './crawler-form-helpers.ts';

export type { EditorMode } from './use-editor-mode.ts';
export type { FormState, SchemaErrors, SchemaField } from './crawler-form-helpers.ts';

export function useCrawlerEditor(id: string | undefined) {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const isCreateMode = id === 'new';

  const { crawler, isLoading, error, refetch } = useGetCrawler(isCreateMode ? undefined : id);
  const { updateCrawler, status: updateStatus } = useUpdateCrawler();
  const { createCrawler, status: createStatus } = useCreateCrawler();

  const formState = useCrawlerForm(isCreateMode);
  const modeState = useEditorMode(isCreateMode);

  const [seededForCrawlerID, setSeededForCrawlerID] = useState<string | undefined>(undefined);
  const [discardDialogOpen, setDiscardDialogOpen] = useState(false);
  const pendingDiscardActionRef = useRef<(() => void) | null>(null);
  const inFlightRef = useRef(false);

  if (!isCreateMode && crawler && seededForCrawlerID !== crawler.id) {
    setSeededForCrawlerID(crawler.id);
    formState.resetFromCrawler(crawler);
    modeState.exitEdit();
  }

  useBeforeUnload(modeState.isEditable && formState.isDirty);

  const crawlerType = crawler?.type ?? 'web';
  const trimmedName = formState.form?.name.trim() ?? '';
  const trimmedURLPattern = formState.form?.url_pattern.trim() ?? '';

  const canSubmit =
    !!formState.form &&
    (isCreateMode || formState.isDirty) &&
    !formState.hasSchemaError &&
    trimmedName.length > 0 &&
    formState.form.code.trim().length > 0 &&
    (crawlerType === 'data' || trimmedURLPattern.length > 0);

  const isSaving = updateStatus === 'pending' || createStatus === 'pending';

  let disabledReason: string | undefined;
  if (formState.form && !canSubmit && !isSaving) {
    if (!isCreateMode && !formState.isDirty) {
      disabledReason = 'No changes to save.';
    } else if (formState.hasSchemaError) {
      disabledReason = 'Fix schema errors before saving.';
    } else if (trimmedName.length === 0) {
      disabledReason = 'Name is required.';
    } else if (formState.form.code.trim().length === 0) {
      disabledReason = 'Code cannot be empty.';
    } else if (crawlerType === 'web' && trimmedURLPattern.length === 0) {
      disabledReason = 'URL pattern is required for web crawlers.';
    }
  }

  const requestWithDirtyGuard = (action: () => void) => {
    if (!formState.isDirty) {
      action();
      return;
    }
    pendingDiscardActionRef.current = action;
    setDiscardDialogOpen(true);
  };

  const cancel = () => {
    requestWithDirtyGuard(() => {
      if (isCreateMode) {
        navigate('/crawlers');
        return;
      }
      formState.resetToPristine();
      modeState.exitEdit();
    });
  };

  const navigateBack = () => {
    requestWithDirtyGuard(() => {
      navigate('/crawlers');
    });
  };

  const discardDialog = {
    open: discardDialogOpen,
    onOpenChange: (open: boolean) => {
      setDiscardDialogOpen(open);
      if (!open) pendingDiscardActionRef.current = null;
    },
    onConfirm: () => {
      const action = pendingDiscardActionRef.current;
      pendingDiscardActionRef.current = null;
      setDiscardDialogOpen(false);
      action?.();
    },
  };

  const save = async () => {
    if (!formState.form) return;
    if (inFlightRef.current) return;

    const parsedInputSchema = tryParseSchema(formState.form.input_schema);
    const parsedOutputSchema = tryParseSchema(formState.form.output_schema);

    if (parsedInputSchema === undefined) {
      formState.setSchemaError('input_schema', 'Must be a valid JSON object.');
      showToast('Error', 'Input schema is not valid JSON.', 'error');
      return;
    }
    if (parsedOutputSchema === undefined) {
      formState.setSchemaError('output_schema', 'Must be a valid JSON object.');
      showToast('Error', 'Output schema is not valid JSON.', 'error');
      return;
    }
    if (!trimmedName) {
      showToast('Error', 'Name cannot be empty.', 'error');
      return;
    }
    if (!formState.form.code.trim()) {
      showToast('Error', 'Code cannot be empty.', 'error');
      return;
    }
    if (crawlerType === 'web' && !trimmedURLPattern) {
      showToast('Error', 'URL pattern cannot be empty for web crawlers.', 'error');
      return;
    }

    if (isCreateMode) {
      inFlightRef.current = true;
      try {
        const created = await createCrawler({
          name: trimmedName,
          url_pattern: trimmedURLPattern,
          code: formState.form.code,
        });
        showToast('Created', `Crawler "${trimmedName}" has been created.`, 'success');
        navigate(`/crawlers/${created.id}`);
      } catch (createError) {
        const message = createError instanceof Error ? createError.message : 'Failed to create crawler';
        showToast('Error', message, 'error');
      } finally {
        inFlightRef.current = false;
      }
      return;
    }

    if (!crawler) return;

    inFlightRef.current = true;
    try {
      const payload =
        crawler.type === 'data'
          ? {
              id: crawler.id,
              type: 'data' as const,
              name: trimmedName,
              code: formState.form.code,
              input_schema: parsedInputSchema,
              output_schema: parsedOutputSchema,
            }
          : {
              id: crawler.id,
              type: 'web' as const,
              name: trimmedName,
              url_pattern: trimmedURLPattern,
              code: formState.form.code,
              output_schema: parsedOutputSchema,
            };

      const submittedForm = formState.form;
      const updated = await updateCrawler(payload);
      const next = deriveFormState(updated);
      formState.markSaved(submittedForm, next);
      modeState.exitEdit();
      showToast('Saved', `Crawler "${trimmedName}" has been updated.`, 'success');
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : 'Failed to save crawler';
      showToast('Error', message, 'error');
    } finally {
      inFlightRef.current = false;
    }
  };

  return {
    mode: modeState.mode,
    isCreateMode,
    isEditable: modeState.isEditable,
    crawler,
    crawlerType,
    isLoading: isCreateMode ? false : isLoading,
    error: isCreateMode ? null : error,
    refetch,
    form: formState.form,
    setForm: formState.setForm,
    schemaErrors: formState.schemaErrors,
    isDirty: formState.isDirty,
    canSubmit,
    disabledReason,
    isSaving,
    enterEdit: modeState.enterEdit,
    cancel,
    save,
    navigateBack,
    changeSchema: formState.changeSchema,
    validateSchemaField: formState.validateSchemaField,
    discardDialog,
  };
}
