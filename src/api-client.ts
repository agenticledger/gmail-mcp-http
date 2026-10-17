/**
 * Gmail API Client
 * Auth: Uses an explicit access token or exchanges an explicit legacy refresh token.
 * Base URL: https://gmail.googleapis.com/gmail/v1
 */

const BASE_URL = 'https://gmail.googleapis.com/gmail/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export type GoogleCredential =
  | { type: 'access_token'; value: string }
  | { type: 'refresh_token'; value: string };

export class GmailClient {
  private cachedAccessToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor(
    private credential: GoogleCredential,
    private clientId = '',
    private clientSecret = '',
  ) {}

  private async getAccessToken(): Promise<string> {
    if (this.credential.type === 'access_token') {
      return this.credential.value;
    }
    // Use cached token if still valid (with 60s buffer)
    if (this.cachedAccessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.cachedAccessToken;
    }

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.credential.value,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Google token refresh failed (${response.status}): ${text}`);
    }

    const data = await response.json() as { access_token: string; expires_in: number };
    this.cachedAccessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
    return data.access_token;
  }

  private async request<T>(
    method: string,
    endpoint: string,
    params?: Record<string, string | number | boolean | undefined>,
    body?: any,
    responseLimit = 32 * 1024 * 1024,
  ): Promise<T> {
    const accessToken = await this.getAccessToken();
    const url = new URL(`${BASE_URL}${endpoint}`);

    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
          url.searchParams.append(key, String(value));
        }
      });
    }

    const options: RequestInit = {
      method,
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    };

    const response = await fetch(url.toString(), options);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gmail API Error ${response.status}: ${text}`);
    }

    if (response.status === 204) return {} as T;
    if (Number(response.headers.get('content-length')) > responseLimit) {
      await response.body?.cancel(); throw new Error('Gmail response too large');
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    if (reader) for (;;) {
      const {done, value} = await reader.read(); if (done) break;
      size += value.length;
      if (size > responseLimit) {await reader.cancel(); throw new Error('Gmail response too large');}
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  }

  // === Profile ===

  async getProfile() {
    return this.request<any>('GET', '/users/me/profile');
  }

  // === Messages ===

  async searchMessages(query: string, maxResults = 10, pageToken?: string, labelIds?: string[]) {
    const params: Record<string, string | number | boolean | undefined> = {
      q: query,
      maxResults,
      pageToken,
    };
    if (labelIds?.length) {
      params.labelIds = labelIds.join(',');
    }
    return this.request<any>('GET', '/users/me/messages', params);
  }

  async getMessage(messageId: string, format: string = 'full') {
    return this.request<any>('GET', `/users/me/messages/${encodeURIComponent(messageId)}`, { format });
  }

  async getAttachment(messageId: string, attachmentId: string) {
    return this.request<any>('GET', `/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`, undefined, undefined, 14 * 1024 * 1024);
  }

  async modifyMessage(messageId: string, addLabelIds?: string[], removeLabelIds?: string[]) {
    return this.request<any>('POST', `/users/me/messages/${encodeURIComponent(messageId)}/modify`, undefined, {
      addLabelIds: addLabelIds || [],
      removeLabelIds: removeLabelIds || [],
    });
  }

  async trashMessage(messageId: string) {
    return this.request<any>('POST', `/users/me/messages/${encodeURIComponent(messageId)}/trash`);
  }

  // === Threads ===

  async getThread(threadId: string, format: string = 'full') {
    return this.request<any>('GET', `/users/me/threads/${encodeURIComponent(threadId)}`, { format });
  }

  // === Send / Reply ===

  async sendMessage(raw: string) {
    return this.request<any>('POST', '/users/me/messages/send', undefined, { raw });
  }

  // === Drafts ===

  async listDrafts(maxResults = 10, pageToken?: string) {
    return this.request<any>('GET', '/users/me/drafts', { maxResults, pageToken });
  }

  async createDraft(raw: string) {
    return this.request<any>('POST', '/users/me/drafts', undefined, {
      message: { raw },
    });
  }

  // === Labels ===

  async listLabels() {
    return this.request<any>('GET', '/users/me/labels');
  }
}

// === Helpers ===

/**
 * Encode an email to RFC 2822 base64url format for Gmail API.
 */
export function encodeEmail(opts: {
  to: string;
  subject: string;
  body: string;
  from?: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
}): string {
  const lines: string[] = [];
  if (opts.from) lines.push(`From: ${opts.from}`);
  lines.push(`To: ${opts.to}`);
  if (opts.cc) lines.push(`Cc: ${opts.cc}`);
  if (opts.bcc) lines.push(`Bcc: ${opts.bcc}`);
  lines.push(`Subject: ${opts.subject}`);
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) lines.push(`References: ${opts.references}`);
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push('');
  lines.push(opts.body);

  const raw = lines.join('\r\n');
  return Buffer.from(raw).toString('base64url');
}
