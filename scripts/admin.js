const [command, messageId, ...reasonWords] = process.argv.slice(2);
if (command === 'prompt') {
  // npm run admin -- prompt "Question text" [--reply-to msg_ID]: a human-written, labelled operator question.
  const args = process.argv.slice(3), at = args.indexOf('--reply-to');
  const replyTo = at >= 0 ? args.splice(at, 2)[1] : undefined;
  const origin = process.env.ADMIN_ORIGIN || process.env.PUBLIC_URL;
  if (!origin || !process.env.ADMIN_TOKEN || !args.join(' ').trim()) throw new Error('Usage: npm run admin -- prompt "Question text" [--reply-to msg_ID]');
  const response = await fetch(`${origin}/admin/prompts`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.ADMIN_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: args.join(' '), ...(replyTo ? { reply_to: replyTo } : {}) }) });
  console.log(JSON.stringify(await response.json(), null, 2));
  process.exit(response.ok ? 0 : 1);
}
const origin = process.env.ADMIN_ORIGIN || process.env.PUBLIC_URL;
if (!origin || !process.env.ADMIN_TOKEN) throw new Error('Set PUBLIC_URL and ADMIN_TOKEN, or ADMIN_ORIGIN for a local port-forward.');
if (!['list', 'approve', 'visible', 'hidden_spam', 'hidden_abuse', 'deleted'].includes(command)) throw new Error('Usage: npm run admin -- list | approve|visible|hidden_spam|hidden_abuse|deleted MESSAGE_ID REASON');
const write = command !== 'list';
if (write && (!/^msg_[a-f0-9]{32}$/.test(messageId) || !reasonWords.length)) throw new Error('A valid message ID and moderation reason are required.');
const response = await fetch(`${origin}${write ? `/admin/messages/${messageId}/moderate` : '/admin/messages'}`, {
  method: write ? 'POST' : 'GET', headers: { Authorization: `Bearer ${process.env.ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
  ...(write ? { body: JSON.stringify({ action: command, reason: reasonWords.join(' ') }) } : {}),
});
console.log(JSON.stringify(await response.json(), null, 2));
if (!response.ok) process.exitCode = 1;
