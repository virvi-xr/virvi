import nodemailer from 'nodemailer'
import { config } from '../config.js'

let transporter: nodemailer.Transporter | null = null

function getTransporter() {
  if (transporter) return transporter
  if (!config.smtpHost) return null
  transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
  })
  return transporter
}

export async function sendEmail(to: string, subject: string, html: string) {
  const t = getTransporter()
  if (!t) {
    console.log(`[virvi-email] SMTP not configured, skipping email to ${to}: ${subject}`)
    return false
  }
  await t.sendMail({ from: config.emailFrom, to, subject, html })
  return true
}

export async function sendPasswordResetEmail(to: string, token: string) {
  const resetUrl = `${config.publicUrl}/auth/reset-password?token=${token}`
  return sendEmail(to, 'Reset your Virvi password', `
    <h2>Reset your password</h2>
    <p>Click the link below to reset your password. This link expires in 1 hour.</p>
    <p><a href="${resetUrl}" style="background:#3b82f6;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block">Reset Password</a></p>
    <p style="color:#666;font-size:12px">If you didn't request this, you can ignore this email.</p>
  `)
}

export async function sendOrgInviteEmail(to: string, orgName: string, inviterName: string, token: string) {
  const inviteUrl = `${config.publicUrl}/auth/invite?token=${token}`
  return sendEmail(to, `You've been invited to ${orgName} on Virvi`, `
    <h2>You've been invited to ${orgName}</h2>
    <p>${inviterName} invited you to join their organization on Virvi.</p>
    <p><a href="${inviteUrl}" style="background:#3b82f6;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block">Accept Invite</a></p>
    <p style="color:#666;font-size:12px">If you don't have a Virvi account, you'll be able to create one.</p>
  `)
}

