export function emailSender(env, appUrl) {
  if (!env.TODOS_SMTP_HOST || !env.TODOS_MAIL_FROM) return null;
  const local = ['localhost', '127.0.0.1', '::1'].includes(env.TODOS_SMTP_HOST);
  let transport;
  return async (email, token, device = '') => {
    transport ||= (await import('nodemailer')).default.createTransport({
      host: env.TODOS_SMTP_HOST, port: Number(env.TODOS_SMTP_PORT || 587),
      secure: env.TODOS_SMTP_PORT === '465', requireTLS: !local,
      auth: env.TODOS_SMTP_USER ? { user: env.TODOS_SMTP_USER, pass: env.TODOS_SMTP_PASS } : undefined,
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    });
    return transport.sendMail({
      from: env.TODOS_MAIL_FROM, to: email, subject: 'Your Todos sign-in link',
      text: `Continue to Todos:\n\n${appUrl}/#signin/${token}\n\n${device ? `Requested from ${device}. ` : ''}Open the link anywhere and type the four-digit code that device is showing; that signs it in. Or continue in the browser that opens the link.\n\nThis link works once and expires in 15 minutes. If you did not ask for it, you can ignore this email.`,
    });
  };
}
