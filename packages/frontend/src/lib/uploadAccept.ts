/**
 * File extensions of the upload modal's File tab (documents and media). The
 * Data tab takes spreadsheets only (DATA_TAB_ACCEPT in DocumentUploadModal).
 */
const FILE_TAB_EXTENSIONS = [
  '.pdf',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.txt',
  '.md',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.tiff',
  '.mp4',
  '.mov',
  '.avi',
  '.mp3',
  '.wav',
  '.flac',
  '.dxf',
];

/**
 * Video files: the pipeline sends them to its video analysis, which needs a
 * model that reads video (the backend's VIDEO_EXTENSIONS). A build without one
 * (the Mumbai build: no model in ap-south-1 reads video) refuses them.
 */
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];

/** True for a file name with a video extension. */
export function isVideoFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * The File tab's accept list (`<input accept>`, also used to filter dropped
 * files): without the video extensions when the build has no video model.
 */
export function fileTabAccept(videoUploadsEnabled: boolean): string {
  return FILE_TAB_EXTENSIONS.filter(
    (ext) => videoUploadsEnabled || !VIDEO_EXTENSIONS.includes(ext),
  ).join(',');
}
