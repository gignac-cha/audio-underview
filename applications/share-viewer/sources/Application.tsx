/**
 * Three routes and nothing else. There is no authentication provider, no
 * protected route, and no analytics — a share link must work for a stranger
 * with no account and leave no trace of them behind.
 */

import { Route, Routes } from 'react-router';
import { SharePage } from './pages/SharePage.tsx';
import { LandingPage } from './pages/LandingPage.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';

export function ApplicationRoutes() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/share/:token" element={<SharePage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
