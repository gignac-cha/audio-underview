/**
 * `/` — deliberately almost empty. This deployment exists to serve share links;
 * anyone who lands on the root got here by trimming a URL, so the only useful
 * thing to offer is the main service.
 */

import { NoticeScreen } from '../components/NoticeScreen.tsx';
import { ViewerHeader } from '../components/ViewerHeader.tsx';

export function LandingPage() {
  return (
    <>
      <ViewerHeader />
      <NoticeScreen heading="공유된 뉴스캐스트 보기">
        이 페이지는 공유 링크를 여는 용도입니다. 공유받은 주소로 들어오면 로그인 없이
        바로 들을 수 있습니다.
      </NoticeScreen>
    </>
  );
}
