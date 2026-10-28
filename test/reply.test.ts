import test from 'node:test';
import assert from 'node:assert/strict';
import { tools } from '../dist/tools.js';

const decode = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');
const header = (mime: string, name: string) => mime.split(/\r?\n/).find((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`))?.slice(name.length + 1).trim();

function fakeClient(me: string, headers: Record<string, string>, threadId = 't-1') {
  const sent: Array<{ raw: string; threadId?: string }> = [];
  return {
    sent,
    client: {
      getProfile: async () => ({ emailAddress: me }),
      getMessage: async () => ({ id: 'm1', threadId, payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) } }),
      sendMessage: async (raw: string, thread?: string) => { sent.push({ raw, threadId: thread }); return { id: 'sent-1', threadId: thread }; },
    } as any,
  };
}
const reply = (client: any, args: any) => tools.find((tool) => tool.name === 'gmail_reply')!.handler(client, { reply_all: false, ...args });

test('a follow-up on our own sent message goes to its recipient, in the same thread, never to ourselves', async () => {
  const { client, sent } = fakeClient('ore@finney.finance', {
    From: 'Ore Phillips <ore@finney.finance>', To: 'Pat Realtor <pat@homes.example>', Subject: 'Seller updates', 'Message-ID': '<a1@mail.gmail.com>',
  }, 'thread-9');
  await reply(client, { message_id: 'm1', body: 'Following up.' });
  const mime = decode(sent[0].raw);
  assert.equal(header(mime, 'To'), 'pat@homes.example');
  assert.equal(header(mime, 'Subject'), 'Re: Seller updates');
  assert.equal(header(mime, 'In-Reply-To'), '<a1@mail.gmail.com>');
  assert.equal(sent[0].threadId, 'thread-9');
  assert.ok(!mime.toLowerCase().includes('to: ore@finney.finance'));
});

test('reply_all on our own message never adds ourselves', async () => {
  const { client, sent } = fakeClient('ore@finney.finance', {
    From: 'ORE@finney.finance', To: 'a@x.example, ore@finney.finance', Cc: 'b@x.example', Subject: 'Re: Hi', 'Message-ID': '<a2@x>', References: '<a0@x>',
  });
  await reply(client, { message_id: 'm1', body: 'x', reply_all: true });
  const mime = decode(sent[0].raw);
  assert.equal(header(mime, 'To'), 'a@x.example, b@x.example');
  assert.equal(header(mime, 'Subject'), 'Re: Hi');
  assert.equal(header(mime, 'References'), '<a0@x> <a2@x>');
});

test('a reply to someone else goes to the sender (or Reply-To), unchanged behaviour', async () => {
  const one = fakeClient('ore@finney.finance', { From: 'Kim <kim@firm.example>', To: 'ore@finney.finance', Subject: 'Question', 'Message-ID': '<b1@x>' });
  await reply(one.client, { message_id: 'm1', body: 'x' });
  assert.equal(header(decode(one.sent[0].raw), 'To'), 'kim@firm.example');
  const two = fakeClient('ore@finney.finance', { From: 'kim@firm.example', 'Reply-To': 'desk@firm.example', To: 'ore@finney.finance', Subject: 'Q', 'Message-ID': '<b2@x>' });
  await reply(two.client, { message_id: 'm1', body: 'x' });
  assert.equal(header(decode(two.sent[0].raw), 'To'), 'desk@firm.example');
});

test('a message addressed only to ourselves is refused instead of mailing ourselves', async () => {
  const { client, sent } = fakeClient('ore@finney.finance', { From: 'ore@finney.finance', To: 'ore@finney.finance', Subject: 'note', 'Message-ID': '<c1@x>' });
  await assert.rejects(reply(client, { message_id: 'm1', body: 'x' }), /No recipient/);
  assert.equal(sent.length, 0);
});
