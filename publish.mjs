// Publishes the next due post in schedule.json to Instagram through the
// official Instagram API (Unified Login or Instagram Login). One post per run, at least
// `min_gap_hours` apart, so a late start never dumps several posts at once.
//
// Env: IG_ACCESS_TOKEN (repo secret), IG_USER_ID (optional, looked up from the token
// when missing), MEDIA_BASE (public URL of media/).
// DRY_RUN=1 skips the network; NOW=<iso> pretends it is another time (both for testing).

import fs from 'node:fs';

const SCHEDULE = 'schedule.json';
const STATE = 'state.json';
const TOKEN = process.env.IG_ACCESS_TOKEN || '';
// Instagram Login tokens start with "IG" and use graph.instagram.com. Unified Login
// tokens (from Facebook Login for Business, "EAA...") use graph.facebook.com.
const INSTAGRAM_LOGIN = TOKEN.startsWith('IG');
const API = process.env.IG_API_BASE || (INSTAGRAM_LOGIN ? 'https://graph.instagram.com/v23.0' : 'https://graph.facebook.com/v27.0');
let USER = process.env.IG_USER_ID || '';
const MEDIA_BASE = (process.env.MEDIA_BASE || '').replace(/\/+$/, '');
const DRY = process.env.DRY_RUN === '1';
const NOW = process.env.NOW ? new Date(process.env.NOW) : new Date();
const MAX_ATTEMPTS = 3;

const read = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback);
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let fakeId = 0;
async function api(method, path, params) {
  if (DRY) {
    console.log(`  [dry run] ${method} ${path} ${Object.keys(params).join(', ')}`);
    return { id: `dry${++fakeId}`, status_code: 'FINISHED', permalink: 'https://www.instagram.com/p/dry-run/' };
  }
  const query = new URLSearchParams({ ...params, access_token: TOKEN });
  const res = method === 'GET' ? await fetch(`${API}${path}?${query}`) : await fetch(`${API}${path}`, { method, body: query });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(`${method} ${path}: ${json.error?.message || `HTTP ${res.status}`}`);
  return json;
}

// Instagram processes each container before it can be published.
async function waitUntilReady(id) {
  for (let i = 0; i < 30; i++) {
    const { status_code } = await api('GET', `/${id}`, { fields: 'status_code' });
    if (status_code === 'FINISHED') return;
    if (status_code === 'ERROR' || status_code === 'EXPIRED') throw new Error(`media container ${id}: ${status_code}`);
    await sleep(3000);
  }
  throw new Error(`media container ${id} was not ready after 90 seconds`);
}

async function imageContainer(file, alt, extra) {
  const params = { image_url: `${MEDIA_BASE}/${file}`, ...extra };
  if (alt) {
    try {
      return (await api('POST', `/${USER}/media`, { ...params, alt_text: alt })).id;
    } catch (e) {
      // If this API version does not know alt_text, post without it rather than not at all.
      if (!/alt_text/i.test(e.message)) throw e;
    }
  }
  return (await api('POST', `/${USER}/media`, params)).id;
}

async function publish(post) {
  let creationId;
  if (post.images.length === 1) {
    creationId = await imageContainer(post.images[0], post.alt[0], { caption: post.caption });
  } else {
    const children = [];
    for (let i = 0; i < post.images.length; i++) {
      children.push(await imageContainer(post.images[i], post.alt[i], { is_carousel_item: 'true' }));
    }
    for (const child of children) await waitUntilReady(child);
    creationId = (await api('POST', `/${USER}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption: post.caption })).id;
  }
  await waitUntilReady(creationId);
  const { id } = await api('POST', `/${USER}/media_publish`, { creation_id: creationId });
  const { permalink = '' } = await api('GET', `/${id}`, { fields: 'permalink' }).catch(() => ({}));
  return { media_id: id, permalink };
}

const schedule = read(SCHEDULE);
const state = read(STATE, {});
const gapMs = (schedule.min_gap_hours ?? 3) * 3600_000;

if (!DRY && !TOKEN) {
  console.log('No Instagram token yet (secret IG_ACCESS_TOKEN). Nothing published.');
  process.exit(0);
}
if (!DRY && !USER) USER = await findAccountId();

/** The Instagram account ID behind the token, so IG_USER_ID is optional. */
async function findAccountId() {
  const get = async (path, fields) => {
    const res = await fetch(`${API}${path}?${new URLSearchParams({ fields, access_token: TOKEN })}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) throw new Error(`Could not look up the Instagram account: ${json.error?.message || `HTTP ${res.status}`}`);
    return json;
  };
  if (INSTAGRAM_LOGIN) return String((await get('/me', 'user_id')).user_id);
  const { data = [] } = await get('/me/assigned_instagram_accounts', 'id,username');
  const wanted = (process.env.IG_USERNAME || 'squlpt').toLowerCase();
  const account = data.find(a => a.username?.toLowerCase() === wanted) || (data.length === 1 ? data[0] : null);
  if (!account) throw new Error(`The token is not connected to @${wanted} (found: ${data.map(a => a.username).join(', ') || 'no accounts'}).`);
  return account.id;
}

const due = schedule.posts
  .filter(p => p.status === 'scheduled' && Date.parse(p.publish_at) <= NOW.getTime())
  .sort((a, b) => Date.parse(a.publish_at) - Date.parse(b.publish_at))[0];
const upcoming = schedule.posts
  .filter(p => p.status === 'scheduled' && Date.parse(p.publish_at) > NOW.getTime())
  .sort((a, b) => Date.parse(a.publish_at) - Date.parse(b.publish_at))[0];

if (!due) {
  console.log(upcoming ? `Nothing due. Next: post ${upcoming.id} at ${upcoming.publish_at}.` : 'Nothing scheduled.');
  process.exit(0);
}
const sinceLast = state.last_published_at ? NOW.getTime() - Date.parse(state.last_published_at) : Infinity;
if (sinceLast < gapMs) {
  console.log(`Post ${due.id} is due, but the last post went out ${Math.round(sinceLast / 60000)} min ago. Waiting for the gap.`);
  process.exit(0);
}

console.log(`Publishing post ${due.id} "${due.title}" (${due.images.length} image${due.images.length > 1 ? 's' : ''})`);
try {
  const result = await publish(due);
  Object.assign(due, { status: 'published', published_at: NOW.toISOString(), ...result });
  delete due.last_error;
  state.last_published_at = NOW.toISOString();
  console.log(`Published: ${result.permalink || result.media_id}`);
} catch (e) {
  due.attempts = (due.attempts || 0) + 1;
  due.last_error = e.message;
  if (due.attempts >= MAX_ATTEMPTS) due.status = 'failed';
  console.error(`Failed (attempt ${due.attempts} of ${MAX_ATTEMPTS}): ${e.message}`);
  process.exitCode = 1; // a failed run makes GitHub email the repo owner
}
write(SCHEDULE, schedule);
write(STATE, state);
