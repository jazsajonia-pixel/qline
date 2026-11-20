# 27 — Facebook Pages (v1.11)

Status labels: **Implemented** (code on main), **Tested** (automated tests in CI), **Device-verified** (checked on a real phone), **Production-verified** (checked against the live API and a real Facebook Page).

Facebook only. Instagram, YouTube, TikTok and other platforms are not built; Instagram is listed as "planned" in Integrations.

## What it does

- **Connect.** Integrations → Facebook signs the person in with Facebook Login (OAuth, no PKCE; Meta does not support it for this flow). The short-lived user token is exchanged for a long-lived one, the granted permissions are read from `/me/permissions`, and the Pages the person manages are read from `/me/accounts` (up to 300). Each Page token is sealed (AES-GCM) with the additional data `facebook-page:<orgId>:<pageId>`; tokens never reach the phone.
- **Permissions.** Requested: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`; `publish_video` only when the "Facebook video" feature is ticked. Re-asking uses `auth_type=rerequest`, so a declined permission can be granted later. A Page is postable only when the person has the CREATE_CONTENT or MANAGE task on it; otherwise the app says "You can't create posts on this Page".
- **Posts.** Text, link, photo (JPEG, PNG, GIF) and video (MP4, MOV). Post now or schedule 11 minutes to 30 days ahead (Facebook's window is 10 minutes to 30 days; Qline adds one minute of margin). Photos go to `/{page}/photos`, videos to `graph-video.facebook.com/{page}/videos`, the rest to `/{page}/feed`, with `published=false` + `scheduled_publish_time` when scheduled. Every Graph call carries `appsecret_proof`. Graph API version `v27.0`.
- **Approval.** Nothing is posted without a person's explicit approval:
  - In the app: `POST /facebook/posts/preview` returns the exact preview and a content hash. The person sees it in a review sheet and taps "Approve and publish" / "Approve and schedule". `POST /facebook/posts` needs `confirm: true` and the same hash; if anything changed (text, Page, file, time) the server answers 409 `FACEBOOK_POST_CHANGED`. Only a signed-in person can call it, not a service key or the AI.
  - By the AI: the `facebook.post` tool is risk level L3 and in `ALWAYS_ASK`, so it always waits in Approvals, also on full autopilot. The approval pins the content hash and Page; on approval the tool re-checks both before posting. Only the CEO and Marketing agents may propose posts.
- **Idempotency.** Each approval has a request key (unique in `facebook_posts`). The row is written as `publishing` before calling Facebook, so a retry never posts twice.
- **Status.** published, scheduled, processing (video), failed, cancelled, unknown. A `facebook.reconcile` job re-checks scheduled and processing posts every 10 minutes (up to 12 times) and notifies the person when a post goes live or fails. When Facebook's answer is lost (timeout), the post is marked **unknown** and is not resent; the person checks Facebook.
- **Cancel.** A scheduled post can be cancelled until one minute before it goes live (it is deleted on Facebook, the record stays as cancelled). Published posts are not deleted by Qline.
- **Errors.** Graph error codes are mapped to plain messages: reconnect (190, 102; the connection is marked expired), permission (10, 200–299), rate limit (4, 17, 32, 613, 80000-range), blocked (368), duplicate (506), invalid, unavailable (1, 2, 5xx).
- **Disconnect** revokes the app's permissions on Facebook (best effort) and forgets the Page tokens.

Endpoints (all under `/v1`): `GET /facebook/pages`, `POST /facebook/pages/sync`, `GET /facebook/posts`, `POST /facebook/posts/preview`, `POST /facebook/posts`, `GET /facebook/posts/:id`, `POST /facebook/posts/:id/cancel`, `POST /facebook/media`. Reads need `tasks.read`, writes `contacts.write`, sync `integrations.manage`. Tables `facebook_pages` and `facebook_posts` have row-level tenant isolation; the app role cannot delete post records. Migration `0026_facebook.sql`.

## Limits (honest)

- Photos and videos are uploaded in one request, **10 MB at most**. Longer videos need Facebook's resumable upload, which is not built.
- No analytics, comments, Messenger, Instagram or Business Manager features. Pages owned through Business Manager may also need `business_management`, which Qline does not request; such Pages may not appear.
- No webhooks: status comes from the reconcile job and from opening a post.
- Times in previews are shown in Asia/Manila.

## Setup (server owner, once)

1. Create a Meta app at [developers.facebook.com/apps](https://developers.facebook.com/apps) (type Business) and add **Facebook Login for Business** or **Facebook Login**.
2. Valid OAuth redirect URI: `<publicUrl>/v1/integrations/facebook/callback`.
3. App settings → Advanced: turn on **Require App Secret** (Qline sends `appsecret_proof` on every call).
4. Put the App ID and App Secret in Integrations → Integration setup → Facebook, or set `QLINE_FACEBOOK_CLIENT_ID` / `QLINE_FACEBOOK_CLIENT_SECRET`. Never commit them.
5. In development mode only app roles (admins, developers, testers) can connect. For other people, Meta **App Review** is needed for `pages_show_list`, `pages_read_engagement`, `pages_manage_posts` and (for video) `publish_video`, plus Business Verification.

## Verification

| Item | Implemented | Tested | Device-verified | Production-verified |
| --- | --- | --- | --- | --- |
| OAuth connect, long-lived token, permissions, Page sync | Yes | Yes (integration test with a fake Graph API) | No | No |
| Text/link/photo/video posts, scheduling | Yes | Yes (fake Graph API) | No | No |
| Preview hash, 409 on change, human-only approval | Yes | Yes | No | No |
| AI tool always waits in Approvals | Yes | Yes | No | No |
| Reconcile job, notifications, unknown outcome | Yes | Yes | No | No |
| Cancel scheduled post | Yes | Yes | No | No |
| Phone: Pages, posts, composer, review sheet | Yes | Yes (widget tests) | No | No |

Nothing here has been run against the real Graph API or a real Page: there is no Meta app registered for Qline yet. Before calling it production-verified: register the app, apply migration 0026, connect a test Page, and post, schedule, cancel and fail (duplicate) one post each.

Meta references: [Page feed posts](https://developers.facebook.com/docs/pages-api/posts), [Page photos](https://developers.facebook.com/docs/graph-api/reference/page/photos/), [Page videos](https://developers.facebook.com/docs/graph-api/reference/page/videos/), [long-lived tokens](https://developers.facebook.com/documentation/facebook-login/guides/access-tokens/get-long-lived/), [Graph API changelog](https://developers.facebook.com/documentation/development/graph-api/changelog).
