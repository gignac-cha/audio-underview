import clsx from 'clsx';
import { Button } from '../../components/Button.tsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.tsx';
import { Icon } from '../../components/Icon.tsx';
import { Spinner } from '../../components/Spinner.tsx';
import { CodePanel } from './components/CodePanel.tsx';
import { DetailsSection } from './components/DetailsSection.tsx';
import { EditorTopBar } from './components/EditorTopBar.tsx';
import { SchemaSection } from './components/SchemaSection.tsx';
import { TestPanel } from './components/TestPanel.tsx';
import { useCrawlerEditor } from './hooks/use-crawler-editor.ts';
import styles from './CrawlerEditorContent.module.css';

/** 크롤러 에디터 본문 (스펙 §4.3). key={id}로 마운트되어 id 변경 시 전체 상태 리셋. */
export const CrawlerEditorContent = ({ id }: { id: string | undefined }) => {
  const editor = useCrawlerEditor(id);

  if (!editor.isCreate && editor.loadError !== undefined && editor.crawler === undefined) {
    return (
      <div className={styles.state} role="alert">
        <span className={styles.stateIcon}>
          <Icon name="alert" size={22} />
        </span>
        <p className={styles.stateTitle}>Failed to load crawler.</p>
        <p className={styles.stateDescription}>{editor.loadError.message}</p>
        <Button variant="secondary" onClick={editor.retry}>
          Retry
        </Button>
      </div>
    );
  }

  if (!editor.isCreate && editor.isLoadingCrawler && editor.crawler === undefined) {
    return (
      <div className={styles.centered}>
        <Spinner size={26} label="Loading crawler…" />
      </div>
    );
  }

  const title = editor.isCreate ? 'New Crawler' : editor.form.name;
  const isDraft = editor.isDirty && editor.isEditable;

  return (
    <div className={styles.content}>
      <EditorTopBar
        mode={editor.mode}
        title={title}
        isDirty={editor.isDirty}
        showTestPanel={editor.showTestPanel}
        canSubmit={editor.canSubmit}
        disabledReason={editor.disabledReason}
        isSaving={editor.isSaving}
        onBack={editor.handleBack}
        onToggleTest={editor.toggleTestPanel}
        onEdit={editor.enterEdit}
        onCancel={editor.handleCancel}
        onSave={editor.save}
      />

      <div className={clsx(styles.body, editor.showTestPanel ? styles.split : styles.single)}>
        <div className={styles.formColumn}>
          <DetailsSection
            form={editor.form}
            isEditable={editor.isEditable}
            crawlerType={editor.crawlerType}
            crawler={editor.crawler}
            autoFocusName={editor.isEditable}
            onNameChange={(value) => {
              editor.setField('name', value);
            }}
            onURLPatternChange={(value) => {
              editor.setField('url_pattern', value);
            }}
          />

          <CodePanel
            value={editor.form.code}
            readOnly={!editor.isEditable}
            onChange={(value) => {
              editor.setField('code', value);
            }}
          />

          {!editor.isCreate && (
            <SchemaSection
              form={editor.form}
              crawlerType={editor.crawlerType}
              isEditable={editor.isEditable}
              schemaErrors={editor.schemaErrors}
              onChangeSchema={editor.changeSchema}
              onBlurSchema={editor.validateSchema}
            />
          )}
        </div>

        {editor.showTestPanel && (
          <TestPanel
            crawlerType={editor.crawlerType}
            isDraft={isDraft}
            testURL={editor.testURL}
            testData={editor.testData}
            canRunTest={editor.canRunTest}
            onURLChange={editor.setTestURL}
            onDataChange={editor.setTestData}
            onRun={editor.runTest}
            runner={editor.runner}
          />
        )}
      </div>

      <ConfirmDialog
        open={editor.discardOpen}
        title="Discard unsaved changes?"
        description="You have unsaved changes. If you leave now, they will be lost."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        confirmVariant="danger"
        initialFocus="cancel"
        onConfirm={editor.onDiscardConfirm}
        onCancel={editor.onDiscardCancel}
      />
    </div>
  );
};
