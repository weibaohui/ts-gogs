// Admin login-source (authentication) management, mirroring internal/route/admin/auths.go.
// Auth types: 2=LDAP 3=SMTP 4=PAM (stored; LDAP/PAM use is rejected at login time in
// this build — Plain/local remains the only active backend).
import type { Context } from '../context.js';
import { conf } from '../conf.js';
import * as db from '../db/db.js';

const AUTH_TYPES = [
  { value: 2, name: 'LDAP (via BindDN)' },
  { value: 3, name: 'SMTP' },
  { value: 4, name: 'PAM' },
];
const SECURITY_PROTOCOLS = [
  { value: 0, name: 'Unencrypted' },
  { value: 1, name: 'TLS' },
  { value: 2, name: 'STARTTLS' },
];
const SMTP_AUTH_TYPES = ['PLAIN', 'LOGIN', 'CRAM-MD5'];

function listSources(): any[] {
  return (db.db().prepare('SELECT * FROM login_source ORDER BY id').all() as any[]).map((s) => db.goAlias({ ...s }));
}

export async function Authentications(c: Context): Promise<void> {
  c.Title('admin.authentication');
  c.Data['PageIsAdmin'] = true;
  c.Data['PageIsAdminAuthentications'] = true;
  c.Data['Sources'] = listSources();
  c.Data['Total'] = c.Data['Sources'].length;
  c.Success('admin/auth/list');
}

function typeInfo(type: number): { name: string; protocol: string } {
  const name = AUTH_TYPES.find((t) => t.value === type)?.name ?? 'None';
  return { name, protocol: type === 2 ? 'Unencrypted' : '' };
}

export async function NewAuthSource(c: Context): Promise<void> {
  c.Title('admin.auths.new');
  c.Data['PageIsAdmin'] = true;
  c.Data['PageIsAdminAuthentications'] = true;
  c.Data['type'] = 2;
  c.Data['CurrentTypeName'] = typeInfo(2).name;
  c.Data['CurrentSecurityProtocol'] = SECURITY_PROTOCOLS[0].name;
  c.Data['smtp_auth'] = 'PLAIN';
  c.Data['is_active'] = true;
  c.Data['is_default'] = true;
  c.Data['AuthSources'] = AUTH_TYPES;
  c.Data['SecurityProtocols'] = SECURITY_PROTOCOLS;
  c.Data['SMTPAuths'] = SMTP_AUTH_TYPES;
  c.Success('admin/auth/new');
}

export async function NewAuthSourcePost(c: Context): Promise<void> {
  const form = await c.form();
  const type = Number(form.type ?? 2);
  const name = String(form.name ?? '').trim();
  if (!name) {
    c.RenderWithErr(c.Tr('form.title_required'), 'admin/auth/new');
    return;
  }
  const cfg: Record<string, any> = { Provider: typeInfo(type).name.split(' ')[0] };
  if (type === 2) {
    Object.assign(cfg, {
      Host: String(form.host ?? ''), Port: Number(form.port ?? 389),
      UseSSL: String(form.security_protocol ?? '0') !== '0', BindDN: String(form.bind_dn ?? ''),
      BindPassword: String(form.bind_password ?? ''), UserBase: String(form.user_base ?? ''),
      Filter: String(form.filter ?? ''), AdminFilter: String(form.admin_filter ?? ''),
    });
  } else if (type === 3) {
    Object.assign(cfg, { Host: String(form.host ?? ''), Port: Number(form.port ?? 587), Auth: String(form.smtp_auth ?? 'PLAIN') });
  }
  const exists = db.db().prepare('SELECT 1 FROM login_source WHERE name = ?').get(name);
  if (exists) {
    c.RenderWithErr(c.Tr('admin.auths.login_source_exists'), 'admin/auth/new');
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  db.db()
    .prepare('INSERT INTO login_source (type, name, is_actived, is_default, cfg, created_unix, updated_unix) VALUES (?,?,?,?,?,?,?)')
    .run(type, name, String(form.is_active ?? '') === 'on' ? 1 : 0, String(form.is_default ?? '') === 'on' ? 1 : 0, JSON.stringify(cfg), now, now);
  c.flash.Success(c.Tr('admin.auths.new_success', name));
  c.Redirect(confSubpath() + '/admin/auths');
}

export async function EditAuthSource(c: Context): Promise<void> {
  const id = c.ParamsInt64(':authid');
  const row = db.db().prepare('SELECT * FROM login_source WHERE id = ?').get(id) as any;
  if (!row) {
    c.NotFound();
    return;
  }
  c.Title('admin.auths.edit');
  c.Data['PageIsAdmin'] = true;
  c.Data['PageIsAdminAuthentications'] = true;
  c.Data['Source'] = db.goAlias({ ...row, cfgObj: JSON.parse(row.cfg ?? '{}') });
  c.Data['CurrentTypeName'] = typeInfo(row.type).name;
  c.Data['CurrentSecurityProtocol'] = typeInfo(row.type).protocol;
  c.Data['AuthSources'] = AUTH_TYPES;
  c.Data['SecurityProtocols'] = SECURITY_PROTOCOLS;
  c.Data['SMTPAuths'] = SMTP_AUTH_TYPES;
  c.Success('admin/auth/edit');
}

export async function EditAuthSourcePost(c: Context): Promise<void> {
  const id = c.ParamsInt64(':authid');
  const row = db.db().prepare('SELECT * FROM login_source WHERE id = ?').get(id) as any;
  if (!row) {
    c.NotFound();
    return;
  }
  const form = await c.form();
  const type = Number(form.type ?? row.type);
  const cfg: Record<string, any> = JSON.parse(row.cfg ?? '{}');
  if (type === 2 || type === 3) {
    cfg.Host = String(form.host ?? '');
    cfg.Port = Number(form.port ?? 0);
  }
  db.db()
    .prepare('UPDATE login_source SET type = ?, name = ?, is_actived = ?, is_default = ?, cfg = ?, updated_unix = ? WHERE id = ?')
    .run(type, String(form.name ?? row.name), String(form.is_active ?? '') === 'on' ? 1 : 0, String(form.is_default ?? '') === 'on' ? 1 : 0, JSON.stringify(cfg), Math.floor(Date.now() / 1000), id);
  c.flash.Success(c.Tr('admin.auths.update_success'));
  c.Redirect(confSubpath() + `/admin/auths/${id}`);
}

export async function DeleteAuthSource(c: Context): Promise<void> {
  const id = c.ParamsInt64(':authid');
  const used = db.db().prepare('SELECT COUNT(*) AS c FROM user WHERE login_source = ?').get(id) as any;
  if (used.c > 0) {
    c.flash.Error(c.Tr('admin.auths.deletion_forbidden'));
    c.Redirect(confSubpath() + '/admin/auths');
    return;
  }
  db.db().prepare('DELETE FROM login_source WHERE id = ?').run(id);
  c.flash.Success(c.Tr('admin.auths.deletion_success'));
  c.Redirect(confSubpath() + '/admin/auths');
}

function confSubpath(): string {
  return conf.subpath;
}
