// Slack-compatible incoming webhooks: tools that can "post to a Slack webhook" (CI, monitoring,
// Grafana, Jenkins, scripts) post to a Space here with the same JSON. Their mrkdwn, attachments
// and Block Kit sections become this app's Markdown.

/** Slack's mrkdwn to our Markdown: *bold*, _italic_, ~strike~, <url|label>, <!here>. */
export function fromMrkdwn(s: string): string {
  return s
    .replace(/<(https?:\/\/[^|>\s]+)\|([^>]+)>/g, '[$2]($1)')
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
    .replace(/<mailto:([^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<!(here|channel|everyone)(\|[^>]*)?>/g, '@$1')
    .replace(/<[@#][A-Z0-9]+(\|([^>]+))?>/g, (_m, _g, name: string | undefined) => (name ? `@${name}` : ''))
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1**$2**')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, '$1*$2*')
    .replace(/(^|[\s(])~([^~\n]+)~(?=[\s).,!?:;]|$)/g, '$1~~$2~~')
    .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

type Text = { text?: unknown; type?: unknown } | string | undefined;
const t = (x: Text): string => (typeof x === 'string' ? x : x && typeof x.text === 'string' ? x.text : '');

/** The whole Slack payload as one message body (empty when there is nothing to show). */
export function slackToMarkdown(p: Record<string, unknown>): string {
  const out: string[] = [];
  if (typeof p.text === 'string' && p.text.trim()) out.push(fromMrkdwn(p.text.trim()));
  if (Array.isArray(p.blocks)) {
    for (const b of p.blocks.slice(0, 50) as Array<Record<string, unknown>>) {
      if (b.type === 'header') out.push(`### ${t(b.text as Text)}`);
      else if (b.type === 'divider') out.push('---');
      else if (b.type === 'section') {
        const main = t(b.text as Text);
        if (main) out.push(fromMrkdwn(main));
        if (Array.isArray(b.fields)) out.push((b.fields as Text[]).map((f) => `- ${fromMrkdwn(t(f))}`).join('\n'));
      } else if (b.type === 'context' && Array.isArray(b.elements)) {
        const s = (b.elements as Text[]).map(t).filter(Boolean).join(' · ');
        if (s) out.push(`*${fromMrkdwn(s)}*`);
      }
    }
  }
  if (Array.isArray(p.attachments)) {
    for (const a of p.attachments.slice(0, 10) as Array<Record<string, unknown>>) {
      const lines: string[] = [];
      if (typeof a.pretext === 'string') lines.push(fromMrkdwn(a.pretext));
      if (typeof a.title === 'string') lines.push(typeof a.title_link === 'string' && /^https?:\/\//.test(a.title_link) ? `**[${a.title}](${a.title_link})**` : `**${a.title}**`);
      if (typeof a.text === 'string') lines.push(fromMrkdwn(a.text));
      if (Array.isArray(a.fields)) for (const f of a.fields.slice(0, 20) as Array<{ title?: unknown; value?: unknown }>) lines.push(`- **${String(f.title ?? '')}:** ${fromMrkdwn(String(f.value ?? ''))}`);
      if (typeof a.footer === 'string') lines.push(`*${a.footer}*`);
      if (!lines.length && typeof a.fallback === 'string') lines.push(a.fallback);
      if (lines.length) out.push(lines.map((l) => `> ${l.replace(/\n/g, '\n> ')}`).join('\n'));
    }
  }
  return out.filter(Boolean).join('\n\n').slice(0, 8000);
}
