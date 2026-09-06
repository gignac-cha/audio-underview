import { useParams } from 'react-router';
import { PageShell } from '../components/PageShell.tsx';
import { CrawlerEditorContent } from '../features/crawlers/CrawlerEditorContent.tsx';

/** new/detail 통합 라우트. id 변경 시 key로 전체 상태 리셋 (보존 §1, 스펙 §4.3.1). */
export const CrawlerEditorPage = () => {
  const { id } = useParams();
  return (
    <PageShell wide>
      <CrawlerEditorContent key={id ?? 'new'} id={id} />
    </PageShell>
  );
};
