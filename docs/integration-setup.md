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
   - `https://www.googleapis.com/auth/calendar.events`
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.send`
6. **Clients → Create client**:
   - Type: **Web application**
   - Name: Qline
   - Authorized redirect URI: `…/v1/integrations/google/callback` (use the full callback base above)
   - Copy the Client ID and secret.

Google's limits, which Qline can't get around:
- **Testing status:** only listed test users can connect, and connections expire after 7 days. Users then tap Reconnect.
- **Going public for Gmail:** Gmail read and send are "restricted" scopes. Publishing needs Google verification plus a yearly third-party security assessment (CASA).
- **Going public for Calendar:** Calendar is "sensitive" and needs only the free verification. `drive.file` needs only brand verification.

## 2. Slack (notifications to a channel)

1. Open https://api.slack.com/apps and choose **Create New App → From scratch**. Name it **Qline** and pick your workspace.
2. **OAuth & Permissions**:
   - Redirect URL: `…/v1/integrations/slack/callback`
   - Bot token scopes: `chat:write`, `chat:write.public`, `channels:read`
3. **Manage Distribution → Activate public distribution**, so other users' workspaces can connect.
4. **Basic Information**: copy the **Client ID** and **Client Secret**.

## 3. Microsoft (Outlook mail leads and calendar)

1. Open https://entra.microsoft.com and go to **App registrations → New registration**.
   - Name: Qline
   - Supported account types: **Any Entra ID tenant + personal Microsoft accounts**
   - Redirect URI (Web): `…/v1/integrations/microsoft/callback`
2. **Certificates & secrets → New client secret**. Copy the **Value** right away.
3. **API permissions → Microsoft Graph → Delegated**:
   - `offline_access`, `openid`, `email`, `User.Read`, `Mail.Read`, `Mail.Send`, `Calendars.ReadWrite`
4. **Overview**: copy the **Application (client) ID**.

Microsoft has no 7-day limit. Users outside your organization may see an "unverified" label until you complete publisher verification, which is free with a Microsoft partner account.
