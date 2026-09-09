// Time-limited activation/reset codes, captcha, and email-activate helpers —
// mirroring gogs internal/tool TimeLimitCode semantics (sha1, minute resolution).
import * as crypto from 'node:crypto';
import { conf } from './conf.js';

export const TIME_LIMIT_CODE_LENGTH = 12 + 6 + 40;

function createTimeLimitCode(data: string, minutes: number, startStr?: string | null): string {
  const format = (d: Date) =>
    String(d.getFullYear()).padStart(4, '0') +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0') +
    String(d.getHours()).padStart(2, '0') +
    String(d.getMinutes()).padStart(2, '0');
  const start = startStr ? new Date(
    Number(startStr.slice(0, 4)), Number(startStr.slice(4, 6)) - 1, Number(startStr.slice(6, 8)),
    Number(startStr.slice(8, 10)), Number(startStr.slice(10, 12))
  ) : new Date();
  const startFormatted = startStr ?? format(start);
  const end = new Date(start.getTime() + minutes * 60000);
  const endStr = format(end);
  const sh = crypto.createHash('sha1');
  sh.update(data + conf.secretKey + startFormatted + endStr + String(minutes));
  const encoded = sh.digest('hex');
  return `${startFormatted}${String(minutes).padStart(6, '0')}${encoded}`;
}

export function verifyTimeLimitCode(data: string, minutes: number, code: string): boolean {
  if (code.length <= 18) return false;
  const start = code.slice(0, 12);
  const lives = code.slice(12, 18);
  const parsed = Number(lives);
  if (!Number.isNaN(parsed)) minutes = parsed;
  const retCode = createTimeLimitCode(data, minutes, start);
  if (retCode === code && minutes > 0) {
    const before = new Date(
      Number(start.slice(0, 4)), Number(start.slice(4, 6)) - 1, Number(start.slice(6, 8)),
      Number(start.slice(8, 10)), Number(start.slice(10, 12))
    );
    return before.getTime() + minutes * 60000 > Date.now();
  }
  return false;
}

/** User activation code: gogs verifyUserActiveCode data format. */
export function createActivateCode(user: { id: number; email: string; lower_name: string; passwd: string; rands: string }, minutes: number): string {
  const data = String(user.id) + user.email + user.lower_name + user.passwd + user.rands;
  return createTimeLimitCode(data, minutes, null);
}

export function verifyActivateCode(user: { id: number; email: string; lower_name: string; passwd: string; rands: string } | null, code: string): boolean {
  if (!user) return false;
  const data = String(user.id) + user.email + user.lower_name + user.passwd + user.rands;
  return verifyTimeLimitCode(data, conf.activateCodeLives, code);
}

/** Verify an activation/reset code for the user named inside it (gogs parseUserFromCode + verify). */
export function verifyUserFromCode(code: string, lookup: (username: string) => any): { user: any; valid: boolean } | null {
  if (code.length <= TIME_LIMIT_CODE_LENGTH) return null;
  const hexStr = code.slice(TIME_LIMIT_CODE_LENGTH);
  let username: string;
  try {
    username = Buffer.from(hexStr, 'hex').toString('utf8');
  } catch {
    return null;
  }
  const user = lookup(username);
  if (!user) return { user: null, valid: false };
  return { user, valid: verifyActivateCode(user, code.slice(0, TIME_LIMIT_CODE_LENGTH)) };
}

// ---------------------------------------------------------------- captcha

interface CaptchaEntry {
  code: string;
  expires: number;
}
const captchaCache = new Map<string, CaptchaEntry>();

function sweepCaptcha(): void {
  const now = Date.now();
  for (const [k, v] of captchaCache) {
    if (v.expires < now) captchaCache.delete(k);
  }
}

export function newCaptcha(): { id: string; svg: string } {
  sweepCaptcha();
  const id = crypto.randomBytes(16).toString('hex');
  const code = String(Math.floor(100000 + Math.random() * 900000));
  captchaCache.set(id, { code, expires: Date.now() + 10 * 60000 });

  // distorted-digit SVG
  const w = 240;
  const h = 80;
  const colors = ['#333', '#555', '#722', '#252', '#335'];
  let digits = '';
  for (let i = 0; i < code.length; i++) {
    const x = 28 + i * 34 + Math.random() * 8;
    const y = h / 2 + Math.random() * 10 - 5;
    const rot = Math.random() * 50 - 25;
    const color = colors[Math.floor(Math.random() * colors.length)];
    digits += `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="44" font-family="monospace" font-weight="bold" fill="${color}" transform="rotate(${rot.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})">${code[i]}</text>`;
  }
  let noise = '';
  for (let i = 0; i < 6; i++) {
    const x1 = Math.random() * w;
    const y1 = Math.random() * h;
    const x2 = Math.random() * w;
    const y2 = Math.random() * h;
    noise += `<line x1="${x1.toFixed(0)}" y1="${y1.toFixed(0)}" x2="${x2.toFixed(0)}" y2="${y2.toFixed(0)}" stroke="#999" stroke-width="1" opacity="0.6"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="#f8f8f8"/>${noise}${digits}</svg>`;
  return { id, svg };
}

export function validateCaptcha(id: string, text: string): boolean {
  const entry = captchaCache.get(id);
  if (!entry || entry.expires < Date.now()) return false;
  const ok = entry.code === String(text).trim();
  captchaCache.delete(id); // single-use
  return ok;
}
