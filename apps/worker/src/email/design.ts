export type Tone = 'neutral' | 'positive' | 'progress' | 'caution' | 'critical';
export type Category = 'Account' | 'Receipt' | 'Update' | 'Security';

export interface Row {
  label: string;
  value: string;
  tone?: Tone;
}

export type Block =
  | { t: 'hero'; style: 'solid' | 'soft' | 'plain'; eyebrow: string; amount: string; unit: string; sub?: string }
  | { t: 'banner'; eyebrow: string; title: string; body: string }
  | { t: 'title'; eyebrow: string; text: string }
  | { t: 'greeting'; name: string | null }
  | { t: 'p'; text: string }
  | { t: 'rows'; rows: Row[] }
  | { t: 'steps'; steps: Array<{ label: string; state: 'done' | 'now' | 'next' }> }
  | { t: 'list'; items: Array<{ title: string; body: string }> }
  | { t: 'cta'; label: string; href: string; tone?: 'brand' | 'ink' }
  | { t: 'link'; lead: string; href: string }
  | { t: 'notice'; title: string; body: string };

export interface EmailDoc {
  subject: string;
  preheader: string;
  category: Category;
  blocks: Block[];
}

export interface Brand {
  appOrigin: string;
  assetOrigin: string;
  supportEmail: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const C = {
  ink: '#0b0b0c',
  ink2: '#3a3a3c',
  muted: '#6e6e73',
  line: '#e5e5ea',
  fill: '#f7f8fa',
  brand: '#006ee6',
  brandInk: '#005bb5',
  soft: '#eaf4ff',
  night: '#083a70',
  positive: '#18804a',
  caution: '#9a6212',
  critical: '#c7353b',
};

const FONT = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const TONES: Record<Tone, string> = { neutral: C.ink, positive: C.positive, progress: C.brandInk, caution: C.caution, critical: C.critical };
const STEP_STATE = { done: 'Done', now: 'In progress', next: 'Next' } as const;

export function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function safeHref(href: string): string {
  const url = new URL(href);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('email links must be https');
  return esc(url.toString());
}

function spacer(px: number): string {
  return `<tr><td height="${px}" style="height:${px}px;font-size:0;line-height:0;">&nbsp;</td></tr>`;
}

function hero(b: Extract<Block, { t: 'hero' }>): string {
  const solid = b.style === 'solid';
  const soft = b.style === 'soft';
  const bg = solid ? C.brand : soft ? C.soft : '';
  const eyebrow = solid ? '#ffffff' : soft ? C.brandInk : C.brand;
  const amount = solid ? '#ffffff' : soft ? C.night : C.ink;
  const sub = solid ? '#ffffff' : soft ? C.night : C.ink2;
  const pad = bg ? 'padding:32px 32px 30px;border-radius:14px;' : 'padding:4px 0 0;';
  const cls = solid ? 'o-solid' : soft ? 'o-soft' : '';
  const textClass = soft ? 'o-soft-t' : solid ? '' : 'o-t1';
  return `<tr><td class="${cls} o-hero"${bg ? ` bgcolor="${bg}"` : ''} style="${bg ? `background-color:${bg};` : ''}${pad}">
<div class="${soft ? 'o-soft-e' : solid ? '' : 'o-brand'}" style="font:700 12px/16px ${FONT};letter-spacing:0.08em;text-transform:uppercase;color:${eyebrow};">${esc(b.eyebrow)}</div>
<div class="${textClass}" style="margin-top:14px;font-family:${FONT};color:${amount};"><span class="o-amount" style="font-size:54px;line-height:58px;font-weight:800;letter-spacing:-0.035em;font-variant-numeric:tabular-nums;">${esc(b.amount)}</span><span class="o-unit" style="font-size:20px;line-height:24px;font-weight:700;letter-spacing:-0.01em;">&nbsp;${esc(b.unit)}</span></div>
${b.sub ? `<div class="${soft ? 'o-soft-t' : solid ? '' : 'o-t2'}" style="margin-top:12px;font:500 15px/22px ${FONT};color:${sub};">${esc(b.sub)}</div>` : ''}
</td></tr>`;
}

function rows(list: Row[]): string {
  const cells = list
    .map((r, i) => {
      const border = `border-top:1px solid ${C.line};${i === list.length - 1 ? `border-bottom:1px solid ${C.line};` : ''}`;
      const toneClass = !r.tone || r.tone === 'neutral' ? 'o-t1' : `o-${r.tone}`;
      return `<tr><td class="o-t3 o-line" valign="top" style="${border}padding:14px 16px 14px 0;font:400 14px/20px ${FONT};color:${C.muted};white-space:nowrap;">${esc(r.label)}</td><td class="${toneClass} o-line" valign="top" align="right" style="${border}padding:14px 0;font:600 14px/20px ${FONT};color:${TONES[r.tone ?? 'neutral']};text-align:right;font-variant-numeric:tabular-nums;word-break:break-word;">${esc(r.value)}</td></tr>`;
    })
    .join('');
  return `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${cells}</table></td></tr>`;
}

function steps(list: Array<{ label: string; state: 'done' | 'now' | 'next' }>): string {
  const width = Math.floor(100 / list.length);
  const cells = list
    .map((s) => {
      const color = s.state === 'next' ? C.muted : s.state === 'done' ? C.brandInk : C.ink;
      const cls = s.state === 'next' ? 'o-t3' : s.state === 'done' ? 'o-brand' : 'o-t1';
      return `<td width="${width}%" valign="top" style="padding:16px 12px 16px 18px;"><div class="${cls}" style="font:${s.state === 'now' ? 700 : 600} 13px/18px ${FONT};color:${color};">${esc(s.label)}</div><div class="${cls}" style="font:400 12px/18px ${FONT};color:${color};">${STEP_STATE[s.state]}</div></td>`;
    })
    .join('');
  return `<tr><td class="o-fill" bgcolor="${C.fill}" style="background-color:${C.fill};border-radius:10px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${cells}</tr></table></td></tr>`;
}

function list(items: Array<{ title: string; body: string }>): string {
  const cells = items
    .map((item, i) => `<tr><td class="o-brand" valign="top" width="44" style="padding:${i ? 20 : 0}px 0 0;font:700 14px/22px ${FONT};color:${C.brand};font-variant-numeric:tabular-nums;">${String(i + 1).padStart(2, '0')}</td><td valign="top" style="padding:${i ? 20 : 0}px 0 0;"><div class="o-t1" style="font:700 16px/22px ${FONT};letter-spacing:-0.01em;color:${C.ink};">${esc(item.title)}</div><div class="o-t2" style="margin-top:2px;font:400 15px/22px ${FONT};color:${C.ink2};">${esc(item.body)}</div></td></tr>`)
    .join('');
  return `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${cells}</table></td></tr>`;
}

function cta(b: Extract<Block, { t: 'cta' }>): string {
  const bg = b.tone === 'ink' ? C.ink : C.brand;
  return `<tr><td><table role="presentation" class="o-cta" cellpadding="0" cellspacing="0" border="0"><tr><td class="${b.tone === 'ink' ? 'o-ink-btn' : ''}" align="center" bgcolor="${bg}" style="background-color:${bg};border-radius:10px;"><a class="${b.tone === 'ink' ? 'o-ink-a' : ''}" href="${safeHref(b.href)}" target="_blank" style="display:inline-block;padding:15px 30px;font:600 15px/20px ${FONT};color:#ffffff;text-decoration:none;border-radius:10px;">${esc(b.label)}</a></td></tr></table></td></tr>`;
}

function block(b: Block): string {
  switch (b.t) {
    case 'hero':
      return hero(b);
    case 'banner':
      return `<tr><td class="o-solid o-hero" bgcolor="${C.brand}" style="background-color:${C.brand};padding:40px 32px 38px;border-radius:14px;"><div style="font:700 12px/16px ${FONT};letter-spacing:0.08em;text-transform:uppercase;color:#ffffff;">${esc(b.eyebrow)}</div><h1 class="o-h1" style="margin:16px 0 0;font:800 38px/42px ${FONT};letter-spacing:-0.03em;color:#ffffff;">${esc(b.title)}</h1><div style="margin-top:14px;font:500 16px/24px ${FONT};color:#ffffff;">${esc(b.body)}</div></td></tr>`;
    case 'title':
      return `<tr><td><div class="o-brand" style="font:700 12px/16px ${FONT};letter-spacing:0.08em;text-transform:uppercase;color:${C.brand};">${esc(b.eyebrow)}</div><h1 class="o-t1 o-h1" style="margin:14px 0 0;font:800 34px/40px ${FONT};letter-spacing:-0.03em;color:${C.ink};">${esc(b.text)}</h1></td></tr>`;
    case 'greeting':
      return `<tr><td class="o-t1" style="font:600 16px/24px ${FONT};color:${C.ink};">${esc(b.name ? `Hello ${b.name},` : 'Hello,')}</td></tr>`;
    case 'p':
      return `<tr><td class="o-t2" style="font:400 16px/25px ${FONT};color:${C.ink2};">${esc(b.text)}</td></tr>`;
    case 'rows':
      return rows(b.rows);
    case 'steps':
      return steps(b.steps);
    case 'list':
      return list(b.items);
    case 'cta':
      return cta(b);
    case 'link':
      return `<tr><td class="o-t3" style="font:400 13px/20px ${FONT};color:${C.muted};">${esc(b.lead)}<br><a class="o-brand" href="${safeHref(b.href)}" target="_blank" style="color:${C.brandInk};word-break:break-all;">${esc(b.href)}</a></td></tr>`;
    case 'notice':
      return `<tr><td class="o-fill" bgcolor="${C.fill}" style="background-color:${C.fill};border-radius:10px;padding:18px 20px;"><div class="o-t1" style="font:700 14px/20px ${FONT};color:${C.ink};">${esc(b.title)}</div><div class="o-t2" style="margin-top:4px;font:400 14px/21px ${FONT};color:${C.ink2};">${esc(b.body)}</div></td></tr>`;
  }
}

function gap(prev: Block, next: Block): number {
  if (next.t === 'cta') return 28;
  if (next.t === 'rows' || next.t === 'steps' || next.t === 'list') return 26;
  if (next.t === 'notice') return 24;
  if (next.t === 'link') return 18;
  if (prev.t === 'hero' || prev.t === 'banner' || prev.t === 'title') return 22;
  if (prev.t === 'rows' || prev.t === 'steps' || prev.t === 'list') return 24;
  if (prev.t === 'greeting') return 10;
  return 14;
}

const STYLE = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
:root{color-scheme:light dark;supported-color-schemes:light dark;}
body{margin:0;padding:0;width:100%!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
table{border-spacing:0;mso-table-lspace:0pt;mso-table-rspace:0pt;}
img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;}
a{text-decoration:none;}
@media only screen and (max-width:620px){
.o-page{padding:28px 20px 36px!important;}
.o-hero{padding:26px 22px 24px!important;}
.o-amount{font-size:44px!important;line-height:48px!important;}
.o-h1{font-size:30px!important;line-height:35px!important;}
.o-cta{width:100%!important;}
.o-cta a{display:block!important;}
}
@media (prefers-color-scheme:dark){
.o-bg{background-color:#0f1115!important;}
.o-t1{color:#f5f5f7!important;}
.o-t2{color:#d1d1d6!important;}
.o-t3{color:#a1a1a6!important;}
.o-line{border-color:#2c2e33!important;}
.o-brand{color:#66b2ff!important;}
.o-fill{background-color:#1a1c21!important;}
.o-soft{background-color:#12263f!important;}
.o-soft-t{color:#e6f1ff!important;}
.o-soft-e{color:#66b2ff!important;}
.o-ink-btn{background-color:#f5f5f7!important;}
.o-ink-a{color:#0b0b0c!important;}
.o-positive{color:#4cd98a!important;}
.o-progress{color:#66b2ff!important;}
.o-caution{color:#f0b35a!important;}
.o-critical{color:#ff7a80!important;}
.o-logo-light{display:none!important;}
.o-logo-dark{display:block!important;max-height:none!important;}
}`;

const MSO_HEAD = `<!--[if mso]><style>table,td,div,h1,a,span{font-family:Arial,Helvetica,sans-serif!important;}</style><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->`;

const SAFETY = 'Obiba will never ask for your password, sign-in codes or Recovery Kit by email, phone or message.';

export function renderHtml(doc: EmailDoc, brand: Brand): string {
  const parts: string[] = [];
  doc.blocks.forEach((b, i) => {
    if (i > 0) parts.push(spacer(gap(doc.blocks[i - 1]!, b)));
    parts.push(block(b));
  });
  const logo = (file: string, cls: string, style: string) => `<img class="${cls}" src="${safeHref(`${brand.assetOrigin}/brand/${file}`)}" width="112" height="28" alt="Obiba" style="${style}">`;
  const mail = esc(brand.supportEmail);
  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(doc.subject)}</title>
${MSO_HEAD}
<style>${STYLE}</style>
</head>
<body class="o-bg" bgcolor="#ffffff" style="margin:0;padding:0;background-color:#ffffff;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff;opacity:0;">${esc(doc.preheader)}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
<table role="presentation" class="o-bg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="background-color:#ffffff;"><tr><td align="center" class="o-page" style="padding:44px 24px 48px;">
<!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;">
<tr><td style="padding:0 0 34px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="left" valign="middle"><a href="${safeHref(brand.appOrigin)}" target="_blank">${logo('obiba-logo.png', 'o-logo-light', 'display:block;height:28px;width:112px;')}<!--[if !mso]><!-->${logo('obiba-logo-light.png', 'o-logo-dark', 'display:none;max-height:0;height:28px;width:112px;')}<!--<![endif]--></a></td>
<td align="right" valign="middle" class="o-t3" style="font:600 13px/20px ${FONT};color:${C.muted};">${esc(doc.category)}</td>
</tr></table></td></tr>
${parts.join('\n')}
${spacer(36)}
<tr><td class="o-t2 o-line" style="border-top:1px solid ${C.line};padding-top:26px;font:400 14px/21px ${FONT};color:${C.ink2};"><strong class="o-t1" style="font-weight:600;color:${C.ink};">Need help?</strong> Write to <a class="o-brand" href="mailto:${mail}" style="color:${C.brandInk};">${mail}</a> and a member of our team will respond.</td></tr>
${spacer(18)}
<tr><td class="o-t3" style="font:400 12px/19px ${FONT};color:${C.muted};">${esc(SAFETY)}<br>This is a service message about your Obiba account.</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body>
</html>`;
}

export function renderText(doc: EmailDoc, brand: Brand): string {
  const lines = doc.blocks.map((b): string => {
    switch (b.t) {
      case 'hero':
        return [b.eyebrow.toUpperCase(), `${b.amount} ${b.unit}`, b.sub].filter(Boolean).join('\n');
      case 'banner':
        return `${b.title}\n\n${b.body}`;
      case 'title':
        return b.text;
      case 'greeting':
        return b.name ? `Hello ${b.name},` : 'Hello,';
      case 'p':
        return b.text;
      case 'rows':
        return b.rows.map((r) => `${r.label}: ${r.value}`).join('\n');
      case 'steps':
        return b.steps.map((s) => `${s.label}: ${STEP_STATE[s.state]}`).join('\n');
      case 'list':
        return b.items.map((item, i) => `${i + 1}. ${item.title}\n   ${item.body}`).join('\n');
      case 'cta':
        return `${b.label}:\n${b.href}`;
      case 'link':
        return '';
      case 'notice':
        return `${b.title}\n${b.body}`;
    }
  });
  return [...lines.filter(Boolean), `Need help? Write to ${brand.supportEmail}.`, `${SAFETY}\nThis is a service message about your Obiba account.`].join('\n\n');
}

export function render(doc: EmailDoc, brand: Brand): RenderedEmail {
  return { subject: doc.subject, html: renderHtml(doc, brand), text: renderText(doc, brand) };
}
