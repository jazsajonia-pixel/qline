# Qline integration setup (one-time, app owner only)

Register Qline once with each provider. After that, every Qline user only taps **Connect** and logs in with their own account.

Callback base (Qline API): `https://br-muddy-rain-a1uaplxr-api.compute.c-1.ap-southeast-1.aws.neon.tech/v1/integrations`

From each provider, keep the **Client ID** and **Client secret**. Don't paste them into chats or email. Qline 1.2 has an owner-only **Settings → Integration setup** screen that stores them encrypted.

---

## 1. Google (Gmail, Sheets, Forms, Drive files, Calendar)

1. Open https://console.cloud.google.com and create a project named **Qline**.
2. **APIs & Services → Library**: enable **Gmail API**, **Google Sheets API**, **Google Forms API**, **Google Drive API** and **Google Calendar API**.
3. **Google Auth Platform → Branding**:
   - App name: **Qline**
   - Support and developer email: yours
4. **Audience**:
   - User type: **External**
   - Status: **Testing**
   - **Test users**: add your Gmail plus anyone who needs Gmail lead capture now (100 max).
5. **Data access → Add or remove scopes**. Paste these:
   - `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`
   - `https://www.googleapis.com/auth/drive.file` (Sheets, Forms and Drive files Qline creates)
   - `https://www.googleapis.com/auth/drive.readonly` (v1.6: lets the AI search and read files you already have in Drive; restricted scope, see below)
   - `https://www.googleapis.com/auth/calendar.events`
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.send`
6. **Clients → Create client**:
   - Type: **Web application**
   - Name: Qline
   - Authorized redirect URI: `https://br-muddy-rain-a1uaplxr-api.compute.c-1.ap-southeast-1.aws.neon.tech/v1/integrations/google/callback`
   - Copy the Client ID and secret.

Google's limits, which Qline can't get around:
- **Testing status:** only listed test users can connect, and connections expire after 7 days. Users then tap Reconnect.
- **Going public for Gmail:** Gmail read and send are "restricted" scopes. Publishing needs Google verification plus a yearly third-party security assessment (CASA).
- **Going public for Calendar:** Calendar is "sensitive" and needs only the free verification. `drive.file` needs only brand verification.
- **Drive read (v1.6):** `drive.readonly` is restricted like Gmail. It works now for listed test users in Testing mode; publishing it needs verification plus CASA. Existing Google connections must tap **Reconnect** in Qline with **Drive files** ticked to grant it. No new client ID is needed.

## 2. Slack (notifications to a channel)

1. Open https://api.slack.com/apps and choose **Create New App → From scratch**. Name it **Qline** and pick your workspace.
2. **OAuth & Permissions**:
   - **Redirect URLs → Add New Redirect URL**, paste exactly
     `https://br-muddy-rain-a1uaplxr-api.compute.c-1.ap-southeast-1.aws.neon.tech/v1/integrations/slack/callback`,
     tap **Add**, then **Save URLs** (the URL is not kept until you save). The Settings → Integration setup screen shows the same URL with a copy button.
   - Bot token scopes: `chat:write`, `chat:write.public`, `channels:read`, `channels:manage` (v1.6: lets the AI create channels and set topics; reconnect Slack after adding it)
3. **Manage Distribution → Activate public distribution**, so other users' workspaces can connect.
4. **Basic Information**: copy the **Client ID** and **Client Secret**.

## 3. Microsoft (Outlook mail leads and calendar)

1. Open https://entra.microsoft.com and go to **App registrations → New registration**.
   - Name: Qline
   - Supported account types: **Any Entra ID tenant + personal Microsoft accounts**
   - Redirect URI (Web): `https://br-muddy-rain-a1uaplxr-api.compute.c-1.ap-southeast-1.aws.neon.tech/v1/integrations/microsoft/callback`
2. **Certificates & secrets → New client secret**. Copy the **Value** right away.
3. **API permissions → Microsoft Graph → Delegated**:
   - `offline_access`, `openid`, `email`, `User.Read`, `Mail.Read`, `Mail.Send`, `Calendars.ReadWrite`
4. **Overview**: copy the **Application (client) ID**.

Microsoft has no 7-day limit. Users outside your organization may see an "unverified" label until you complete publisher verification, which is free with a Microsoft partner account.

## 4. Notion (v1.6: read and write pages)

1. Open https://www.notion.so/profile/integrations and choose **New integration**.
   - Type: **Public** (OAuth). Name: **Qline**. Associated workspace: yours.
   - Fill in the company name, website, privacy policy and terms URLs Notion asks for.
   - **Redirect URI**: `https://br-muddy-rain-a1uaplxr-api.compute.c-1.ap-southeast-1.aws.neon.tech/v1/integrations/notion/callback`
   - Capabilities: **Read content**, **Update content**, **Insert content**. User information: **Read user information including email addresses**.
2. Save, then open the **Configuration** tab and copy the **OAuth client ID** and **OAuth client secret**.
3. In Qline: **Settings → Integration setup → Notion**, paste both.
4. Each user taps **Integrations → Notion → Connect** and picks the pages Qline may use. The AI only sees pages picked there.

## 5. GitHub (v1.6: issues and pull requests)

Qline uses a **GitHub App** with user access tokens, so access is limited to the repositories where the app is installed.

1. Open https://github.com/settings/apps → **New GitHub App**.
   - Name: **Qline** (must be unique on GitHub; add a suffix if taken). Homepage: any URL you own.
   - **Callback URL**: `https://br-muddy-rain-a1uaplxr-api.compute.c-1.ap-southeast-1.aws.neon.tech/v1/integrations/github/callback`
   - Keep **Expire user authorization tokens** on. Leave **Request user authorization during installation** off.
   - Webhook: untick **Active** (Qline does not use GitHub webhooks yet).
   - Repository permissions: **Issues: Read and write**, **Pull requests: Read-only**, **Contents: Read-only**, **Metadata: Read-only**.
   - Where can it be installed: **Any account** if other people's repos should connect, otherwise **Only on this account**.
2. Create the app, then copy the **Client ID** and **Generate a new client secret**.
3. **Install App** → install it on the repositories Qline may see.
4. In Qline: **Settings → Integration setup → GitHub**, paste both, then **Integrations → GitHub → Connect**.

## 6. Stripe (v1.6: restricted key, no OAuth app)

Stripe needs no app registration. Each workspace pastes a **restricted key**; Qline refuses full secret keys (`sk_…`).

1. Open https://dashboard.stripe.com/apikeys → **Create restricted key** (use Test mode first).
2. Permissions:
   - **Read**: Balance, Charges, Customers, Invoices, Subscriptions, Products.
   - **Write**: Customers, Invoices (Qline only creates customers and **draft** invoices, always after your approval; it never sends, finalizes, charges or refunds).
   - Everything else: **None**.
3. Copy the key (`rk_test_…` or `rk_live_…`), then in Qline: **Integrations → Stripe → Connect Stripe** and paste it. Qline checks it with Stripe and stores it encrypted.

## 7. Content Studio (v1.9: video handoffs through Drive)

Uses the Google connection from section 1. No new scope.

1. **Connect Google** with **Drive files** ticked (the account must be a listed test user while the app is in Testing).
2. In Drive, arrange one main folder with these folders inside it (any names, any depth up to 20):
   - **Source files** (one or more): what the editor works from. Qline only reads them.
   - **Ready for QA**: where the editor puts the finished video.
   - **Reports** (optional): where the editor puts `…result.json`. Without it, paste the result into the job.
   Share the main folder (or just these folders) with the editor yourself. Qline never shares anything.
3. In Qline: **Home → Command Center → Content Studio → Drive folders**. Paste each folder's link or ID, tap **Save and check folders**, fix anything it reports, then **Sync now**.
4. **New handoff** → pick files, write the brief, create. Save the editor PDF and manifest and send them to the editor. Point them to [docs/23](23-EDITOR_HANDOFF_SPEC.md).
5. Optional push updates: set `QLINE_DRIVE_WEBHOOK_URL=https://<api host>/v1/hooks/drive` on the API (HTTPS with a valid certificate). Without it, Qline checks for changes every 10 minutes.

Server requirement: API 1.9.0 with migrations 0020–0024. On an older server the app shows "Content Studio is not on your server yet".
