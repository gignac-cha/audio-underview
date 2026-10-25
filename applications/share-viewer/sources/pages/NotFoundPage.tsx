/** Any route that is neither the landing page nor a share link. */

import { NoticeScreen } from '../components/NoticeScreen.tsx';
import { ViewerHeader } from '../components/ViewerHeader.tsx';

export function NotFoundPage() {
  return (
    <>
      <ViewerHeader />
      <NoticeScreen heading="페이지를 찾을 수 없습니다">
        주소를 다시 확인해 주세요. 공유 링크는 /share/ 로 시작합니다.
      </NoticeScreen>
    </>
  );
}
