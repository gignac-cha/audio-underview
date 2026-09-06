import type { Crawler, PlainObject } from '@audio-underview/schemas';
import { useState } from 'react';
import { useListCrawlers } from '../../../api/crawlers.ts';
import { toErrorMessage } from '../../../api/errors.ts';
import { useCreateStage } from '../../../api/schedulers.ts';
import { Button } from '../../../components/Button.tsx';
import { TextArea, TextField } from '../../../components/FormControls.tsx';
import { Modal } from '../../../components/Modal.tsx';
import { useToasts } from '../../../state/toasts.ts';
import { tryParseSchema } from '../../crawlers/hooks/crawler-form-helpers.ts';
import styles from './StageCreateDialog.module.css';

export interface StageCreateDialogProps {
  open: boolean;
  schedulerID: string;
  nextOrder: number;
  onClose: () => void;
}

type SchemaMode = 'simple' | 'json';

const buildDefaultSchema = (crawler: Crawler): PlainObject =>
  crawler.type === 'web' ? { url: { type: 'string', default: '' } } : crawler.input_schema;

export const StageCreateDialog = ({
  open,
  schedulerID,
  nextOrder,
  onClose,
}: StageCreateDialogProps) => {
  const crawlerList = useListCrawlers();
  const { createStage, status } = useCreateStage(schedulerID);
  const { showSuccess, showError } = useToasts();

  const [selectedID, setSelectedID] = useState('');
  const [mode, setMode] = useState<SchemaMode>('simple');
  const [simpleURL, setSimpleURL] = useState('');
  const [jsonText, setJsonText] = useState('{}');
  const [fanOutField, setFanOutField] = useState('');

  const busy = status === 'pending';
  const selectedCrawler = crawlerList.crawlers.find((crawler) => crawler.id === selectedID);

  const reset = () => {
    setSelectedID('');
    setMode('simple');
    setSimpleURL('');
    setJsonText('{}');
    setFanOutField('');
  };

  const handleClose = () => {
    if (!busy) {
      reset();
      onClose();
    }
  };

  const handleSelectCrawler = (id: string) => {
    setSelectedID(id);
    const crawler = crawlerList.crawlers.find((candidate) => candidate.id === id);
    if (crawler !== undefined) {
      setMode('simple');
      setSimpleURL('');
      setJsonText(JSON.stringify(buildDefaultSchema(crawler), null, 2));
    }
  };

  const resolveInputSchema = (): PlainObject | null => {
    if (selectedCrawler === undefined) {
      return null;
    }
    if (mode === 'simple' && selectedCrawler.type === 'web') {
      return { url: { type: 'string', default: simpleURL } };
    }
    const parsed = tryParseSchema(jsonText);
    return parsed.ok ? parsed.value : null;
  };

  const handleSubmit = async () => {
    if (selectedCrawler === undefined) {
      showError('Select a crawler', 'Choose a crawler to add to the pipeline.');
      return;
    }
    const inputSchema = resolveInputSchema();
    if (inputSchema === null) {
      showError('Invalid input schema', 'Invalid JSON in input schema.');
      return;
    }
    const trimmedFanOut = fanOutField.trim();
    try {
      await createStage({
        crawler_id: selectedCrawler.id,
        stage_order: nextOrder,
        input_schema: inputSchema,
        ...(trimmedFanOut.length > 0 ? { fan_out_field: trimmedFanOut } : {}),
      });
      showSuccess('Stage added to pipeline.');
      reset();
      onClose();
    } catch (error) {
      showError('Add stage failed', toErrorMessage(error));
    }
  };

  const showSimpleURL = mode === 'simple' && selectedCrawler?.type === 'web';

  return (
    <Modal
      open={open}
      title="Add Stage"
      busy={busy}
      onClose={handleClose}
      footer={
        <>
          <Button variant="ghost" onClick={handleClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || selectedID.length === 0}
            onClick={() => void handleSubmit()}
          >
            {busy ? 'Adding…' : 'Add Stage'}
          </Button>
        </>
      }
    >
      <div className={styles.field}>
        <label htmlFor="stage-crawler" className={styles.label}>
          Crawler
        </label>
        <select
          id="stage-crawler"
          className={styles.select}
          value={selectedID}
          onChange={(event) => {
            handleSelectCrawler(event.target.value);
          }}
        >
          <option value="">Select a crawler…</option>
          {crawlerList.crawlers.map((crawler) => (
            <option key={crawler.id} value={crawler.id}>
              {crawler.name} ({crawler.type})
            </option>
          ))}
        </select>
        {crawlerList.hasNextPage && (
          <Button
            variant="ghost"
            size="small"
            disabled={crawlerList.isFetchingNextPage}
            onClick={() => void crawlerList.fetchNextPage()}
          >
            {crawlerList.isFetchingNextPage ? 'Loading…' : 'Load more crawlers'}
          </Button>
        )}
      </div>

      {selectedCrawler !== undefined && (
        <>
          <div className={styles.modeRow}>
            <span className={styles.label}>Input schema</span>
            <button
              type="button"
              className={styles.modeToggle}
              onClick={() => {
                setMode((previous) => (previous === 'simple' ? 'json' : 'simple'));
              }}
            >
              {mode === 'simple' ? 'Edit JSON' : 'Simple mode'}
            </button>
          </div>

          {showSimpleURL ? (
            <TextField
              type="url"
              label="Default URL"
              placeholder="https://example.com"
              value={simpleURL}
              onChange={(event) => {
                setSimpleURL(event.target.value);
              }}
            />
          ) : (
            <TextArea
              monospace
              rows={5}
              aria-label="Input schema JSON"
              value={jsonText}
              onChange={(event) => {
                setJsonText(event.target.value);
              }}
            />
          )}
        </>
      )}

      <TextField
        label="Fan-out field (optional)"
        placeholder="items"
        value={fanOutField}
        onChange={(event) => {
          setFanOutField(event.target.value);
        }}
      />
    </Modal>
  );
};
