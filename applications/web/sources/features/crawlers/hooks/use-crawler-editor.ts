import type { CrawlerType, PlainObject } from '@audio-underview/schemas';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useCreateCrawler, useGetCrawler, useUpdateCrawler } from '../../../api/crawlers.ts';
import { toErrorMessage } from '../../../api/errors.ts';
import { useBeforeUnload } from '../../../hooks/use-before-unload.ts';
import { useNavigationBlocker } from '../../../hooks/use-navigation-blocker.ts';
import { isModifierPressed } from '../../../hooks/use-platform.ts';
import { useToasts } from '../../../state/toasts.ts';
import { deriveFormState, tryParseSchema, type FormState } from './crawler-form-helpers.ts';
import { useCrawlerCodeRunner } from './use-crawler-code-runner.ts';
import { useCrawlerForm } from './use-crawler-form.ts';
import { useEditorMode } from './use-editor-mode.ts';

const TEST_PANEL_STORAGE_KEY = 'audio-underview:crawler-test-panel';
const SCHEMA_ERROR_MESSAGE = 'Must be a valid JSON object.';

const readTestPanelPreference = (): boolean => {
  try {
    return localStorage.getItem(TEST_PANEL_STORAGE_KEY) !== 'closed';
  } catch {
    return true;
  }
};

const isValidURL = (value: string): boolean => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};

const isFocusInFormElement = (): boolean => {
  const active = document.activeElement;
  if (active === null) {
    return false;
  }
  const tag = active.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    (active instanceof HTMLElement && active.isContentEditable)
  );
};

/**
 * 크롤러 에디터 오케스트레이터 (스펙 §4.3). 모드 머신 + 폼 + manager 훅 +
 * dirty guard(discard/blocker/beforeunload) + save 파이프라인 + 단축키 + 테스트 러너.
 */
export const useCrawlerEditor = (id: string | undefined) => {
  const isCreate = id === 'new';
  const detailID = isCreate ? undefined : id;

  const { crawler, isLoading, error, refetch } = useGetCrawler(detailID);
  const { mode, isEditable, enterEdit, exitToView } = useEditorMode(isCreate);
  const formApi = useCrawlerForm();
  const { createCrawler } = useCreateCrawler();
  const { updateCrawler } = useUpdateCrawler();
  const runner = useCrawlerCodeRunner();
  const { showSuccess, showError } = useToasts();
  const navigate = useNavigate();

  const crawlerType: CrawlerType = isCreate ? 'web' : (crawler?.type ?? 'web');

  // ---- 서버 데이터 seed (crawler.id 단위 1회, 렌더 중 조건부 setState) ----
  const seededIDRef = useRef<string | null>(null);
  if (crawler !== undefined && seededIDRef.current !== crawler.id) {
    seededIDRef.current = crawler.id;
    formApi.reset(deriveFormState(crawler));
  }

  // ---- 테스트 패널 표시 (view=토글+영속 / edit·create=강제 on) ----
  const [testPanelPreference, setTestPanelPreference] = useState(readTestPanelPreference);
  const showTestPanel = isEditable || testPanelPreference;
  const toggleTestPanel = useCallback(() => {
    setTestPanelPreference((previous) => {
      const next = !previous;
      try {
        localStorage.setItem(TEST_PANEL_STORAGE_KEY, next ? 'open' : 'closed');
      } catch {
        // 영속 실패 무시
      }
      return next;
    });
  }, []);

  // ---- 테스트 입력 ----
  const [testURL, setTestURL] = useState('');
  const [testData, setTestData] = useState('');

  const { form, isDirty, schemaErrors, hasSchemaError, markSaved, restore } = formApi;

  // ---- canSubmit / disabledReason (스펙 §4.3.7) ----
  const nameFilled = form.name.trim().length > 0;
  const codeFilled = form.code.trim().length > 0;
  const urlFilled = form.url_pattern.trim().length > 0;
  const urlSatisfied = crawlerType === 'data' || urlFilled;
  const canSubmit =
    (isCreate || isDirty) && !hasSchemaError && nameFilled && codeFilled && urlSatisfied;

  let disabledReason: string | undefined;
  if (!isCreate && !isDirty) {
    disabledReason = 'No changes to save.';
  } else if (hasSchemaError) {
    disabledReason = 'Fix schema errors before saving.';
  } else if (!nameFilled) {
    disabledReason = 'Name is required.';
  } else if (!codeFilled) {
    disabledReason = 'Code cannot be empty.';
  } else if (!urlSatisfied) {
    disabledReason = 'URL pattern is required for web crawlers.';
  }

  // ---- dirty guard: beforeunload + SPA blocker ----
  const guardRef = useRef({ isEditable, isDirty, bypass: false });
  guardRef.current.isEditable = isEditable;
  guardRef.current.isDirty = isDirty;
  useBeforeUnload(isEditable && isDirty);
  const shouldBlock = useCallback(
    () => !guardRef.current.bypass && guardRef.current.isEditable && guardRef.current.isDirty,
    [],
  );
  const navigationBlock = useNavigationBlocker(shouldBlock);

  // 편집 취소(edit) 전용 discard 확인 — 네비게이션이 아니므로 blocker가 못 잡는다.
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);

  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);

  const save = useCallback(async () => {
    if (savingRef.current) {
      return;
    }
    const submitted = form;

    let inputSchema: PlainObject | undefined;
    let outputSchema: PlainObject | undefined;
    if (!isCreate) {
      const outputParsed = tryParseSchema(form.output_schema);
      if (!outputParsed.ok) {
        formApi.setSchemaError('output_schema', SCHEMA_ERROR_MESSAGE);
        showError('Invalid schema', 'Output schema must be a valid JSON object.');
        return;
      }
      outputSchema = outputParsed.value;
      if (crawlerType === 'data') {
        const inputParsed = tryParseSchema(form.input_schema);
        if (!inputParsed.ok) {
          formApi.setSchemaError('input_schema', SCHEMA_ERROR_MESSAGE);
          showError('Invalid schema', 'Input schema must be a valid JSON object.');
          return;
        }
        inputSchema = inputParsed.value;
      }
    }

    const name = form.name.trim();
    if (name.length === 0) {
      showError('Name is required.');
      return;
    }
    if (form.code.trim().length === 0) {
      showError('Code cannot be empty.');
      return;
    }
    const urlPattern = form.url_pattern.trim();
    if (crawlerType === 'web' && urlPattern.length === 0) {
      showError('URL pattern is required for web crawlers.');
      return;
    }

    savingRef.current = true;
    setIsSaving(true);
    try {
      if (isCreate) {
        const created = await createCrawler({ name, url_pattern: urlPattern, code: form.code });
        markSaved(submitted);
        showSuccess(`Crawler "${created.name}" has been created.`);
        guardRef.current.bypass = true;
        void navigate(`/crawlers/${created.id}`);
      } else if (detailID !== undefined) {
        const body =
          crawlerType === 'data'
            ? {
                type: 'data' as const,
                name,
                code: form.code,
                input_schema: inputSchema ?? {},
                output_schema: outputSchema ?? {},
              }
            : {
                type: 'web' as const,
                name,
                url_pattern: urlPattern,
                code: form.code,
                output_schema: outputSchema ?? {},
              };
        const updated = await updateCrawler({ id: detailID, body });
        const unchanged = markSaved(submitted);
        showSuccess(`Crawler "${updated.name}" has been updated.`);
        if (unchanged) {
          exitToView();
        }
      }
    } catch (saveError) {
      showError('Save failed', toErrorMessage(saveError));
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }, [
    form,
    isCreate,
    detailID,
    crawlerType,
    createCrawler,
    updateCrawler,
    markSaved,
    exitToView,
    navigate,
    showError,
    showSuccess,
    formApi,
  ]);

  const canRunTest =
    runner.status !== 'running' &&
    (crawlerType === 'data' || (testURL.trim().length > 0 && isValidURL(testURL.trim())));

  const runTest = useCallback(() => {
    if (runner.status === 'running') {
      return;
    }
    if (crawlerType === 'web') {
      const url = testURL.trim();
      if (url.length === 0 || !isValidURL(url)) {
        return;
      }
      runner.run({ type: 'web', url, code: form.code });
      return;
    }
    let data: unknown;
    const text = testData.trim();
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        showError('Invalid data', 'Test input must be valid JSON.');
        return;
      }
    }
    runner.run({ type: 'data', data, code: form.code });
  }, [crawlerType, testURL, testData, form.code, runner, showError]);

  // ---- 취소 / 뒤로 ----
  const handleCancel = useCallback(() => {
    if (isCreate) {
      void navigate('/crawlers');
      return;
    }
    if (isDirty) {
      setCancelConfirmOpen(true);
    } else {
      exitToView();
    }
  }, [isCreate, isDirty, navigate, exitToView]);

  const handleBack = useCallback(() => {
    void navigate('/crawlers');
  }, [navigate]);

  const discardOpen = navigationBlock.isBlocked || cancelConfirmOpen;
  const onDiscardConfirm = useCallback(() => {
    if (navigationBlock.isBlocked) {
      navigationBlock.confirm();
    } else {
      restore();
      exitToView();
      setCancelConfirmOpen(false);
    }
  }, [navigationBlock, restore, exitToView]);
  const onDiscardCancel = useCallback(() => {
    if (navigationBlock.isBlocked) {
      navigationBlock.cancel();
    } else {
      setCancelConfirmOpen(false);
    }
  }, [navigationBlock]);

  // ---- 키보드 단축키 (document keydown; 최신 상태는 ref로 참조) ----
  const shortcutRef = useRef({
    isEditable,
    mode,
    canSubmit,
    isSaving,
    showTestPanel,
    canRunTest,
    save,
    enterEdit,
    runTest,
  });
  shortcutRef.current = {
    isEditable,
    mode,
    canSubmit,
    isSaving,
    showTestPanel,
    canRunTest,
    save,
    enterEdit,
    runTest,
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isModifierPressed(event)) {
        return;
      }
      const current = shortcutRef.current;
      const key = event.key.toLowerCase();
      if (key === 's' && current.isEditable) {
        event.preventDefault();
        if (current.canSubmit && !current.isSaving) {
          void current.save();
        }
      } else if (key === 'e' && current.mode === 'view' && !isFocusInFormElement()) {
        event.preventDefault();
        current.enterEdit();
      } else if (event.key === 'Enter' && current.showTestPanel && current.canRunTest) {
        event.preventDefault();
        current.runTest();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  return {
    isCreate,
    mode,
    isEditable,
    crawlerType,
    crawler,
    isLoadingCrawler: isLoading,
    loadError: error,
    retry: () => {
      void refetch();
    },
    // form
    form,
    schemaErrors,
    isDirty,
    setField: formApi.setField,
    changeSchema: formApi.changeSchema,
    validateSchema: formApi.validateSchema,
    // actions
    canSubmit,
    disabledReason,
    isSaving,
    enterEdit,
    save: () => {
      void save();
    },
    handleCancel,
    handleBack,
    // discard dialog
    discardOpen,
    onDiscardConfirm,
    onDiscardCancel,
    // test panel
    showTestPanel,
    toggleTestPanel,
    testURL,
    setTestURL,
    testData,
    setTestData,
    runTest,
    canRunTest,
    runner,
  };
};

export type CrawlerEditor = ReturnType<typeof useCrawlerEditor>;

export type { FormState };
