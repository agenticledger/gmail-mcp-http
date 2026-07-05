/**
 * Gmail API Client
 * Auth: Takes a Google OAuth refresh token, exchanges for access token per request.
 * Base URL: https://gmail.googleapis.com/gmail/v1
 */

const BASE_URL = 'https://gmail.googleapis.com/gmail/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export class GmailClient {
  private refreshToken: string;
  private clientId: string;
  private clientSecret: string;
  private cachedAccessToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor(refreshToken: string, clientId: string, clientSecret: string) {
    this.refreshToken = refreshToken;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  private async getAccessToken(): Promise<string> {
    // Connections Broker passthrough: a broker-issued Google access token arrives
    // already exchanged. Google access tokens are prefixed ya29.; use directly
    // and skip the exchange. Refresh tokens (1//…) fall through unchanged.
    if (this.refreshToken.startsWith('ya29.')) {
      return this.refreshToken;
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
        refresh_token: this.refreshToken,
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
    return response.json();
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
