// Instagram tokens expire after 60 days. Once a month this exchanges the token
// for a fresh one and stores it back in the repo secret, so posting never stops.
// Storing a secret needs GH_SECRETS_TOKEN: a fine-grained GitHub token with
// "Secrets: read and write" on this repository only. Without it, this warns.

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const STATE = 'state.json';
const TOKEN = process.env.IG_ACCESS_TOKEN || '';
const GH_SECRETS_TOKEN = process.env.GH_SECRETS_TOKEN || '';
const REPO = process.env.GITHUB_REPOSITORY || '';
const REFRESH_AFTER_DAYS = 30;

const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const write = () => fs.writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);

if (!TOKEN) process.exit(0);
// Only Instagram Login tokens ("IG...") renew through this endpoint. Unified Login
// tokens are system-user tokens whose lifetime is set in the Meta app configuration
// (choose "Never" there); if one expires, publishing fails and GitHub emails you.
if (!TOKEN.startsWith('IG')) process.exit(0);
const last = Date.parse(state.token_refreshed_at || state.token_first_seen_at || '');
if (!Number.isFinite(last)) {
  // First run with a token: start the 30-day clock from today.
  state.token_first_seen_at = new Date().toISOString();
  write();
  process.exit(0);
}
const ageDays = (Date.now() - last) / 86_400_000;
if (ageDays < REFRESH_AFTER_DAYS) process.exit(0);

if (!GH_SECRETS_TOKEN) {
  console.log(`::warning::The Instagram token is ${Math.round(ageDays)} days old and expires at 60. Add the GH_SECRETS_TOKEN secret so it renews itself, or generate a new token.`);
  state.token_warning_at = new Date().toISOString(); // a monthly commit also keeps the schedule active
  write();
  process.exit(0);
}

const res = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(TOKEN)}`);
const json = await res.json().catch(() => ({}));
if (!res.ok || !json.access_token) {
  console.error(`Could not refresh the Instagram token: ${json.error?.message || `HTTP ${res.status}`}`);
  process.exit(1);
}
console.log(`::add-mask::${json.access_token}`);
// The same token is used by the comment inbox, so it is stored in every repo listed.
const repos = (process.env.TOKEN_REPOS || REPO).split(',').map(r => r.trim()).filter(Boolean);
for (const repo of repos) {
  const set = spawnSync('gh', ['secret', 'set', 'IG_ACCESS_TOKEN', '--repo', repo], {
    input: json.access_token,
    env: { ...process.env, GH_TOKEN: GH_SECRETS_TOKEN },
    encoding: 'utf8',
  });
  if (set.status !== 0) {
    console.error(`Got a new token but could not save it in ${repo}: ${set.stderr}`);
    process.exit(1);
  }
}
state.token_refreshed_at = new Date().toISOString();
write();
console.log('Instagram token renewed for another 60 days.');
