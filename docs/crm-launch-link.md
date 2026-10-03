# CRM launch link

A signed link that opens Smart Dial Document AI straight on a CRM lead. The CRM
builds it on the server (the secret never goes to the browser) and opens it in a
new tab when the agent clicks "Documents" on the lead.

```
https://<app>/launch?lead=<id>&name=<name>&phone=<phone>&exp=<unix>&sig=<hex>
```

| Parameter | Required | Rule |
|-----------|----------|------|
| `lead`  | yes | CRM lead id, 1-64 of `A-Z a-z 0-9 . _ : -` |
| `name`  | no  | Applicant name, at most 120 characters (the name of a new project) |
| `phone` | no  | Digits, optional leading `+`, spaces `( ) -` allowed (6-20 characters) |
| `exp`   | yes | Unix time in seconds when the link expires: at most 5 minutes ahead |
| `sig`   | yes | Lowercase hex HMAC-SHA256 of the canonical query (below) |

No other parameter is accepted, and none may repeat.

## What the app does

1. The user signs in with Cognito if not signed in yet (the link is no SSO: it
   never signs anybody in). After the sign-in the app comes back to the link.
2. The backend checks the signature (constant time), that `exp` is in the
   future and at most 5 minutes (+30 s clock skew) ahead, and that the link was
   not used before: each link works **once**.
3. It opens the project whose CRM lead id is `lead`, or creates one (named
   `name`, with the lead id set, so every webhook of that project carries
   `crm_lead_id`).

A refused link shows the reason (expired, already used, bad signature…). Make a
new link on every click; do not cache links.

## The secret

One launch secret per CRM, stored encrypted with KMS. An admin generates or
rotates it in **Settings → Integrations**; it is shown once. Rotating it stops
every link signed with the old one at once, so put the new secret in the CRM
straight away. Keep it on the CRM server only (environment variable or secret
store), like the webhook secret.

## Canonical query and signature

1. Take every parameter except `sig`, with its plain (decoded) value.
2. Sort them by name (`exp`, `lead`, `name`, `phone`).
3. Percent-encode each name and value as RFC 3986: keep `A-Z a-z 0-9 - . _ ~`,
   encode everything else as UTF-8 `%XX` (upper-case hex; a space is `%20`, `+`
   is `%2B`).
4. Join as `name=value` with `&`.
5. `sig` = lowercase hex of HMAC-SHA256(key = the secret as UTF-8 bytes,
   message = that string).

Put the same encoded values in the URL and append `&sig=...`.

Example (made-up secret `test-secret`, `exp` 1790000000):

```
canonical: exp=1790000000&lead=SD-LEAD-0042&name=Asha%20Verma&phone=%2B91%2098765%2043210
```

## PHP (7.4+)

```php
<?php
/**
 * Smart Dial Document AI launch link for a lead.
 * $secret: the launch secret from Settings → Integrations (keep it server-side).
 */
function smartdial_launch_url(string $appUrl, string $secret, string $leadId,
                              ?string $name = null, ?string $phone = null,
                              int $ttlSeconds = 120): string
{
    $params = ['lead' => $leadId, 'exp' => (string) (time() + min($ttlSeconds, 300))];
    if ($name !== null && $name !== '') { $params['name'] = $name; }
    if ($phone !== null && $phone !== '') { $params['phone'] = $phone; }
    ksort($params, SORT_STRING);

    $pairs = [];
    foreach ($params as $key => $value) {
        // rawurlencode is RFC 3986: keeps A-Z a-z 0-9 - . _ ~, space -> %20
        $pairs[] = rawurlencode($key) . '=' . rawurlencode($value);
    }
    $canonical = implode('&', $pairs);
    $sig = hash_hmac('sha256', $canonical, $secret);   // lowercase hex

    return rtrim($appUrl, '/') . '/launch?' . $canonical . '&sig=' . $sig;
}

// Usage (secret from the environment, never hard-coded)
$url = smartdial_launch_url('https://d1wto5gdh1yonf.cloudfront.net',
                            getenv('SMARTDIAL_LAUNCH_SECRET'),
                            'SD-LEAD-0042', 'Asha Verma', '+91 98765 43210');
header('Location: ' . $url, true, 302);
```

## JavaScript (Node.js 18+)

```js
import { createHmac } from 'node:crypto';

// RFC 3986: encodeURIComponent leaves ! ' ( ) * as they are, so encode them too.
const rfc3986 = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Smart Dial Document AI launch link for a lead (server side only).
 */
export function smartdialLaunchUrl(appUrl, secret, leadId,
                                   { name, phone, ttlSeconds = 120 } = {}) {
  const params = {
    lead: leadId,
    exp: String(Math.floor(Date.now() / 1000) + Math.min(ttlSeconds, 300)),
  };
  if (name) params.name = name;
  if (phone) params.phone = phone;

  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(params[k])}`)
    .join('&');
  const sig = createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');

  return `${appUrl.replace(/\/+$/, '')}/launch?${canonical}&sig=${sig}`;
}

// Usage
const url = smartdialLaunchUrl(
  'https://d1wto5gdh1yonf.cloudfront.net',
  process.env.SMARTDIAL_LAUNCH_SECRET,
  'SD-LEAD-0042',
  { name: 'Asha Verma', phone: '+91 98765 43210' },
);
```

## Checklist for the CRM vendor

- Build the link on the server, right when the agent clicks; `exp` = now + 1-2
  minutes (5 at most). The CRM server clock must be in sync (NTP).
- Open it with `window.open(url, '_blank', 'noopener')` or a 302 redirect.
- A link opens once; a reload of the same URL is refused. Click again in the
  CRM for a new link.
- Do not log the full URL or the secret.
