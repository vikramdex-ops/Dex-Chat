// Meeting invitations as an email draft: a .eml file the PC's mail program (Outlook, Windows
// Mail, Thunderbird) opens as an unsent message, ready to address and send, with the invitation
// as text, as formatted HTML and as the .ics attachment. And a mailto: link for where a file
// cannot be opened (phones), with the text only.
//
// The file follows RFC 5322 and MIME (RFC 2045–2047): CRLF line ends, headers that are not plain
// ASCII written as encoded words (Hindi and Tamil names), every body part in base64 so long lines
// and any script travel unchanged, and "X-Unsent: 1" so Outlook opens it as a draft.
import { invitationText } from './ics.ts';
import type { Invitation } from './ics.ts';

const CRLF = '\r\n';
const enc = new TextEncoder();

function b64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
/** base64 in lines of 76, as MIME wants. */
const b64Lines = (s: string | Uint8Array) => (b64(typeof s === 'string' ? enc.encode(s) : s).match(/.{1,76}/g) ?? ['']).join(CRLF);

/**
 * A header value: as it is when it is printable ASCII, else RFC 2047 encoded words (UTF-8,
 * base64) of at most 75 characters each, never splitting a character, folded onto new lines.
 */
export function encodeHeader(value: string): string {
  const v = value.replace(/[\r\n]+/g, ' ');
  if (/^[\x20-\x7e]*$/.test(v) && v.length <= 900) return v;
  const words: string[] = [];
  let cur = '';
  for (const ch of v) {
    // 45 bytes of UTF-8 make 60 characters of base64; with "=?UTF-8?B?" and "?=", 72
    if (enc.encode(cur + ch).length > 45) { words.push(cur); cur = ''; }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${b64(enc.encode(w))}?=`).join(`${CRLF} `);
}

/** "Priya Raman" <priya@example.com>, the name encoded when it needs to be. */
export function mailbox(name: string, email: string): string {
  const n = name.replace(/["\\\r\n]/g, '').trim();
  if (!n) return `<${email}>`;
  return /^[\x20-\x7e]*$/.test(n) ? `"${n}" <${email}>` : `${encodeHeader(n)} <${email}>`;
}

const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

export interface EmlAttachment { name: string; type: string; data: string | Uint8Array }
export interface EmlDraft {
  to: Array<{ name?: string; email: string }>;
  from?: { name?: string; email: string } | null;
  subject: string;
  text: string;
  html: string;
  attachments?: EmlAttachment[];
  /** For tests: the boundaries and date are otherwise random and now. */
  seed?: string;
  date?: Date;
}

/** The whole .eml: headers, multipart/mixed holding multipart/alternative (text, HTML) and the attachments. */
export function buildEml(d: EmlDraft): string {
  const seed = d.seed ?? Math.random().toString(36).slice(2, 12);
  const mixed = `=_dex_mixed_${seed}`;
  const alt = `=_dex_alt_${seed}`;
  const to = d.to.filter((r) => EMAIL_RE.test(r.email)).map((r) => mailbox(r.name ?? '', r.email));
  const head = [
    'MIME-Version: 1.0',
    `Date: ${(d.date ?? new Date()).toUTCString().replace('GMT', '+0000')}`,
    `Subject: ${encodeHeader(d.subject)}`,
    `To: ${to.join(`,${CRLF} `)}`,
    ...(d.from && EMAIL_RE.test(d.from.email) ? [`From: ${mailbox(d.from.name ?? '', d.from.email)}`] : []),
    'X-Unsent: 1',
    'X-Mailer: Dexterity Connect',
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
  ];
  const part = (headers: string[], body: string) => [...headers, '', body].join(CRLF);
  const body = [
    'This is a multi-part message in MIME format.',
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    part(['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64'], b64Lines(d.text.replace(/\r?\n/g, CRLF))),
    `--${alt}`,
    part(['Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64'], b64Lines(d.html)),
    `--${alt}--`,
    ...(d.attachments ?? []).flatMap((a) => {
      const name = a.name.replace(/["\\\r\n/]/g, '_');
      const quoted = /^[\x20-\x7e]*$/.test(name) ? `"${name}"` : `"${encodeHeader(name)}"`;
      return [`--${mixed}`, part([`Content-Type: ${a.type}; name=${quoted}`, `Content-Disposition: attachment; filename=${quoted}`, 'Content-Transfer-Encoding: base64'], b64Lines(a.data))];
    }),
    `--${mixed}--`,
    '',
  ];
  return [...head, '', ...body].join(CRLF);
}

/** A mailto: link with the subject and the text (no attachment), cut to stay within what mail programs accept. */
export function mailtoLink(to: string[], subject: string, text: string, max = 1900): string {
  const q = (s: string) => encodeURIComponent(s).replace(/%20/g, '%20');
  const head = `mailto:${to.filter((e) => EMAIL_RE.test(e)).map(encodeURIComponent).join(',')}?subject=${q(subject)}&body=`;
  let body = text.replace(/\r?\n/g, '\r\n');
  let url = head + q(body);
  if (url.length > max) {
    // cut whole lines from the end, never inside an escape, and say so
    const lines = body.split('\r\n');
    while (lines.length > 1 && (head + q(`${lines.join('\r\n')}\r\n…`)).length > max) lines.pop();
    body = `${lines.join('\r\n')}\r\n…`;
    url = head + q(body);
  }
  return url;
}

// ---------------------------------------------------------------- the invitation as an email
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtId = (id: string) => (/^\d{9}$/.test(id) ? `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}` : id);

/** "Tue 18 Nov, 3:00 PM IST": when, in the office's time, with its zone's short name. */
export function officeWhen(t: number, zone: string): string {
  const day = new Date(t).toLocaleDateString('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short' });
  const time = new Date(t).toLocaleTimeString('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' });
  const name = new Intl.DateTimeFormat('en-IN', { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date(t)).find((p) => p.type === 'timeZoneName')?.value ?? zone;
  return `${day.replace(',', '')}, ${time} ${name}`;
}

/**
 * The invitation as an email: a subject, the plain text (the same words as Copy invitation) and
 * an HTML version in the office's look made for mail programs (tables and inline styles, no
 * images, no fonts from anywhere). The passcode is in it only when the invitation carries the
 * guest link, as for Copy invitation.
 */
export function invitationEmail(inv: Invitation, o: { when: string; zone: string; office?: string }): { subject: string; text: string; html: string } {
  const subject = `Invitation: ${inv.title} · ${officeWhen(inv.startAt, o.zone)}`;
  const text = `${invitationText(inv, o.when)}\n\nThe attached invitation shows the time in your own time zone.\nTip: open the link a few minutes early to check your camera and microphone.`;
  const link = inv.guestUrl;
  const row = (k: string, v: string, mono = false) => `<tr><td style="padding:8px 12px;border-top:1px solid #d5e0e1;font:600 10px/1.3 Consolas,'Courier New',monospace;letter-spacing:2px;text-transform:uppercase;color:#55696c;width:120px;vertical-align:top">${esc(k)}</td><td style="padding:8px 12px;border-top:1px solid #d5e0e1;font:${mono ? "600 15px/1.4 Consolas,'Courier New',monospace;letter-spacing:2px" : "15px/1.4 'Segoe UI',Arial,sans-serif"};color:#132b2e">${v}</td></tr>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#eef3f3">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef3f3"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #9fb3b5">
<tr><td style="padding:18px 24px 6px;font:600 11px/1.4 Consolas,'Courier New',monospace;letter-spacing:3px;color:#1c7680;text-transform:uppercase">Dexterity Meet · Meeting ${esc(fmtId(inv.meetingId))}</td></tr>
<tr><td style="padding:4px 24px 4px;font:300 28px/1.2 'Segoe UI',Arial,sans-serif;color:#132b2e">${esc(inv.title)}</td></tr>
<tr><td style="padding:4px 24px 16px;font:15px/1.5 'Segoe UI',Arial,sans-serif;color:#3e5457">${esc(inv.organizer.name)} invites you to a meeting with ${esc(o.office ?? inv.office)}.</td></tr>
<tr><td style="padding:0 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #9fb3b5;border-top:2px solid #43585b">
${row('When', `${esc(o.when)}<br><span style="font-size:12px;color:#55696c">The attached invitation shows it in your own time zone.</span>`)}
${row('Host', esc(inv.organizer.name))}
${row('Meeting ID', esc(fmtId(inv.meetingId)), true)}
${link && inv.passcode ? row('Passcode', esc(inv.passcode), true) : ''}
</table></td></tr>
${link ? `<tr><td style="padding:22px 24px 6px"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#1c7680;border-radius:8px"><a href="${esc(link)}" style="display:inline-block;padding:13px 26px;font:600 16px/1 'Segoe UI',Arial,sans-serif;color:#ffffff;text-decoration:none">Join from your browser</a></td></tr></table></td></tr>
<tr><td style="padding:6px 24px 0;font:13px/1.5 'Segoe UI',Arial,sans-serif;color:#3e5457">Nothing to install. You wait in the lobby until the host lets you in.<br><span style="font:12px/1.6 Consolas,'Courier New',monospace;color:#1e6066;word-break:break-all">${esc(link)}</span></td></tr>
<tr><td style="padding:12px 24px 0;font:13px/1.5 'Segoe UI',Arial,sans-serif;color:#3e5457"><b style="color:#132b2e">Tip:</b> open the link a few minutes early to check your camera, microphone and speakers on the meeting page.</td></tr>` : ''}
<tr><td style="padding:16px 24px 20px;font:12px/1.5 'Segoe UI',Arial,sans-serif;color:#55696c">Colleagues with Dexterity Connect: <span style="font-family:Consolas,'Courier New',monospace">${esc(inv.appLink)}</span>${inv.description?.trim() ? `<br><br>${esc(inv.description.trim()).replace(/\n/g, '<br>')}` : ''}</td></tr>
<tr><td style="padding:10px 24px;border-top:1px solid #d5e0e1;font:600 9px/1.4 Consolas,'Courier New',monospace;letter-spacing:2px;color:#55696c;text-transform:uppercase">${esc(o.office ?? inv.office)}</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}
