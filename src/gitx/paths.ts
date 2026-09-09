// Repository disk layout, byte-compatible with gogs:
//   {ROOT}/{owner lowercase}/{repo lowercase}.git
//   {ROOT}/{owner lowercase}/{repo lowercase}.wiki.git
import * as path from 'node:path';
import * as fs from 'node:fs';
import { conf } from '../conf.js';

/** pathx.Clean: prevent path traversal, collapse separators */
export function cleanPath(name: string): string {
  let n = name.replace(/\\/g, '/');
  n = path.posix.normalize(n);
  n = n.replace(/^(\.\.(\/|$))+/, '');
  if (n.startsWith('/')) n = n.slice(1);
  return n;
}

export function userPath(username: string): string {
  return path.join(conf.repositoryRoot, cleanPath(username.toLowerCase()));
}

export function repoPath(username: string, repoName: string): string {
  return path.join(userPath(username), cleanPath(repoName.toLowerCase()) + '.git');
}

export function wikiPath(username: string, repoName: string): string {
  return path.join(userPath(username), cleanPath(repoName.toLowerCase()) + '.wiki.git');
}

export function isRepositoryExist(username: string, repoName: string): boolean {
  return fs.existsSync(repoPath(username, repoName));
}
