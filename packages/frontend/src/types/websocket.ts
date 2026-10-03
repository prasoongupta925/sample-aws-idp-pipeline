/** WebSocket connection state */
export type WebSocketStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

/** Base WebSocket message type */
export interface WebSocketMessage<T = unknown> {
  action: string;
  data?: T;
  projectId?: string;
}

/** Message subscription callback type */
export type MessageCallback<T = unknown> = (data: T) => void;

/** Unsubscribe function type */
export type Unsubscribe = () => void;
