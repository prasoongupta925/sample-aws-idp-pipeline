import React, {
  createContext,
  PropsWithChildren,
  useEffect,
  useState,
} from 'react';
import { loadVoiceBotUrl, voiceBotUrlFrom } from '../../lib/voicebot/config';

export interface CognitoProps {
  region: string;
  identityPoolId: string;
  userPoolId: string;
  userPoolWebClientId: string;
}

export interface IRuntimeConfig {
  cognitoProps?: CognitoProps;
  apis?: Record<string, unknown>;
  documentStorageBucketName?: string;
  agentRuntimeArn?: string;
  /** Built-in voice chat runtime; absent when the build has no voice chat. */
  bidiAgentRuntimeArn?: string;
  /** false when the build has no model that reads video (uploads refused). */
  videoUploadsEnabled?: boolean;
  /**
   * false when the build has no Bedrock Data Automation (it runs through a
   * cross-Region profile, so the Mumbai build is without): no BDA option.
   */
  bdaEnabled?: boolean;
  websocketUrl?: string;
  /**
   * The voice bot's WebSocket URL (wss://…/ws). From runtime-config.json or,
   * as deployed, voicebot-config.json. Absent: no voice panel.
   */
  voiceBotUrl?: string;
}

/**
 * Context for storing the runtimeConfig.
 */
export const RuntimeConfigContext = createContext<IRuntimeConfig | undefined>(
  undefined,
);

/**
 * Apply any overrides to point to local servers/resources here
 * for the serve-local target
 */
const applyOverrides = (runtimeConfig: IRuntimeConfig) => {
  if (import.meta.env.MODE === 'serve-local') {
    // Add local server urls here
  }
  return runtimeConfig;
};

/**
 * Sets up the runtimeConfig.
 *
 * This assumes a runtime-config.json file is present at '/'.
 */
const RuntimeConfigProvider: React.FC<PropsWithChildren> = ({ children }) => {
  const [runtimeConfig, setRuntimeConfig] = useState<
    IRuntimeConfig | undefined
  >();
  useEffect(() => {
    (async () => {
      const voiceBot = loadVoiceBotUrl();
      let config: IRuntimeConfig;
      try {
        config = await (await fetch('/runtime-config.json')).json();
      } catch {
        config = { apis: {} };
      }
      const voiceBotUrl =
        voiceBotUrlFrom(config.voiceBotUrl) || (await voiceBot);
      setRuntimeConfig(
        applyOverrides({ ...config, voiceBotUrl: voiceBotUrl || undefined }),
      );
    })();
  }, [setRuntimeConfig]);

  return runtimeConfig ? (
    <RuntimeConfigContext.Provider value={runtimeConfig}>
      {children}
    </RuntimeConfigContext.Provider>
  ) : (
    <div className="flex-1 flex flex-col items-center justify-center h-screen gap-6">
      <div className="flex items-center gap-2">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="w-3 h-3 rounded-full bg-slate-400"
            style={{
              animation: 'pulse-dot 1.4s ease-in-out infinite',
              animationDelay: `${i * 0.2}s`,
            }}
          />
        ))}
      </div>
      <style>{`
        @keyframes pulse-dot {
          0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1.2); }
        }
      `}</style>
    </div>
  );
};

export default RuntimeConfigProvider;
