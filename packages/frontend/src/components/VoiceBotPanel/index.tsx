import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from 'react-oidc-context';
import { useNavigate } from '@tanstack/react-router';
import { useAwsClient } from '../../hooks/useAwsClient';
import type { Project } from '../ProjectSettingsModal';
import type { CallLanguage } from '../../lib/voicebot/protocol';
import VoiceBotView from './VoiceBotView';
import { useVoiceBotCall } from './useVoiceBotCall';

/** The voice server's recordings land in this project (backend/config.py QA_PROJECT_NAME_DEFAULT). */
export const QA_PROJECT_PREFIX = 'Telecaller QA';
const MAX_CALL_MINUTES = 10; // the voice server's default MAX_CALL_SECONDS (600)
/** Fetch a new ID token when the current one has less than this left. */
const TOKEN_MIN_SECONDS = 60;

/** The Telecaller QA project among the user's projects (exact default name first). */
export function findQaProject(
  projects: readonly Project[],
): Project | undefined {
  return (
    projects.find((p) => p.name === `${QA_PROJECT_PREFIX} – Sample calls`) ||
    projects.find((p) => p.name?.startsWith(QA_PROJECT_PREFIX))
  );
}

interface VoiceBotPanelProps {
  voiceBotUrl: string;
  onClose: () => void;
}

export default function VoiceBotPanel({
  voiceBotUrl,
  onClose,
}: VoiceBotPanelProps) {
  const auth = useAuth();
  const navigate = useNavigate();
  const { fetchApi } = useAwsClient();
  const [language, setLanguage] = useState<CallLanguage>('en-IN');
  const [qaProject, setQaProject] = useState<Project | undefined>();

  // The main app's current Cognito ID token (same user pool as the voice server).
  const getToken = useCallback(async () => {
    let user = auth.user;
    if (!user || user.expired || (user.expires_in ?? 0) < TOKEN_MIN_SECONDS) {
      try {
        user = (await auth.signinSilent()) ?? user;
      } catch {
        /* the voice server answers 4001 and the panel asks to sign in again */
      }
    }
    return user?.id_token;
  }, [auth]);

  const call = useVoiceBotCall(voiceBotUrl, getToken);

  useEffect(() => {
    let cancelled = false;
    fetchApi<Project[]>('projects')
      .then((projects) => {
        if (!cancelled && Array.isArray(projects))
          setQaProject(findQaProject(projects));
      })
      .catch(() => undefined); // no link then
    return () => {
      cancelled = true;
    };
  }, [fetchApi]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const qaHref = qaProject
    ? `/projects/${encodeURIComponent(qaProject.project_id)}`
    : '';

  // A portal: the chat column clips (overflow-hidden) and blurs its children.
  return createPortal(
    <VoiceBotView
      language={language}
      onLanguageChange={setLanguage}
      phase={call.phase}
      callLanguage={call.callLanguage}
      items={call.captions.items}
      speaking={call.speaking}
      audioSuspended={call.audioSuspended}
      end={call.end}
      qaHref={qaHref}
      maxCallMinutes={MAX_CALL_MINUTES}
      onCall={() => call.start(language)}
      onEnd={call.stop}
      onResumeAudio={call.resumeAudio}
      onOpenQa={() => {
        if (!qaProject) return;
        onClose();
        void navigate({
          to: '/projects/$projectId',
          params: { projectId: qaProject.project_id },
        });
      }}
      onClose={onClose}
    />,
    document.body,
  );
}
