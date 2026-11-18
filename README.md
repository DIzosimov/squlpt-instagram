# Squlpt Instagram

Scheduled posts for the Squlpt Instagram account, published automatically by GitHub Actions through the official Instagram API.

- `schedule.json`: every post with its images, caption, alt text, status and publish time (Europe/Stockholm).
  Statuses: `scheduled` (goes out at `publish_at`), `hold` (waits, see `hold_reason`), `published`, `failed`.
- `media/`: the images (JPEG, 1080×1350). They are public because Instagram fetches them by link.
- `publish.mjs`: runs every 15 minutes and publishes the next due post, one per run, at least 3 hours apart.
- `refresh-token.mjs`: renews the Instagram token once a month (tokens last 60 days).

## Setup (once)
In **Settings > Secrets and variables > Actions > New repository secret**, add:

| Secret | Value |
|---|---|
| `IG_ACCESS_TOKEN` | The access token from the Meta app (Instagram API with Instagram Login) |
| `IG_USER_ID` | The Instagram user ID shown next to the token |
| `GH_SECRETS_TOKEN` | Optional but recommended: a fine-grained GitHub token for this repository and `squlpt-instagram-inbox` only, with the permission *Secrets: Read and write*. Lets the job renew the Instagram token by itself, in both repos. |

Until the first two exist, the job runs and does nothing.

## Changing the schedule
Edit `schedule.json` (or ask Claude to): change `publish_at`, or set a held post to `scheduled` with a `publish_at`. To publish right away, use **Actions > Publish Instagram posts > Run workflow**.

If a run fails, GitHub emails the account owner, and the post's `last_error` explains why. After 3 failed attempts a post is marked `failed` and skipped.
