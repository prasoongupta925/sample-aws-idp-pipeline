/**
 * Customer upload links: the PDF unlock Lambda (WorkflowStack). The Backend
 * construct derives its ARN from this name (WorkflowStack deploys first), so
 * no SSM parameter is needed.
 */
export const PDF_UNLOCK_FUNCTION_NAME = 'idp-v2-pdf-unlock';

/** Header that carries a customer upload link's token (backend app/upload_links.TOKEN_HEADER). */
export const UPLOAD_TOKEN_HEADER = 'x-upload-token';

/**
 * S3 keys the upload rule (EventStack) ignores: anything one folder deeper
 * than a document's own file, such as a locked customer PDF at
 * projects/<p>/documents/<d>/locked/<d>.pdf. EventBridge `*` also matches `/`.
 */
export const UPLOAD_RULE_IGNORED_KEYS = 'projects/*/documents/*/*/*';
