import { useAuth } from 'react-oidc-context';
import CognitoAuth from './components/CognitoAuth';
import { useRuntimeConfig } from './hooks/useRuntimeConfig';
import RuntimeConfigProvider from './components/RuntimeConfig';
import { ToastProvider } from './components/Toast';
import { WebSocketProvider } from './contexts/WebSocketContext';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import CustomerUploadPage from './components/CustomerUploadPage';
import './i18n';

export type RouterProviderContext = {
  runtimeConfig?: ReturnType<typeof useRuntimeConfig>;
  auth?: ReturnType<typeof useAuth>;
};

const router = createRouter({
  routeTree,
  context: {
    runtimeConfig: undefined,
    auth: undefined,
  },
});

// Register the router instance for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const App = () => {
  const auth = useAuth();
  const runtimeConfig = useRuntimeConfig();
  return <RouterProvider router={router} context={{ runtimeConfig, auth }} />;
};

// The customer's upload link page (/u#<token>) has no login: it gets only
// the runtime config (backend URL), not Cognito, the websocket or the router.
const isCustomerUploadPage = /^\/u\/?$/.test(window.location.pathname);

const root = document.getElementById('root');
if (root && isCustomerUploadPage) {
  createRoot(root).render(
    <React.StrictMode>
      <RuntimeConfigProvider>
        <CustomerUploadPage />
      </RuntimeConfigProvider>
    </React.StrictMode>,
  );
} else if (root) {
  createRoot(root).render(
    <React.StrictMode>
      <RuntimeConfigProvider>
        <CognitoAuth>
          <WebSocketProvider>
            <ToastProvider>
              <App />
            </ToastProvider>
          </WebSocketProvider>
        </CognitoAuth>
      </RuntimeConfigProvider>
    </React.StrictMode>,
  );
}
