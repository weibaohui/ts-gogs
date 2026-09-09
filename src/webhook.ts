// Webhook delivery (hook_task persistence + async HTTP POST), mirroring gogs
// webhook.go deliverHooks with HMAC-SHA256 signature.
import * as http from 'node:http';
import * as https from 'node:https';
import * as crypto from 'node:crypto';
import * as db from './db/db.js';
import { nowUnix, newUUID } from './db/db.js';
import { conf } from './conf.js';

export function deliverWebhook(hook: any, eventType: string, payload: any, repo: db.Repository): void {
  const hookTaskType = hook.hook_task_type ?? 1;
  const isJSON = hook.content_type === 1;
  let payloadContent = '';
  if (hookTaskType === 1) {
    payloadContent = JSON.stringify(payload);
  } else if (hookTaskType === 2) {
    // slack
    const meta = JSON.parse(hook.meta ?? '{}');
    payloadContent = JSON.stringify({
      channel: meta.channel,
      username: meta.username ?? 'Gogs',
      icon_url: meta.icon_url ?? conf.externalURL + 'img/favicon.png',
      text: slackText(eventType, payload),
    });
  } else if (hookTaskType === 3) {
    const meta = JSON.parse(hook.meta ?? '{}');
    payloadContent = JSON.stringify({
      username: meta.username ?? 'Gogs',
      content: `\`\`\`${slackText(eventType, payload)}\`\`\``,
    });
  } else {
    payloadContent = JSON.stringify({ msgtype: 'text', text: { content: slackText(eventType, payload) } });
  }

  const body = isJSON ? payloadContent : new URLSearchParams({ payload: payloadContent }).toString();
  const signature = crypto
    .createHmac('sha256', hook.secret ?? '')
    .update(payloadContent)
    .digest('hex');

  const task = db
    .db()
    .prepare(
      `INSERT INTO hook_task (repo_id, hook_id, uuid, type, url, signature, payload_content, content_type, event_type, is_ssl, is_delivered, delivered, is_succeed)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,?,0)`
    )
    .run(
      repo.id,
      hook.id,
      newUUID(),
      hookTaskType,
      hook.url,
      signature,
      payloadContent,
      hook.content_type ?? 1,
      eventType,
      hook.is_ssl ?? 0,
      process.hrtime.bigint() // delivered UnixNano (placeholder until completion)
    );
  const taskID = Number(task.lastInsertRowid);
  db.updateWebhookLastStatus(hook.id, 2); // pending → failed until success

  const delivery = (async () => {
    const started = process.hrtime.bigint();
    try {
      const { status } = await postURL(
        String(hook.url),
        Buffer.from(body),
        isJSON ? 'application/json' : 'application/x-www-form-urlencoded',
        {
          'X-Gogs-Delivery': String(taskID),
          'X-Gogs-Event': eventType,
          'X-Gogs-Event-Type': eventType,
          'X-Gogs-Signature': signature,
          'X-GitHub-Delivery': String(taskID),
          'X-GitHub-Event': eventType,
        }
      );
      const delivered = process.hrtime.bigint();
      db.db()
        .prepare(
          `UPDATE hook_task SET is_delivered = 1, delivered = ?, is_succeed = ?, request_content = ?, response_content = ? WHERE id = ?`
        )
        .run(
          delivered,
          status >= 200 && status < 300 ? 1 : 0,
          JSON.stringify({ headers: {} }),
          JSON.stringify({ status, headers: {}, body: '' }),
          taskID
        );
      if (status >= 200 && status < 300) {
        db.updateWebhookLastStatus(hook.id, 1);
      }
    } catch (e: any) {
      db.db()
        .prepare(`UPDATE hook_task SET is_delivered = 1, delivered = ?, is_succeed = 0, response_content = ? WHERE id = ?`)
        .run(process.hrtime.bigint(), JSON.stringify({ err: String(e?.message ?? e) }), taskID);
    }
  })();
  pendingDeliveries.add(delivery);
  void delivery.finally(() => pendingDeliveries.delete(delivery));
}

/** In-flight deliveries — short-lived processes (git hooks) must await these before exit. */
export const pendingDeliveries = new Set<Promise<void>>();

function slackText(eventType: string, payload: any): string {
  const repo = payload?.repository?.full_name ?? '';
  const who = payload?.sender?.username ?? payload?.pusher?.username ?? '';
  switch (eventType) {
    case 'push': {
      const commits = payload?.commits ?? [];
      return `[${repo}] ${who} pushed ${commits.length} commit(s):\n` + commits.map((c: any) => `  - ${c.message}`).join('\n');
    }
    case 'issues':
      return `[${repo}] Issue #${payload?.number}: "${payload?.issue?.title}" ${payload?.action ?? 'opened'} by ${who}`;
    case 'pull_request':
      return `[${repo}] Pull request #${payload?.number}: "${payload?.issue?.title}" ${payload?.action ?? 'opened'} by ${who}`;
    case 'issue_comment':
      return `[${repo}] New comment on #${payload?.number} by ${who}`;
    case 'create':
      return `[${repo}] ${payload?.ref_type} "${payload?.ref}" created by ${who}`;
    case 'delete':
      return `[${repo}] ${payload?.ref_type} "${payload?.ref}" deleted by ${who}`;
    case 'fork':
      return `[${repo}] forked by ${who}`;
    case 'release':
      return `[${repo}] Release "${payload?.release?.tag_name}" ${payload?.action ?? 'published'} by ${who}`;
    default:
      return `[${repo}] ${eventType} by ${who}`;
  }
}

function postURL(url: string, body: Buffer, contentType: string, headers: Record<string, string>): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: { 'Content-Type': contentType, 'Content-Length': String(body.length), ...headers },
        timeout: conf.deliverTimeout * 1000,
        rejectUnauthorized: !conf.skipVerify,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.end(body);
  });
}
