import { useParams } from 'react-router';
import { PageShell } from '../components/PageShell.tsx';
import { SchedulerDetailContent } from '../features/schedulers/SchedulerDetailContent.tsx';

export const SchedulerDetailPage = () => {
  const { id } = useParams();
  return (
    <PageShell>
      {id === undefined ? null : <SchedulerDetailContent key={id} id={id} />}
    </PageShell>
  );
};
