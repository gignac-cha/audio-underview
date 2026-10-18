import styled from '@emotion/styled';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faDownload } from '@fortawesome/free-solid-svg-icons';
import { useDownloadCrawlerFile } from '../../hooks/use-crawler-runs.ts';
import type { CrawlerFileReference } from './crawler-file-references.ts';

const Container = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
`;

const Label = styled.div`
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
`;

const List = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  overflow: hidden;
`;

const Row = styled.li`
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.25rem 0.75rem;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--border-subtle);

  &:last-child {
    border-bottom: none;
  }
`;

const FileName = styled.span`
  font-size: 0.8125rem;
  font-family: var(--font-mono);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const FileMeta = styled.span`
  grid-column: 1;
  font-size: 0.6875rem;
  color: var(--text-muted);
`;

const DownloadButton = styled.button`
  grid-column: 2;
  grid-row: 1 / span 2;
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.75rem;
  border-radius: 6px;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--text-secondary);
  border: 1px solid var(--border-subtle);
  cursor: pointer;
  transition: color 120ms ease, border-color 120ms ease;

  &:hover:not(:disabled) {
    color: var(--text-primary);
    border-color: var(--border-focus);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
`;

const DownloadError = styled.span`
  grid-column: 1 / -1;
  font-size: 0.75rem;
  color: var(--color-error);
`;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kibibytes = bytes / 1024;
  if (kibibytes < 1024) return `${kibibytes.toFixed(1)} KB`;
  return `${(kibibytes / 1024).toFixed(1)} MB`;
}

function FileRow({ file }: { file: CrawlerFileReference }) {
  const { downloadFile, status, error } = useDownloadCrawlerFile();
  const displayName = file.name ?? file.file_id;

  return (
    <Row>
      <FileName title={displayName}>{displayName}</FileName>
      <FileMeta>
        {file.content_type} · {formatSize(file.size)}
      </FileMeta>
      <DownloadButton
        type="button"
        onClick={() => downloadFile({ fileID: file.file_id, fileName: file.name })}
        disabled={status === 'pending'}
        aria-label={`Download ${displayName}`}
      >
        <FontAwesomeIcon icon={faDownload} aria-hidden={true} />
        Download
      </DownloadButton>
      {error && <DownloadError role="alert">{error.message}</DownloadError>}
    </Row>
  );
}

interface FileListPanelProperties {
  files: CrawlerFileReference[];
}

export function FileListPanel({ files }: FileListPanelProperties) {
  return (
    <Container>
      <Label>Files</Label>
      <List>
        {files.map((file) => (
          <FileRow key={file.file_id} file={file} />
        ))}
      </List>
    </Container>
  );
}
