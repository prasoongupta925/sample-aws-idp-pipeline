import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import { useAuth } from 'react-oidc-context';
import { fromCognitoIdentityPool } from '@aws-sdk/credential-provider-cognito-identity';
import { useRuntimeConfig } from '../hooks/useRuntimeConfig';
import { createSignedWebSocketUrl } from '../lib/websocket-signer';
import type {
  WebSocketStatus,
  WebSocketMessage,
  MessageCallback,
  Unsubscribe,
} from '../types/websocket';

const CREDENTIAL_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_RECONNECT_INTERVAL = 3000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const DEFAULT_BACKOFF_MULTIPLIER = 1.5;
const HEARTBEAT_INTERVAL = 30000; // 30 seconds

interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

interface WebSocketContextValue {
  status: WebSocketStatus;
  subscribe: <T>(action: string, callback: MessageCallback<T>) => Unsubscribe;
  sendMessage: <T>(message: WebSocketMessage<T>) => void;
}

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

/**
 * Close a socket we no longer use and detach its handlers first: its late events (a close
 * that lands after its replacement opened) must not touch the current socket's ref,
 * status or heartbeat.
 */
function retireSocket(ws: WebSocket | null) {
  if (!ws) return;
  ws.onopen = null;
  ws.onmessage = null;
  ws.onerror = null;
  ws.onclose = null;
  ws.close(1000, 'Manual disconnect');
}

export function WebSocketProvider({ children }: PropsWithChildren) {
  const { cognitoProps, websocketUrl } = useRuntimeConfig();
  const { user } = useAuth();

  const [status, setStatus] = useState<WebSocketStatus>('disconnected');

  const wsRef = useRef<WebSocket | null>(null);
  const credentialsRef = useRef<Credentials | null>(null);
  const pendingCredentialsRef = useRef<Promise<Credentials> | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const heartbeatIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const isManualDisconnectRef = useRef(false);
  const isConnectingRef = useRef(false);
  // Bumped on every connect() start and on disconnect(). An in-flight async
  // connect() compares its captured value to detect that it was superseded by a
  // newer connect or a teardown, and bails before creating a socket.
  const connectionGenRef = useRef(0);
  const subscribersRef = useRef<Map<string, Set<MessageCallback>>>(new Map());
  // Reconnect timers call the latest connect(), never one built with an older id_token.
  const connectRef = useRef<() => Promise<void>>(async () => undefined);

  /** Get AWS credentials from the Cognito Identity Pool */
  const getCredentials = useCallback(async (): Promise<Credentials> => {
    if (!cognitoProps || !user?.id_token) {
      throw new Error('Cognito props or user token not available');
    }

    const cached = credentialsRef.current;
    const isValid =
      cached?.expiration &&
      cached.expiration.getTime() - Date.now() > CREDENTIAL_REFRESH_BUFFER_MS;

    if (isValid) return cached;

    if (pendingCredentialsRef.current) return pendingCredentialsRef.current;

    pendingCredentialsRef.current = fromCognitoIdentityPool({
      clientConfig: { region: cognitoProps.region },
      identityPoolId: cognitoProps.identityPoolId,
      logins: {
        [`cognito-idp.${cognitoProps.region}.amazonaws.com/${cognitoProps.userPoolId}`]:
          user.id_token,
      },
    })()
      .then((credentials) => {
        credentialsRef.current = credentials;
        return credentials;
      })
      .finally(() => {
        pendingCredentialsRef.current = null;
      });

    return pendingCredentialsRef.current;
  }, [cognitoProps, user]);

  /** Close the WebSocket connection */
  const disconnect = useCallback(() => {
    isManualDisconnectRef.current = true;
    // Invalidate any in-flight connect() and clear the connecting latch so a
    // subsequent connect() isn't permanently blocked.
    connectionGenRef.current += 1;
    isConnectingRef.current = false;

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }

    retireSocket(wsRef.current);
    wsRef.current = null;

    setStatus('disconnected');
    reconnectAttemptsRef.current = 0;
  }, []);

  /** Open the WebSocket connection */
  const connect = useCallback(async () => {
    if (!websocketUrl || !cognitoProps) {
      return;
    }

    // Prevent duplicate connections (especially in React StrictMode)
    if (
      isConnectingRef.current ||
      wsRef.current?.readyState === WebSocket.OPEN
    ) {
      return;
    }

    // A socket that is still connecting or closing is replaced.
    retireSocket(wsRef.current);
    wsRef.current = null;

    isConnectingRef.current = true;
    isManualDisconnectRef.current = false;
    // Snapshot the generation for this attempt. disconnect() (teardown) and any
    // newer connect() bump the counter, letting us detect a stale attempt after
    // the awaits below.
    const gen = (connectionGenRef.current += 1);
    setStatus('connecting');

    let signedUrl: string;
    try {
      const credentials = await getCredentials();
      signedUrl = await createSignedWebSocketUrl({
        websocketUrl,
        credentials,
        region: cognitoProps.region,
      });
    } catch (err) {
      // Signing/credentials failed — reset the flag so future connects aren't
      // permanently blocked, and don't leave status stuck on 'connecting'.
      console.error('WebSocket connect failed during signing:', err);
      if (gen === connectionGenRef.current) {
        isConnectingRef.current = false;
        setStatus('error');
      }
      return;
    }

    // A newer connect() or a teardown happened while we were awaiting signing —
    // this attempt is stale, so abort before creating the socket / touching state.
    if (gen !== connectionGenRef.current) {
      return;
    }

    const ws = new WebSocket(signedUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (wsRef.current !== ws) {
        ws.close(1000, 'Superseded');
        return;
      }
      isConnectingRef.current = false;
      setStatus('connected');
      reconnectAttemptsRef.current = 0;

      // Start heartbeat to detect stale connections
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
      }
      heartbeatIntervalRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: 'ping' }));
        }
      }, HEARTBEAT_INTERVAL);
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data) as WebSocketMessage;
      const callbacks = subscribersRef.current.get(message.action);
      callbacks?.forEach((callback) => callback(message.data));
    };

    ws.onerror = (event) => {
      console.error('WebSocket error:', event);
    };

    ws.onclose = (event) => {
      // A replaced socket's close must leave the current socket alone.
      if (wsRef.current !== ws) return;
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
      isConnectingRef.current = false;
      setStatus('disconnected');
      wsRef.current = null;

      // Reconnect after an abnormal close
      if (!isManualDisconnectRef.current && event.code !== 1000) {
        if (reconnectAttemptsRef.current >= DEFAULT_MAX_RECONNECT_ATTEMPTS) {
          setStatus('error');
          return;
        }

        const delay =
          DEFAULT_RECONNECT_INTERVAL *
          Math.pow(DEFAULT_BACKOFF_MULTIPLIER, reconnectAttemptsRef.current);

        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectAttemptsRef.current += 1;
          void connectRef.current();
        }, delay);
      }
    };
  }, [websocketUrl, cognitoProps, getCredentials]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  /** Subscribe to messages */
  const subscribe = useCallback(
    <T,>(action: string, callback: MessageCallback<T>): Unsubscribe => {
      if (!subscribersRef.current.has(action)) {
        subscribersRef.current.set(action, new Set());
      }
      const callbacks = subscribersRef.current.get(action);
      callbacks?.add(callback as MessageCallback);

      return () => {
        subscribersRef.current.get(action)?.delete(callback as MessageCallback);
      };
    },
    [],
  );

  /** Send a message */
  const sendMessage = useCallback(<T,>(message: WebSocketMessage<T>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket is not connected. Message not sent:', message);
    }
  }, []);

  /** Connect automatically */
  useEffect(() => {
    if (user?.id_token && websocketUrl) {
      connect();
    }

    return () => {
      disconnect();
    };
  }, [user?.id_token, websocketUrl, connect, disconnect]);

  /** Reconnect when the tab becomes visible */
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // Reset reconnect attempts when tab becomes visible
        reconnectAttemptsRef.current = 0;

        // Reconnect if disconnected or in error state
        if (
          status === 'disconnected' ||
          status === 'error' ||
          wsRef.current?.readyState !== WebSocket.OPEN
        ) {
          console.log('Tab visible, reconnecting WebSocket...');
          connect();
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [status, connect]);

  const value: WebSocketContextValue = {
    status,
    subscribe,
    sendMessage,
  };

  return (
    <WebSocketContext.Provider value={value}>
      {children}
    </WebSocketContext.Provider>
  );
}

/** Hook for the WebSocket state */
export function useWebSocket(): WebSocketContextValue {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
}

/** Hook to subscribe to messages of one action */
export function useWebSocketMessage<T>(
  action: string,
  callback: MessageCallback<T>,
): void {
  const { subscribe } = useWebSocket();

  useEffect(() => {
    return subscribe(action, callback);
  }, [action, callback, subscribe]);
}
