// Minimal SMTP client (implicit TLS on 465, STARTTLS on 587, plain otherwise)
// powering gogs [mailer] flows: test mail, account activation, password reset.
import * as net from 'node:net';
import * as tls from 'node:tls';
import { conf } from './conf.js';

export interface Mail {
  from: string;
  to: string;
  subject: string;
  body: string;
}

function readReply(socket: tls.TLSSocket | net.Socket, expect: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (d: Buffer) => {
      buf += d.toString('utf8');
      // last line fully received and matches expected code
      const lines = buf.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] ?? '';
      if (/^\d{3} /.test(last)) {
        socket.removeListener('data', onData);
        if (expect.test(last)) resolve(buf);
        else reject(new Error(`SMTP unexpected reply: ${last}`));
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
}

function sendLine(socket: tls.TLSSocket | net.Socket, line: string): void {
  socket.write(line + '\r\n');
}

export async function sendMail(mail: Mail): Promise<void> {
  // HOST may carry an explicit port (gogs semantics: `host:port`)
  let host = conf.emailHost.split(':')[0];
  let port = conf.emailPort;
  if (conf.emailHost.includes(':')) {
    const p = Number(conf.emailHost.split(':')[1]);
    if (Number.isFinite(p) && p > 0) port = p;
  }
  const from = conf.emailFrom || mail.from;
  const subject = conf.emailSubjectPrefix + mail.subject;

  await new Promise<void>((resolve, reject) => {
    let socket: tls.TLSSocket | net.Socket;
    if (port === 465) {
      socket = tls.connect({ host, port, rejectUnauthorized: !conf.emailSkipVerify }, () => run());
    } else {
      socket = net.connect({ host, port }, () => run());
    }
    socket.setTimeout(15000, () => {
      socket.destroy(new Error('SMTP timeout'));
    });
    socket.on('error', reject);

    let started = false;
    async function run() {
      try {
        if (!started) {
          started = true;
          await readReply(socket, /^220/);
          const ehloHost = conf.domain || 'localhost';
          sendLine(socket, `EHLO ${ehloHost}`);
          await readReply(socket, /^250/);
          if (conf.emailUseTLS && port !== 465) {
            sendLine(socket, 'STARTTLS');
            await readReply(socket, /^220/);
            const secure = tls.connect({ socket, host, port, rejectUnauthorized: !conf.emailSkipVerify }, async () => {
              socket.removeAllListeners('data');
              try {
                await smtpSession(socket as tls.TLSSocket);
                resolve();
              } catch (e) {
                reject(e);
              }
            });
            secure.on('error', reject);
            return;
          }
          await smtpSession(socket);
          resolve();
        }
      } catch (e) {
        reject(e);
      }
    }

    async function smtpSession(sock: tls.TLSSocket | net.Socket) {
      if (conf.emailUser) {
        sendLine(sock, 'AUTH LOGIN');
        await readReply(sock, /^334/);
        sendLine(sock, Buffer.from(conf.emailUser).toString('base64'));
        await readReply(sock, /^334/);
        sendLine(sock, Buffer.from(conf.emailPasswd).toString('base64'));
        await readReply(sock, /^235/);
      }
      sendLine(sock, `MAIL FROM:<${from.replace(/.*</, '').replace(/>.*/, '')}>`);
      await readReply(sock, /^250/);
      sendLine(sock, `RCPT TO:<${mail.to}>`);
      await readReply(sock, /^250/);
      sendLine(sock, 'DATA');
      await readReply(sock, /^354/);
      const headers = `From: ${from}\r\nTo: ${mail.to}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n`;
      sendLine(sock, headers + mail.body.replace(/\r?\n\./g, '\r\n..') + '\r\n.');
      await readReply(sock, /^250/);
      sendLine(sock, 'QUIT');
      sock.end();
    }
  });
}

/** Activation mail body — mirrors gogs mail/auth/activate.tmpl essentials. */
export function sendActivateMail(user: { name: string; email: string }, code: string): Promise<void> {
  const link = `${conf.externalURL}user/activate?code=${encodeURIComponent(code)}`;
  return sendMail({
    from: conf.emailFrom,
    to: user.email,
    subject: 'Please activate your account',
    body: `<p>Hi <b>${user.name}</b>, thanks for registering! Please click the following link to activate your account within <b>${conf.activateCodeLives} minutes</b>.</p><p><a href="${link}">${link}</a></p><p>Not working? Paste this code: <code>${code}</code></p>`,
  });
}

export function sendResetPasswordMail(user: { name: string; email: string }, code: string): Promise<void> {
  const link = `${conf.externalURL}user/reset_password?code=${encodeURIComponent(code)}`;
  return sendMail({
    from: conf.emailFrom,
    to: user.email,
    subject: 'Reset your password',
    body: `<p>Hi <b>${user.name}</b>, someone requested a password reset. Click within <b>${conf.resetPwdCodeLives} minutes</b> to continue.</p><p><a href="${link}">${link}</a></p>`,
  });
}
