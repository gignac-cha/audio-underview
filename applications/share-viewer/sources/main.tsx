import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { ViewerThemeProvider } from './themes/ViewerThemeProvider.tsx';
import { ApplicationRoutes } from './Application.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ViewerThemeProvider>
      <BrowserRouter>
        <ApplicationRoutes />
      </BrowserRouter>
    </ViewerThemeProvider>
  </StrictMode>,
);
