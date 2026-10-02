import models from './models.json' with { type: 'json' };

/**
 * Whether this build analyses video. Only Amazon Nova reads video, and
 * ap-south-1 offers it only through cross-Region inference profiles, so the
 * Mumbai build has no video model: models.json videoAnalysis and
 * scriptExtractor are empty. Without them the app refuses video uploads (the
 * backend's upload check and the web app's accept list, with a message), and
 * the workflow Lambdas get no video model to invoke. Audio files still go
 * through Amazon Transcribe.
 */
export const VIDEO_ANALYSIS_ENABLED =
  models.videoAnalysis !== '' && models.scriptExtractor !== '';
