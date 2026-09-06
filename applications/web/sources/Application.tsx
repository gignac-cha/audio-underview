import type { ReactNode } from 'react';
import { Navigate, createBrowserRouter, type RouteObject } from 'react-router';
import { ProtectedRoute } from './components/ProtectedRoute.tsx';
import { AuthenticationCallbackPage } from './pages/AuthenticationCallbackPage.tsx';
import { CrawlerEditorPage } from './pages/CrawlerEditorPage.tsx';
import { CrawlersPage } from './pages/CrawlersPage.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { RootRedirect } from './pages/RootRedirect.tsx';
import { SchedulerDetailPage } from './pages/SchedulerDetailPage.tsx';
import { SchedulersPage } from './pages/SchedulersPage.tsx';
import { SignInPage } from './pages/SignInPage.tsx';

const protectedRoute = (element: ReactNode): ReactNode => (
  <ProtectedRoute>{element}</ProtectedRoute>
);

/** 앱 라우트 정의 (data router — dirty guard blocker 지원). 테스트도 이 배열을 재사용. */
export const applicationRoutes: RouteObject[] = [
  { path: '/', element: <RootRedirect /> },
  { path: '/sign/in', element: <SignInPage /> },
  { path: '/authentication/callback', element: <AuthenticationCallbackPage /> },
  { path: '/home', element: protectedRoute(<HomePage />) },
  { path: '/crawlers', element: protectedRoute(<CrawlersPage />) },
  { path: '/crawlers/:id', element: protectedRoute(<CrawlerEditorPage />) },
  { path: '/schedulers', element: protectedRoute(<SchedulersPage />) },
  { path: '/schedulers/:id', element: protectedRoute(<SchedulerDetailPage />) },
  { path: '*', element: <Navigate to="/" replace /> },
];

export const createApplicationRouter = () => createBrowserRouter(applicationRoutes);
