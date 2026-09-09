-- ts-gogs SQLite schema, mirroring gogs xorm Sync2 + GORM AutoMigrate output.
-- Types: xorm INTEGER/TEXT as in the Go sqlite3 dialect; booleans are INTEGER 0/1.
-- Timestamps are Unix seconds (INTEGER) except hook_task.delivered (UnixNano).

CREATE TABLE IF NOT EXISTS user (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  lower_name TEXT,
  name TEXT,
  full_name TEXT,
  email TEXT,
  passwd TEXT,
  login_source INTEGER NOT NULL DEFAULT 0,
  login_name TEXT,
  type INTEGER,
  location TEXT,
  website TEXT,
  rands TEXT,
  salt TEXT,
  created_unix INTEGER,
  updated_unix INTEGER,
  last_repo_visibility INTEGER,
  max_repo_creation INTEGER NOT NULL DEFAULT -1,
  is_active INTEGER,
  is_admin INTEGER,
  allow_git_hook INTEGER,
  allow_import_local INTEGER,
  prohibit_login INTEGER,
  avatar TEXT,
  avatar_email TEXT,
  use_custom_avatar INTEGER,
  num_followers INTEGER,
  num_following INTEGER NOT NULL DEFAULT 0,
  num_stars INTEGER,
  num_repos INTEGER,
  description TEXT,
  num_teams INTEGER,
  num_members INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS UQE_user_lower_name ON user (lower_name);
CREATE UNIQUE INDEX IF NOT EXISTS UQE_user_name ON user (name);

CREATE TABLE IF NOT EXISTS public_key (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  owner_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  content TEXT NOT NULL,
  mode INTEGER NOT NULL DEFAULT 2,
  type INTEGER NOT NULL DEFAULT 1,
  created_unix INTEGER,
  updated_unix INTEGER
);
CREATE INDEX IF NOT EXISTS IDX_public_key_owner_id ON public_key (owner_id);

CREATE TABLE IF NOT EXISTS two_factor (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id INTEGER,
  secret TEXT,
  created_unix INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS UQE_two_factor_user_id ON two_factor (user_id);

CREATE TABLE IF NOT EXISTS two_factor_recovery_code (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id INTEGER,
  code TEXT,
  is_used INTEGER
);

CREATE TABLE IF NOT EXISTS repository (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  owner_id INTEGER,
  lower_name TEXT,
  name TEXT,
  description TEXT,
  website TEXT,
  default_branch TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  use_custom_avatar INTEGER,
  num_watches INTEGER,
  num_stars INTEGER,
  num_forks INTEGER,
  num_issues INTEGER,
  num_closed_issues INTEGER,
  num_pulls INTEGER,
  num_closed_pulls INTEGER,
  num_milestones INTEGER NOT NULL DEFAULT 0,
  num_closed_milestones INTEGER NOT NULL DEFAULT 0,
  is_private INTEGER,
  is_unlisted INTEGER NOT NULL DEFAULT 0,
  is_bare INTEGER,
  is_mirror INTEGER,
  enable_wiki INTEGER NOT NULL DEFAULT 1,
  allow_public_wiki INTEGER,
  enable_external_wiki INTEGER,
  external_wiki_url TEXT,
  enable_issues INTEGER NOT NULL DEFAULT 1,
  allow_public_issues INTEGER,
  enable_external_tracker INTEGER,
  external_tracker_url TEXT,
  external_tracker_format TEXT,
  external_tracker_style TEXT,
  enable_pulls INTEGER NOT NULL DEFAULT 1,
  pulls_ignore_whitespace INTEGER NOT NULL DEFAULT 0,
  pulls_allow_rebase INTEGER NOT NULL DEFAULT 0,
  is_fork INTEGER NOT NULL DEFAULT 0,
  fork_id INTEGER,
  created_unix INTEGER,
  updated_unix INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS UQE_repository_s ON repository (owner_id, lower_name);
CREATE INDEX IF NOT EXISTS IDX_repository_lower_name ON repository (lower_name);
CREATE INDEX IF NOT EXISTS IDX_repository_name ON repository (name);

CREATE TABLE IF NOT EXISTS deploy_key (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  key_id INTEGER,
  repo_id INTEGER,
  name TEXT,
  fingerprint TEXT,
  created_unix INTEGER,
  updated_unix INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS UQE_deploy_key_s ON deploy_key (key_id, repo_id);
CREATE INDEX IF NOT EXISTS IDX_deploy_key_key_id ON deploy_key (key_id);
CREATE INDEX IF NOT EXISTS IDX_deploy_key_repo_id ON deploy_key (repo_id);

CREATE TABLE IF NOT EXISTS collaboration (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id INTEGER NOT NULL,
  repo_id INTEGER NOT NULL,
  mode INTEGER NOT NULL DEFAULT 2
);
CREATE UNIQUE INDEX IF NOT EXISTS UQE_collaboration_s ON collaboration (user_id, repo_id);
CREATE INDEX IF NOT EXISTS IDX_collaboration_user_id ON collaboration (user_id);
CREATE INDEX IF NOT EXISTS IDX_collaboration_repo_id ON collaboration (repo_id);

CREATE TABLE IF NOT EXISTS upload (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  uuid TEXT,
  name TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS UQE_upload_uuid ON upload (uuid);

CREATE TABLE IF NOT EXISTS watch (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id INTEGER NOT NULL,
  repo_id INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS UQE_watch_watch ON watch (user_id, repo_id);

CREATE TABLE IF NOT EXISTS star (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  uid INTEGER NOT NULL,
  repo_id INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS UQE_star_s ON star (uid, repo_id);

CREATE TABLE IF NOT EXISTS issue (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  repo_id INTEGER,
  "index" INTEGER,
  poster_id INTEGER,
  name TEXT,
  content TEXT,
  milestone_id INTEGER,
  priority INTEGER,
  assignee_id INTEGER,
  is_closed INTEGER,
  is_pull INTEGER,
  num_comments INTEGER,
  deadline_unix INTEGER,
  created_unix INTEGER,
  updated_unix INTEGER
);
CREATE INDEX IF NOT EXISTS IDX_issue_repo_id ON issue (repo_id);
CREATE UNIQUE INDEX IF NOT EXISTS UQE_issue_repo_index ON issue (repo_id, "index");

CREATE TABLE IF NOT EXISTS pull_request (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  type INTEGER,
  status INTEGER,
  issue_id INTEGER,
  "index" INTEGER,
  head_repo_id INTEGER,
  base_repo_id INTEGER,
  head_user_name TEXT,
  head_branch TEXT,
  base_branch TEXT,
  merge_base TEXT,
  has_merged INTEGER,
  merged_commit_id TEXT,
  merger_id INTEGER,
  merged_unix INTEGER
);
CREATE INDEX IF NOT EXISTS IDX_pull_request_issue_id ON pull_request (issue_id);

CREATE TABLE IF NOT EXISTS comment (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  type INTEGER,
  poster_id INTEGER,
  issue_id INTEGER,
  commit_id INTEGER,
  line INTEGER,
  content TEXT,
  created_unix INTEGER,
  updated_unix INTEGER,
  commit_sha TEXT
);
CREATE INDEX IF NOT EXISTS IDX_comment_issue_id ON comment (issue_id);

CREATE TABLE IF NOT EXISTS attachment (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  uuid TEXT,
  issue_id INTEGER,
  comment_id INTEGER,
  release_id INTEGER,
  name TEXT,
  created_unix INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS UQE_attachment_uuid ON attachment (uuid);
CREATE INDEX IF NOT EXISTS IDX_attachment_issue_id ON attachment (issue_id);
CREATE INDEX IF NOT EXISTS IDX_attachment_release_id ON attachment (release_id);

CREATE TABLE IF NOT EXISTS issue_user (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  uid INTEGER,
  issue_id INTEGER,
  repo_id INTEGER,
  milestone_id INTEGER,
  is_read INTEGER,
  is_assigned INTEGER,
  is_mentioned INTEGER,
  is_poster INTEGER,
  is_closed INTEGER
);
CREATE INDEX IF NOT EXISTS IDX_issue_user_uid ON issue_user (uid);
CREATE INDEX IF NOT EXISTS IDX_issue_user_repo_id ON issue_user (repo_id);

CREATE TABLE IF NOT EXISTS label (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  repo_id INTEGER,
  name TEXT,
  color TEXT,
  num_issues INTEGER,
  num_closed_issues INTEGER
);
CREATE INDEX IF NOT EXISTS IDX_label_repo_id ON label (repo_id);

CREATE TABLE IF NOT EXISTS issue_label (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  issue_id INTEGER,
  label_id INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS UQE_issue_label_s ON issue_label (issue_id, label_id);

CREATE TABLE IF NOT EXISTS milestone (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  repo_id INTEGER,
  name TEXT,
  content TEXT,
  is_closed INTEGER,
  num_issues INTEGER,
  num_closed_issues INTEGER,
  completeness INTEGER,
  deadline_unix INTEGER,
  closed_date_unix INTEGER
);
CREATE INDEX IF NOT EXISTS IDX_milestone_repo_id ON milestone (repo_id);

CREATE TABLE IF NOT EXISTS mirror (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  repo_id INTEGER,
  interval INTEGER,
  enable_prune INTEGER NOT NULL DEFAULT 1,
  updated_unix INTEGER,
  next_update_unix INTEGER
);

CREATE TABLE IF NOT EXISTS release (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  repo_id INTEGER,
  publisher_id INTEGER,
  tag_name TEXT,
  lower_tag_name TEXT,
  target TEXT,
  title TEXT,
  sha1 TEXT,
  num_commits INTEGER,
  note TEXT,
  is_draft INTEGER NOT NULL DEFAULT 0,
  is_prerelease INTEGER,
  created_unix INTEGER
);

CREATE TABLE IF NOT EXISTS webhook (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  repo_id INTEGER,
  org_id INTEGER,
  url TEXT,
  content_type INTEGER,
  secret TEXT,
  events TEXT,
  is_ssl INTEGER,
  is_active INTEGER,
  hook_task_type INTEGER,
  meta TEXT,
  last_status INTEGER,
  created_unix INTEGER,
  updated_unix INTEGER
);

CREATE TABLE IF NOT EXISTS hook_task (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  repo_id INTEGER,
  hook_id INTEGER,
  uuid TEXT,
  type INTEGER,
  url TEXT,
  signature TEXT,
  payload_content TEXT,
  content_type INTEGER,
  event_type TEXT,
  is_ssl INTEGER,
  is_delivered INTEGER,
  delivered INTEGER,
  is_succeed INTEGER,
  request_content TEXT,
  response_content TEXT
);
CREATE INDEX IF NOT EXISTS IDX_hook_task_repo_id ON hook_task (repo_id);

CREATE TABLE IF NOT EXISTS protect_branch (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  repo_id INTEGER,
  name TEXT,
  protected INTEGER,
  require_pull_request INTEGER,
  enable_whitelist INTEGER,
  whitelist_user_ids TEXT,
  whitelist_team_ids TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS UQE_protect_branch_protect_branch ON protect_branch (repo_id, name);

CREATE TABLE IF NOT EXISTS protect_branch_whitelist (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  protect_branch_id INTEGER,
  repo_id INTEGER,
  name TEXT,
  user_id INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS UQE_protect_branch_whitelist_protect_branch_whitelist
  ON protect_branch_whitelist (repo_id, name, user_id);

CREATE TABLE IF NOT EXISTS team (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  org_id INTEGER,
  lower_name TEXT,
  name TEXT,
  description TEXT,
  authorize INTEGER,
  num_repos INTEGER,
  num_members INTEGER
);
CREATE INDEX IF NOT EXISTS IDX_team_org_id ON team (org_id);

CREATE TABLE IF NOT EXISTS org_user (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  uid INTEGER,
  org_id INTEGER,
  is_public INTEGER,
  is_owner INTEGER,
  num_teams INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS UQE_org_user_s ON org_user (uid, org_id);
CREATE INDEX IF NOT EXISTS IDX_org_user_uid ON org_user (uid);
CREATE INDEX IF NOT EXISTS IDX_org_user_org_id ON org_user (org_id);

CREATE TABLE IF NOT EXISTS team_user (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  org_id INTEGER,
  team_id INTEGER,
  uid INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS UQE_team_user_s ON team_user (team_id, uid);
CREATE INDEX IF NOT EXISTS IDX_team_user_org_id ON team_user (org_id);

CREATE TABLE IF NOT EXISTS team_repo (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  org_id INTEGER,
  team_id INTEGER,
  repo_id INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS UQE_team_repo_s ON team_repo (team_id, repo_id);
CREATE INDEX IF NOT EXISTS IDX_team_repo_org_id ON team_repo (org_id);

-- GORM AutoMigrate tables (NamingStrategy SingularTable)

CREATE TABLE IF NOT EXISTS access (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  repo_id INTEGER NOT NULL,
  mode INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_access_user_repo_unique ON access (user_id, repo_id);

CREATE TABLE IF NOT EXISTS access_token (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid INTEGER,
  name TEXT,
  sha1 TEXT UNIQUE,
  sha256 TEXT UNIQUE,
  created_unix INTEGER,
  updated_unix INTEGER
);
CREATE INDEX IF NOT EXISTS idx_access_token_user_id ON access_token (uid);

CREATE TABLE IF NOT EXISTS action (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  op_type INTEGER,
  act_user_id INTEGER,
  act_user_name TEXT,
  repo_id INTEGER,
  repo_user_name TEXT,
  repo_name TEXT,
  ref_name TEXT,
  is_private NUMERIC NOT NULL DEFAULT 0,
  content TEXT,
  created_unix INTEGER
);
CREATE INDEX IF NOT EXISTS idx_action_user_id ON action (user_id);
CREATE INDEX IF NOT EXISTS idx_action_repo_id ON action (repo_id);

CREATE TABLE IF NOT EXISTS email_address (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid INTEGER NOT NULL,
  email TEXT NOT NULL,
  is_activated NUMERIC NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_email_address_user_id ON email_address (uid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_address_user_email_unique ON email_address (uid, email);

CREATE TABLE IF NOT EXISTS follow (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  follow_id INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_follow_user_follow_unique ON follow (user_id, follow_id);

CREATE TABLE IF NOT EXISTS lfs_object (
  repo_id INTEGER NOT NULL,
  oid TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage TEXT NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (repo_id, oid)
);

CREATE TABLE IF NOT EXISTS login_source (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type INTEGER,
  name TEXT UNIQUE,
  is_actived NUMERIC NOT NULL,
  is_default NUMERIC,
  cfg TEXT,
  created_unix INTEGER,
  updated_unix INTEGER
);

CREATE TABLE IF NOT EXISTS notice (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type INTEGER,
  description TEXT,
  created_unix INTEGER
);

CREATE TABLE IF NOT EXISTS version (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER
);
