// Prometheus metrics endpoint (/-/metrics), text format.
import * as db from './db/db.js';
import { conf } from './conf.js';

export function renderMetrics(): string {
  const g = (name: string, help: string, value: number): string =>
    `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}\n`;
  let out = '';
  out += g('gogs_user_total', 'Number of users', (db.db().prepare('SELECT COUNT(*) c FROM user WHERE type = 0').get() as any).c);
  out += g('gogs_org_total', 'Number of organizations', (db.db().prepare('SELECT COUNT(*) c FROM user WHERE type = 1').get() as any).c);
  out += g('gogs_repo_total', 'Number of repositories', (db.db().prepare('SELECT COUNT(*) c FROM repository').get() as any).c);
  out += g('gogs_issue_total', 'Number of issues', (db.db().prepare('SELECT COUNT(*) c FROM issue').get() as any).c);
  out += g('gogs_comment_total', 'Number of comments', (db.db().prepare('SELECT COUNT(*) c FROM comment').get() as any).c);
  out += g('gogs_action_total', 'Number of actions', (db.db().prepare('SELECT COUNT(*) c FROM action').get() as any).c);
  out += g('gogs_webhook_total', 'Number of webhooks', (db.db().prepare('SELECT COUNT(*) c FROM webhook').get() as any).c);
  out += g('gogs_process_uptime_seconds', 'Process uptime', Math.floor(process.uptime()));
  out += `# HELP gogs_info Application info\n# TYPE gogs_info gauge\ngogs_info{version="${conf.version}",goversion="node-${process.version}"} 1\n`;
  return out;
}
