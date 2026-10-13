import {
  type ResponseContext,
  createCORSHeaders,
  errorResponse,
} from '@audio-underview/worker-tools';
import { getCrawlerFileForUser } from '@audio-underview/supabase-connector';
import { type Environment, createSupabaseClientFrom } from '../environment.ts';
import { isUUID } from '../identifiers.ts';

/**
 * A file name for Content-Disposition (RFC 6266 and RFC 8187): percent-encoded UTF-8, with the
 * characters encodeURIComponent leaves that are not attr-char encoded as well.
 */
function encodeFileName(name: string): string {
  return encodeURIComponent(name).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * GET /files/:id: a file of the user while it has not expired. Every other case is the same 404.
 */
export async function handleDownloadFile(
  environment: Environment,
  context: ResponseContext,
  fileID: string,
  userUUID: string,
): Promise<Response> {
  if (!isUUID(fileID)) {
    return errorResponse('not_found', 'File not found', 404, context);
  }
  const file = await getCrawlerFileForUser(createSupabaseClientFrom(environment), fileID, userUUID);
  if (file === undefined) {
    return errorResponse('not_found', 'File not found', 404, context);
  }
  const object = await environment.CRAWLER_FILES.get(file.object_key);
  if (object === null) {
    return errorResponse('not_found', 'File not found', 404, context);
  }

  const headers = createCORSHeaders(context.origin, context.allowedOrigins, context.logger);
  headers.set('Content-Type', file.content_type);
  headers.set('Content-Length', String(object.size));
  headers.set('X-Content-Type-Options', 'nosniff');
  if (file.name !== null) {
    headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeFileName(file.name)}`);
    headers.set('Access-Control-Expose-Headers', 'Content-Disposition');
  }
  return new Response(object.body, { status: 200, headers });
}
