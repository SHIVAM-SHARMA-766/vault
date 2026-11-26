// Email, through the customer's own SMTP server. Optional: with no SMTP_HOST,
// nothing is sent and every feature that would send says so in the UI.
//
// Vault stores no addresses, only keyed digests of them (identity.ts). So mail
// is sent only at the moment a request carries an address — a sign-in, an
// invitation typed by an admin — and the address is not kept afterwards.
// Every send is best effort: a mail server being down must never fail the
// sign-in or the invitation that triggered it.

import type { Config } from './config.js'
import type { App } from './context.js'
import { getSettings } from './system.js'

export interface Message {
  to: string
  subject: string
  text: string
  /** The operator's support mailbox, when one is set (admin → Overview → Name and support). */
  replyTo?: string
  /** Which editable template this message is (G6); the admin's subject and
   *  message are applied when it is sent. */
  template?: TemplateKind
}

/** Messages an admin may adjust (G6). The security text, links and codes are
 *  never editable: only the subject, and a message put before them. */
export type TemplateKind = 'invite' | 'signIn'
export const TEMPLATE_KINDS: readonly TemplateKind[] = ['invite', 'signIn']
export interface Template { subject: string; message: string }

/** Applies an admin's template to a built message. `{server}` becomes the
 *  server's name. Empty fields leave the default alone. */
export function applyTemplate(msg: Omit<Message, 'to'>, t: Template | undefined, serverName: string): Omit<Message, 'to'> {
  if (!t) return msg
  const fill = (s: string) => s.replaceAll('{server}', serverName)
  return {
    ...msg,
    ...(t.subject.trim() ? { subject: fill(t.subject.trim()) } : {}),
    ...(t.message.trim() ? { text: `${fill(t.message.trim())}\n\n${msg.text}` } : {}),
  }
}

export interface Mailer {
  send(message: Message): Promise<void>
}

export async function createMailer(config: Config): Promise<Mailer | undefined> {
  const m = config.mail
  if (!m.host) return undefined
  const { default: nodemailer } = await import('nodemailer')
  const transport = nodemailer.createTransport({
    host: m.host, port: m.port,
    // 465 is TLS from the first byte; anything else must upgrade with
    // STARTTLS — a plain-text connection carrying a sign-in notice or an
    // invitation code is refused rather than used.
    secure: m.port === 465, requireTLS: m.port !== 465,
    ...(m.user ? { auth: { user: m.user, pass: m.password } } : {}),
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
  })
  return {
    async send(msg) {
      await transport.sendMail({ from: m.from, to: msg.to, subject: msg.subject, text: msg.text, ...(msg.replyTo ? { replyTo: msg.replyTo } : {}) })
    },
  }
}

/** Sends without letting a failure reach the caller. When the operator has set
 *  a support address, replies go there and the message says how to get help. */
export async function notify(app: App, message: Message): Promise<boolean> {
  const mailer = app.mailer
  if (!mailer) return false
  try {
    const { profile, templates } = await getSettings(app)
    const help = profile.supportEmail || profile.supportUrl
      ? `\n\nNeed help? ${[profile.supportEmail, profile.supportUrl].filter(Boolean).join(' · ')}` : ''
    const { template, ...rest } = message
    const shaped = { to: message.to, ...applyTemplate(rest, template ? templates[template] : undefined, profile.name || 'Vault') }
    await mailer.send({
      ...shaped,
      text: shaped.text + help,
      ...(profile.supportEmail ? { replyTo: profile.supportEmail } : {}),
    })
    return true
  } catch (err) {
    console.error('mail not sent:', (err as Error).message)
    return false
  }
}

const footer = (origin: string) => `\n\n— Vault at ${origin}\nThis server stores no copy of your address; it was used only to send this message.`

export function signInNotice(origin: string, device: string, ip: string, at: string, recovery: boolean): Omit<Message, 'to'> {
  return recovery
    ? {
        subject: 'Your Vault recovery key was used',
        text: `Someone signed in to your Vault with your recovery key at ${at}, from ${device} (${ip}).\n\nIf it was you, set a new master password now if you have not already.\nIf it was not you, your recovery key is known to someone else: sign in, issue a new recovery key in Settings, and sign out every device.${footer(origin)}`,
      }
    : {
        template: 'signIn',
        subject: 'New sign-in to your Vault',
        text: `Your Vault account was signed in to at ${at}, from ${device} (${ip}).\n\nIf this was you, there is nothing to do.\nIf it was not, sign in, open Settings → Signed-in devices, sign that device out, and change your master password.${footer(origin)}`,
      }
}

/** An account-password reset link (decisions/0036). The link carries a
 *  single-use code in its fragment, which never reaches a server log. */
export function accountResetMessage(origin: string, email: string, code: string): Omit<Message, 'to'> {
  return {
    subject: 'Reset your Vault account password',
    text: `Someone asked to reset the account password for ${email}. If it was you, open this link within 30 minutes:\n\n${origin}/app/#account-reset=${encodeURIComponent(code)}&email=${encodeURIComponent(email)}\n\nThis changes only the account password, the first step of signing in. Your vault still opens only with your master password, which nobody can reset.\nIf it was not you, ignore this message: nothing has changed.${footer(origin)}`,
  }
}

export function inviteMessage(origin: string, code: string, label: string, expiresAt: string): Omit<Message, 'to'> {
  return {
    template: 'invite',
    subject: 'You are invited to a Vault password manager',
    text: `You have been invited to create an account on the Vault server at ${origin}${label ? ` (${label})` : ''}.\n\nOpen this link to create your account:\n${origin}/app/?invite=${encodeURIComponent(code)}\n\nOr choose "Create an account" there and enter the code: ${code}\nIt works once, until ${expiresAt}.\n\nVault encrypts everything on your device. Choose a long master password, and keep the recovery key it shows you somewhere safe: nobody, including the people running this server, can reset it.${footer(origin)}`,
  }
}
