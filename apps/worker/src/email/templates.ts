import type { EmailKind, EmailPayloads, WithdrawalFacts } from '@obiba/domain';
import type { Block, Brand, Category, EmailDoc, RenderedEmail, Row } from './design';
import { render } from './design';
import { formatDecimal, formatTime, formatUnits, maskAddress, reference } from './format';

export interface TemplateContext {
  brand: Brand;
  name: string | null;
  link?: string;
}

type Builders = { [K in EmailKind]: (data: EmailPayloads[K], ctx: TemplateContext) => EmailDoc };

function tokenOf(origin: string): string {
  return origin.split(' on ')[0] ?? origin;
}

function doc(subject: string, preheader: string, category: Category, blocks: Block[]): EmailDoc {
  return { subject, preheader, category, blocks };
}

function open(ctx: TemplateContext, path = '/home'): string {
  return `${ctx.brand.appOrigin}${path}`;
}

function defined(rows: Array<Row | null>): Row[] {
  return rows.filter((r): r is Row => r !== null);
}

function depositAmount(d: { amount: string | null; origin: string }): string {
  return d.amount ? `${formatDecimal(d.amount)} ${tokenOf(d.origin)}` : tokenOf(d.origin);
}

function depositHero(d: { amount: string | null; origin: string }): { amount: string; unit: string } {
  return d.amount ? { amount: formatDecimal(d.amount), unit: tokenOf(d.origin) } : { amount: tokenOf(d.origin), unit: '' };
}

function depositRows(d: EmailPayloads['DEPOSIT_PENDING'], status: Row): Row[] {
  return [status, { label: 'Payment method', value: d.origin }, { label: 'Reference', value: reference(d.depositId) }, { label: 'Date', value: formatTime(d.at) }];
}

function withdrawalRows(w: WithdrawalFacts, status: Row, received: boolean): Row[] {
  return defined([
    status,
    { label: 'Destination', value: w.destination },
    { label: 'Recipient', value: maskAddress(w.recipient) },
    received && w.received ? { label: 'Quoted to arrive', value: `${formatDecimal(w.received)} ${tokenOf(w.destination)}` } : null,
    { label: 'Reference', value: reference(w.withdrawalId) },
    { label: 'Date', value: formatTime(w.at) },
  ]);
}

function hero(w: WithdrawalFacts, style: 'soft' | 'plain', eyebrow: string, sub: string): Block {
  return { t: 'hero', style, eyebrow, amount: formatUnits(w.units, w.decimals), unit: w.currency, sub };
}

const VIEW = 'View in Obiba';

const FAILED_DEPOSIT: Record<EmailPayloads['DEPOSIT_FAILED']['reason'], { subject: string; title: string; body: string; status: string }> = {
  EXPIRED: { subject: 'Your Obiba deposit window has closed', title: 'This deposit window has closed.', body: 'We did not receive funds before the deposit window ended, so nothing was added to your account. If you still want to add money, start a new deposit and use the new details.', status: 'Expired' },
  REFUNDING: { subject: 'Your Obiba deposit is being refunded', title: 'Your deposit is being refunded.', body: 'The deposit could not be completed, so nothing was added to your Obiba account. We are returning the funds to the refund address you provided.', status: 'Refund in progress' },
  REFUNDED: { subject: 'Your Obiba deposit has been refunded', title: 'Your deposit has been refunded.', body: 'The deposit could not be completed, and the funds were returned to the refund address you provided. Nothing was added to your Obiba account.', status: 'Refunded' },
  FAILED: { subject: 'Your Obiba deposit could not be completed', title: 'Your deposit could not be completed.', body: 'Nothing was added to your Obiba account. If funds left your wallet, write to us with the reference below and we will trace them with you.', status: 'Failed' },
};

export const BUILDERS: Builders = {
  WELCOME: (_d, ctx) =>
    doc("Welcome to Obiba. Let's get started.", 'Your USDC account, built for Ghana and ready when you are.', 'Account', [
      { t: 'banner', eyebrow: ctx.name ? `Welcome, ${ctx.name}` : 'Welcome', title: 'Your money, in your own account.', body: 'Obiba lets you hold USDC, send it to anyone and manage it from one secure place.' },
      { t: 'p', text: 'Three things will have you up and running.' },
      {
        t: 'list',
        items: [
          { title: 'Finish your secure setup', body: 'Confirm your phone number so that only you can approve what happens on your account.' },
          { title: 'Add money', body: 'Receive USDC directly, or bring funds across from another network.' },
          { title: 'Send with confidence', body: 'Pay other Obiba customers by name and see every transaction as it settles.' },
        ],
      },
      { t: 'cta', label: 'Open your dashboard', href: open(ctx) },
    ]),

  VERIFY_EMAIL: (_d, ctx) =>
    doc('Confirm your email for Obiba', 'One tap to confirm this address and continue your setup.', 'Security', [
      { t: 'title', eyebrow: 'Confirm your email', text: 'One quick step before we continue.' },
      { t: 'greeting', name: ctx.name },
      { t: 'p', text: 'Confirm that this address belongs to you. We use it to keep you informed about your money and your security.' },
      { t: 'cta', label: 'Confirm my email', href: ctx.link! },
      { t: 'link', lead: 'If the button does not work, open this link in your browser:', href: ctx.link! },
      { t: 'notice', title: 'Did not create an Obiba account?', body: 'You can safely ignore this message. Nothing will happen without this confirmation.' },
    ]),

  PASSWORD_RESET: (d, ctx) =>
    doc('Reset your Obiba password', 'Use this secure link within 1 hour to choose a new password.', 'Security', [
      { t: 'title', eyebrow: 'Password reset', text: 'Choose a new password.' },
      { t: 'greeting', name: ctx.name },
      { t: 'p', text: 'We received a request to reset the password for your Obiba account. This secure link works once and expires in 1 hour.' },
      { t: 'cta', label: 'Reset my password', href: ctx.link!, tone: 'ink' },
      { t: 'link', lead: 'If the button does not work, open this link in your browser:', href: ctx.link! },
      {
        t: 'rows',
        rows: defined([
          { label: 'Requested', value: formatTime(d.at) },
          d.device ? { label: 'Device', value: d.device } : null,
          d.browser ? { label: 'Browser', value: d.browser } : null,
        ]),
      },
      { t: 'notice', title: 'Did not ask for this?', body: 'You can safely ignore this message. Your password stays the same, and nothing on your account has changed.' },
    ]),

  PASSWORD_CHANGED: (d, ctx) =>
    doc('Your Obiba password was changed', 'If you made this change, no action is needed.', 'Security', [
      { t: 'title', eyebrow: 'Security', text: 'Your password was changed.' },
      { t: 'greeting', name: ctx.name },
      { t: 'p', text: 'The password for your Obiba account has just been updated, and other sessions have been signed out.' },
      { t: 'rows', rows: [{ label: 'Date and time', value: formatTime(d.at) }] },
      { t: 'notice', title: 'If this was not you', body: 'Reset your password now, then write to us so that we can help you review your account.' },
      { t: 'cta', label: 'Secure my account', href: open(ctx, '/forgot-password'), tone: 'ink' },
    ]),

  NEW_DEVICE: (d, ctx) =>
    doc('A new device accessed your Obiba account', "We noticed a sign-in from a device we haven't seen before.", 'Security', [
      { t: 'title', eyebrow: 'Security alert', text: 'A new device accessed your Obiba account.' },
      { t: 'greeting', name: ctx.name },
      { t: 'p', text: "We noticed a sign-in from a device we haven't seen before. If this was you, no action is needed. If it wasn't, secure your account immediately." },
      {
        t: 'rows',
        rows: defined([
          d.device ? { label: 'Device', value: d.device } : null,
          d.browser ? { label: 'Browser', value: d.browser } : null,
          d.ip ? { label: 'IP address', value: d.ip } : null,
          { label: 'Date and time', value: formatTime(d.at) },
        ]),
      },
      { t: 'cta', label: 'Secure my account', href: open(ctx, '/settings'), tone: 'ink' },
      { t: 'notice', title: 'If this was not you', body: 'Sign out of every session in Settings and reset your password. Your money cannot move without approval from a device you have already set up.' },
    ]),

  DEPOSIT_INITIATED: (d, ctx) =>
    doc('Your Obiba deposit has started', `We are ready to receive your ${tokenOf(d.origin)}.`, 'Update', [
      { t: 'hero', style: 'plain', eyebrow: 'Deposit started', ...depositHero(d), sub: 'We are ready to receive your transfer.' },
      { t: 'steps', steps: [{ label: 'Started', state: 'now' }, { label: 'Received', state: 'next' }, { label: 'Credited', state: 'next' }] },
      { t: 'rows', rows: depositRows(d, { label: 'Status', value: 'Waiting for your transfer', tone: 'progress' }) },
      { t: 'p', text: 'Use only the deposit details shown in your Obiba app. We will write again as soon as your transfer arrives.' },
      { t: 'cta', label: VIEW, href: open(ctx, '/add') },
    ]),

  DEPOSIT_PENDING: (d, ctx) =>
    doc('We have detected your Obiba deposit', 'Your transfer is on its way and has not been credited yet.', 'Update', [
      { t: 'hero', style: 'plain', eyebrow: 'Deposit in progress', ...depositHero(d), sub: 'Your transfer has been detected. It has not been credited yet.' },
      { t: 'steps', steps: [{ label: 'Started', state: 'done' }, { label: 'Received', state: 'now' }, { label: 'Credited', state: 'next' }] },
      { t: 'rows', rows: depositRows(d, { label: 'Status', value: 'Pending', tone: 'progress' }) },
      { t: 'p', text: 'There is nothing you need to do. We will confirm as soon as the funds reach your Obiba account.' },
      { t: 'cta', label: VIEW, href: open(ctx, '/activity') },
    ]),

  DEPOSIT_CONFIRMED: (d, ctx) =>
    doc(`Deposit confirmed: ${formatUnits(d.units, d.decimals)} ${d.currency}`, 'The funds have been credited to your Obiba account.', 'Receipt', [
      { t: 'hero', style: 'solid', eyebrow: 'Deposit confirmed', amount: `+${formatUnits(d.units, d.decimals)}`, unit: d.currency, sub: 'Credited to your Obiba account' },
      { t: 'p', text: 'Your deposit is confirmed. The funds have been credited to your Obiba account and are ready to use.' },
      {
        t: 'rows',
        rows: defined([
          { label: 'Status', value: 'Credited', tone: 'positive' },
          { label: 'Currency', value: d.currency },
          { label: 'Payment method', value: d.method },
          d.from ? { label: 'From', value: maskAddress(d.from) } : null,
          { label: 'Reference', value: maskAddress(d.reference) },
          { label: 'Date', value: formatTime(d.at) },
        ]),
      },
      { t: 'cta', label: VIEW, href: open(ctx, '/activity') },
    ]),

  DEPOSIT_REVIEW: (d, ctx) =>
    doc('We are reviewing your Obiba deposit', 'Our team is confirming this deposit. It has not been credited yet.', 'Update', [
      { t: 'title', eyebrow: 'Deposit under review', text: 'We are reviewing your deposit.' },
      { t: 'p', text: `We could not automatically confirm your deposit of ${depositAmount(d)}, so our team is checking it. It has not been credited yet, and you do not need to send it again.` },
      { t: 'rows', rows: depositRows(d, { label: 'Status', value: 'Under review', tone: 'caution' }) },
      { t: 'cta', label: VIEW, href: open(ctx, '/activity') },
    ]),

  DEPOSIT_FAILED: (d, ctx) => {
    const copy = FAILED_DEPOSIT[d.reason];
    return doc(copy.subject, copy.body, 'Update', [
      { t: 'title', eyebrow: 'Deposit update', text: copy.title },
      { t: 'p', text: copy.body },
      { t: 'rows', rows: depositRows(d, { label: 'Status', value: copy.status, tone: d.reason === 'REFUNDED' ? 'neutral' : 'critical' }) },
      { t: 'cta', label: VIEW, href: open(ctx, '/activity') },
    ]);
  },

  WITHDRAWAL_REQUESTED: (w, ctx) =>
    doc('We have received your Obiba withdrawal', 'Your request is being prepared for sending.', 'Update', [
      hero(w, 'plain', 'Withdrawal requested', 'We have received your request and are preparing to send it.'),
      { t: 'steps', steps: [{ label: 'Requested', state: 'now' }, { label: 'On its way', state: 'next' }, { label: 'Completed', state: 'next' }] },
      { t: 'rows', rows: withdrawalRows(w, { label: 'Status', value: 'Requested', tone: 'progress' }, false) },
      { t: 'cta', label: VIEW, href: open(ctx, '/activity') },
    ]),

  WITHDRAWAL_PROCESSING: (w, ctx) =>
    doc('Your Obiba withdrawal is on its way', 'The funds have left your Obiba account and have not yet been confirmed at the destination.', 'Update', [
      hero(w, 'plain', 'Withdrawal in progress', 'The funds have left your Obiba account. Arrival has not been confirmed yet.'),
      { t: 'steps', steps: [{ label: 'Requested', state: 'done' }, { label: 'On its way', state: 'now' }, { label: 'Completed', state: 'next' }] },
      { t: 'rows', rows: withdrawalRows(w, { label: 'Status', value: 'Processing', tone: 'progress' }, true) },
      { t: 'p', text: 'We will write again once the transfer has been verified at the destination.' },
      { t: 'cta', label: VIEW, href: open(ctx, '/activity') },
    ]),

  WITHDRAWAL_COMPLETED: (w, ctx) =>
    doc(`Withdrawal completed: ${formatUnits(w.units, w.decimals)} ${w.currency}`, 'Your withdrawal has been completed and verified at the destination.', 'Receipt', [
      hero(w, 'soft', 'Withdrawal completed', `Verified at ${maskAddress(w.recipient)}`),
      { t: 'p', text: 'Your withdrawal has been completed. Your transaction details are available below.' },
      { t: 'rows', rows: withdrawalRows(w, { label: 'Status', value: 'Completed', tone: 'positive' }, false) },
      { t: 'cta', label: VIEW, href: open(ctx, '/activity') },
      { t: 'notice', title: 'Did not make this withdrawal?', body: 'Write to us straight away and include the reference above.' },
    ]),

  WITHDRAWAL_REVIEW: (w, ctx) =>
    doc('We are reviewing your Obiba withdrawal', 'Our team is confirming this withdrawal. You do not need to submit it again.', 'Update', [
      { t: 'title', eyebrow: 'Withdrawal under review', text: 'We are reviewing your withdrawal.' },
      { t: 'p', text: `We could not automatically confirm the outcome of your withdrawal of ${formatUnits(w.units, w.decimals)} ${w.currency}, so our team is checking it. Please do not submit it again.` },
      { t: 'rows', rows: withdrawalRows(w, { label: 'Status', value: 'Under review', tone: 'caution' }, false) },
      { t: 'cta', label: VIEW, href: open(ctx, '/activity') },
    ]),

  WITHDRAWAL_FAILED: (w, ctx) =>
    doc(w.refunded ? 'Your Obiba withdrawal was refunded' : 'Your Obiba withdrawal could not be completed', w.refunded ? 'The funds have been returned to your Obiba account.' : 'This withdrawal did not go through.', 'Update', [
      { t: 'title', eyebrow: 'Withdrawal update', text: w.refunded ? 'Your withdrawal was refunded.' : 'Your withdrawal could not be completed.' },
      { t: 'p', text: w.refunded ? `Your withdrawal of ${formatUnits(w.units, w.decimals)} ${w.currency} could not be delivered, so it was returned to your Obiba account.` : `Your withdrawal of ${formatUnits(w.units, w.decimals)} ${w.currency} did not go through. The amount was not sent to the destination, and any hold on your balance has been released.` },
      { t: 'rows', rows: withdrawalRows(w, { label: 'Status', value: w.refunded ? 'Refunded' : 'Failed', tone: w.refunded ? 'neutral' : 'critical' }, false) },
      { t: 'cta', label: VIEW, href: open(ctx, '/activity') },
    ]),
};

export function renderKind<K extends EmailKind>(kind: K, data: EmailPayloads[K], ctx: TemplateContext): RenderedEmail {
  return render(BUILDERS[kind](data, ctx), ctx.brand);
}

const URL_LINE = /^https?:\/\/\S+$/;

function ctaLabel(href: string): string {
  if (href.includes('/recover')) return 'Restore my account';
  if (href.includes('/sign-in')) return 'Sign in';
  return 'Open Obiba';
}

export function renderNotice(subject: string, body: string, brand: Brand, name: string | null): RenderedEmail {
  const heading = subject.replace(/^Obiba:\s*/, '');
  const blocks: Block[] = [{ t: 'title', eyebrow: 'Account security', text: `${heading.charAt(0).toUpperCase()}${heading.slice(1)}.` }, { t: 'greeting', name }];
  for (const line of body.split(/\n+/).map((l) => l.trim()).filter(Boolean)) {
    blocks.push(URL_LINE.test(line) ? { t: 'cta', label: ctaLabel(line), href: line, tone: 'ink' } : { t: 'p', text: line });
  }
  return render(doc(subject, heading, 'Security', blocks), brand);
}
