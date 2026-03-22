import { z } from 'zod';
import { GmailClient, encodeEmail } from './api-client.js';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodType<any>;
  handler: (client: GmailClient, args: any) => Promise<any>;
}

// Helper to extract readable parts from a Gmail message
function extractMessageContent(msg: any): any {
  const headers = msg.payload?.headers || [];
  const getHeader = (name: string) => headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value;

  // Extract body text from parts
  let bodyText = '';
  function extractText(part: any): void {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      bodyText += Buffer.from(part.body.data, 'base64url').toString('utf-8');
    }
    if (part.parts) {
      part.parts.forEach(extractText);
    }
  }
  if (msg.payload) extractText(msg.payload);

  return {
    id: msg.id,
    threadId: msg.threadId,
    from: getHeader('From'),
    to: getHeader('To'),
    cc: getHeader('Cc'),
    subject: getHeader('Subject'),
    date: getHeader('Date'),
    snippet: msg.snippet,
    labelIds: msg.labelIds,
    body: bodyText || msg.snippet || '',
  };
}

export const tools: ToolDef[] = [
  // === Profile ===
  {
    name: 'gmail_get_profile',
    description: 'Get the authenticated Gmail user profile (email address, total messages, threads)',
    inputSchema: z.object({}),
    handler: async (client) => client.getProfile(),
  },

  // === Search ===
  {
    name: 'gmail_search',
    description: 'Search Gmail messages using Gmail search syntax (e.g., "from:john subject:meeting after:2024/01/01"). Returns message IDs and snippets.',
    inputSchema: z.object({
      query: z.string().describe('Gmail search query (same syntax as Gmail search bar)'),
      max_results: z.number().min(1).max(50).default(10).describe('Max messages to return (1-50)'),
      page_token: z.string().optional().describe('Pagination token for next page'),
    }),
    handler: async (client, args) => {
      const result = await client.searchMessages(args.query, args.max_results, args.page_token);
      // Fetch snippets for each message
      if (result.messages?.length) {
        const previews = await Promise.all(
          result.messages.slice(0, args.max_results).map(async (m: any) => {
            const msg = await client.getMessage(m.id, 'metadata');
            const headers = msg.payload?.headers || [];
            const getHeader = (name: string) => headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value;
            return {
              id: msg.id,
              threadId: msg.threadId,
              from: getHeader('From'),
              subject: getHeader('Subject'),
              date: getHeader('Date'),
              snippet: msg.snippet,
              labelIds: msg.labelIds,
            };
          })
        );
        return { messages: previews, nextPageToken: result.nextPageToken, resultSizeEstimate: result.resultSizeEstimate };
      }
      return result;
    },
  },

  // === Read Message ===
  {
    name: 'gmail_read_message',
    description: 'Read a specific Gmail message by ID. Returns full content including headers, body text, and labels.',
    inputSchema: z.object({
      message_id: z.string().describe('The Gmail message ID'),
    }),
    handler: async (client, args) => {
      const msg = await client.getMessage(args.message_id, 'full');
      return extractMessageContent(msg);
    },
  },

  // === Read Thread ===
  {
    name: 'gmail_read_thread',
    description: 'Read an entire email thread (conversation) by thread ID. Returns all messages in the thread.',
    inputSchema: z.object({
      thread_id: z.string().describe('The Gmail thread ID'),
    }),
    handler: async (client, args) => {
      const thread = await client.getThread(args.thread_id, 'full');
      return {
        id: thread.id,
        historyId: thread.historyId,
        messages: (thread.messages || []).map(extractMessageContent),
      };
    },
  },

  // === Send ===
  {
    name: 'gmail_send',
    description: 'Send a new email. Returns the sent message ID.',
    inputSchema: z.object({
      to: z.string().describe('Recipient email address(es), comma-separated'),
      subject: z.string().describe('Email subject line'),
      body: z.string().describe('Email body text (plain text)'),
      cc: z.string().optional().describe('CC recipients, comma-separated'),
      bcc: z.string().optional().describe('BCC recipients, comma-separated'),
    }),
    handler: async (client, args) => {
      const raw = encodeEmail({
        to: args.to,
        subject: args.subject,
        body: args.body,
        cc: args.cc,
        bcc: args.bcc,
      });
      return client.sendMessage(raw);
    },
  },

  // === Reply ===
  {
    name: 'gmail_reply',
    description: 'Reply to an existing email message. Maintains the thread.',
    inputSchema: z.object({
      message_id: z.string().describe('The message ID to reply to'),
      body: z.string().describe('Reply body text (plain text)'),
      reply_all: z.boolean().default(false).describe('Reply to all recipients (true) or just the sender (false)'),
    }),
    handler: async (client, args) => {
      // Get the original message to extract reply headers
      const original = await client.getMessage(args.message_id, 'metadata');
      const headers = original.payload?.headers || [];
      const getHeader = (name: string) => headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value;

      const from = getHeader('From') || '';
      const to = getHeader('To') || '';
      const subject = getHeader('Subject') || '';
      const messageIdHeader = getHeader('Message-ID') || getHeader('Message-Id') || '';

      const replyTo = args.reply_all ? [from, to].filter(Boolean).join(', ') : from;
      const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;

      const raw = encodeEmail({
        to: replyTo,
        subject: replySubject,
        body: args.body,
        inReplyTo: messageIdHeader,
        references: messageIdHeader,
      });

      return client.sendMessage(raw);
    },
  },

  // === Drafts ===
  {
    name: 'gmail_create_draft',
    description: 'Create a draft email (saved but not sent).',
    inputSchema: z.object({
      to: z.string().describe('Recipient email address(es)'),
      subject: z.string().describe('Email subject line'),
      body: z.string().describe('Email body text (plain text)'),
      cc: z.string().optional().describe('CC recipients'),
      bcc: z.string().optional().describe('BCC recipients'),
    }),
    handler: async (client, args) => {
      const raw = encodeEmail({
        to: args.to,
        subject: args.subject,
        body: args.body,
        cc: args.cc,
        bcc: args.bcc,
      });
      return client.createDraft(raw);
    },
  },

  {
    name: 'gmail_list_drafts',
    description: 'List email drafts in the mailbox.',
    inputSchema: z.object({
      max_results: z.number().min(1).max(50).default(10).describe('Max drafts to return'),
      page_token: z.string().optional().describe('Pagination token'),
    }),
    handler: async (client, args) => client.listDrafts(args.max_results, args.page_token),
  },

  // === Labels ===
  {
    name: 'gmail_list_labels',
    description: 'List all Gmail labels (folders/categories) for the account.',
    inputSchema: z.object({}),
    handler: async (client) => client.listLabels(),
  },

  {
    name: 'gmail_modify_labels',
    description: 'Add or remove labels from a message (e.g., mark as read, star, move to folder).',
    inputSchema: z.object({
      message_id: z.string().describe('The message ID to modify'),
      add_labels: z.array(z.string()).optional().describe('Label IDs to add (e.g., ["STARRED", "IMPORTANT"])'),
      remove_labels: z.array(z.string()).optional().describe('Label IDs to remove (e.g., ["UNREAD", "INBOX"])'),
    }),
    handler: async (client, args) => client.modifyMessage(args.message_id, args.add_labels, args.remove_labels),
  },

  // === Trash ===
  {
    name: 'gmail_trash',
    description: 'Move a message to the trash.',
    inputSchema: z.object({
      message_id: z.string().describe('The message ID to trash'),
    }),
    handler: async (client, args) => client.trashMessage(args.message_id),
  },
];
