import { createFileRoute } from '@tanstack/react-router';
import CallRecordingsPage from '../components/CallRecordings';

/** "Upload call recordings" (signed-in staff); ?project= preselects a Telecaller QA project. */
export const Route = createFileRoute('/call-recordings')({
  validateSearch: (search: Record<string, unknown>): { project?: string } =>
    typeof search.project === 'string' && search.project
      ? { project: search.project }
      : {},
  component: CallRecordingsRoute,
});

function CallRecordingsRoute() {
  const { project } = Route.useSearch();
  return <CallRecordingsPage initialProjectId={project} />;
}
