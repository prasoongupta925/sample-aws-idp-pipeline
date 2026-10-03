import { SignatureV4 } from '@aws-sdk/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-browser';
import { HttpRequest } from '@smithy/protocol-http';

interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface SignedUrlParams {
  websocketUrl: string;
  credentials: Credentials;
  region: string;
  service?: string;
}

/**
 * Build an AWS SigV4-signed WebSocket URL
 */
export async function createSignedWebSocketUrl({
  websocketUrl,
  credentials,
  region,
  service = 'execute-api',
}: SignedUrlParams): Promise<string> {
  const urlObject = new URL(websocketUrl);

  const httpRequest = new HttpRequest({
    headers: {
      host: urlObject.hostname,
    },
    hostname: urlObject.hostname,
    path: urlObject.pathname,
    protocol: urlObject.protocol,
    query: Object.fromEntries(urlObject.searchParams),
  });

  const signatureV4 = new SignatureV4({
    credentials,
    region,
    service,
    sha256: Sha256,
  });

  const signedHttpRequest = await signatureV4.presign(httpRequest);

  // Append the presigned query parameters to the URL
  const query = signedHttpRequest.query;
  if (query) {
    Object.keys(query).forEach((param) => {
      urlObject.searchParams.set(param, query[param] as string);
    });
  }

  const signedUrl = urlObject.toString();
  console.log('Signed WebSocket URL:', signedUrl);

  return signedUrl;
}
