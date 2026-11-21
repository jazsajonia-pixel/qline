# Privacy Policy

Version 2026-11-21 · Effective 21 November 2026

This policy explains what personal information Qline collects, why, who it is shared with, how long it is kept, and the rights you have. It applies to the Qline Android app, the Qline API at our servers, and this website.

Qline is operated by **Jazz Sajonia**, an individual based in Davao City, Philippines ("Qline", "we", "us"). Privacy contact and data protection officer: **Jazz Sajonia, chrono07g@gmail.com**.

## 1. Our role

- **Your own account.** For your account details (name, email, sign-in and device sessions), we decide how the information is used. Under the Philippine Data Privacy Act of 2012 (Republic Act No. 10173, the "DPA"), we are the personal information controller.
- **Business data you put in Qline.** When you or your organisation add information about other people, such as contacts, leads, customers, team members, emails or files, the organisation that uses Qline decides why that information is processed. For that information, the organisation is the controller and Qline processes it on the organisation's behalf, only to provide the service. The organisation is responsible for having a lawful basis, such as consent, to collect and use it and for answering requests from those people. We will help it do so.

## 2. Information we collect

### Account and sign-in

- Name, email address and a password. We store only a salted hash of the password, never the password itself.
- If you use **Continue with Google**: your Google account ID, name, email address, whether Google has verified it, and profile picture (scopes `openid`, `email`, `profile`).
- Device sessions: when a session started and expires, the IP address and the device or browser description (user agent) reported when you signed in. You can see and end sessions in Settings → Signed-in devices.
- Organisations and personal spaces you create or join, your role, invitations, and the audit log of important actions.

### Content you add

Tasks, projects, notes, documents, files you upload or import (CSV, Excel, PDF, Word, text), contacts and companies, leads, workflows, missions, approvals, AI agent settings, knowledge and memory entries, and AI conversations, including attachments and the AI's replies.

### AI provider keys

If an owner or admin adds an API key for OpenAI, Anthropic, Google Gemini, xAI or DeepSeek, the key is encrypted and used only to make requests for that organisation. Keys are never shown again after saving and are never sent to AI models.

### Connected services (optional)

You can connect other accounts. Each connection is optional, asks only for the permissions of the features you turn on, and can be disconnected at any time. For every connection we store encrypted access tokens and the connected account's name, email or ID.

| Service | What Qline can access | Why |
| --- | --- | --- |
| Gmail (`gmail.readonly`, `gmail.send`) | New messages received after you connect; sending messages from your account | Find sales leads and rate how urgent they are, alert you about important email, search or read email when you ask the AI, and send email you or your approved workflows send |
| Google Sheets and Forms (`drive.file`) | Only files Qline creates or that you open with Qline | Create lead sheets and forms and read their responses |
| Google Drive (`drive.readonly`, `drive.file`) | Files your Google account can open, read only; edits only to files Qline created | Read files you choose for your knowledge base, AI answers and Content Studio, and watch the folders you pick for Content Studio |
| Google Calendar (`calendar.events`) | Events on your calendars | List upcoming events and create meetings and follow-ups you ask for |
| Microsoft 365 (`Mail.Read`, `Mail.Send`, `Calendars.ReadWrite`) | Outlook mail and calendar | The same uses as Gmail and Google Calendar |
| Slack (`chat:write`, `chat:write.public`, `channels:read`, `channels:manage`) | Channel list; posting; creating channels | Post the alerts you choose and, if your autonomy setting allows, create channels |
| Notion | Only the pages you share with Qline on Notion's consent screen | Read those pages for your knowledge base and AI answers |
| GitHub (Qline GitHub App) | Only the repositories you install the app on: code, branches, pull requests, issues, checks and workflow runs | Let the AI read code and, after you approve each change, create branches, commits, pull requests and comments |
| Facebook Pages (`pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, optional `publish_video`) | The Pages you manage and choose | Draft and publish or schedule posts to your Page only after you approve each one; Qline does not read your personal profile, friends, groups or messages |
| Stripe (restricted key you create) | Customers, payments, invoices and subscriptions allowed by your key | Summarise payments, and with your approval add customers and prepare draft invoices; Qline never charges, refunds or sends invoices |

### Voice

- **Listening:** speech recognition uses your phone's speech service (for example, Google speech services on Android). Your phone's provider may process the audio under its own terms. Qline does not record or store audio.
- **Live conversation:** while a live conversation is on, the microphone stays open until you tap End (Android shows a "Qline is listening" notification). Qline checks the sound on your phone to tell when you start and stop talking; only your turns are passed to your phone's speech service. This sound is not saved or sent to Qline.
- **Qline voice:** if you choose it, replies are turned into speech on your phone by a voice model you download once from the sherpa-onnx project on GitHub. After the download it works offline, and reply text is not sent anywhere to be spoken. You can delete the model in Settings → Voice.
- **Spoken replies (other voices):** if your organisation turns on natural voices, the text of the reply is sent to Google Gemini using your organisation's own Gemini key to create audio. Qline does not store that audio. Otherwise your phone's built-in text-to-speech is used.
- Transcripts of what you said are saved as part of the conversation, like typed messages.

### On your phone

- Your sign-in token, preferences and a few app settings are kept in Android's encrypted storage on your device.
- **Notifications** are created by the app on your phone while it is open or running in the background. Qline does not use a third-party push service.
- **App updates:** the app checks GitHub (`api.github.com`) for new Qline releases. GitHub sees your IP address and the request, like any web visit. If you choose to update, the file is downloaded from GitHub, its checksum and signing certificate are checked, and Android asks you to confirm the install.

### Technical and security information

Request logs kept by our hosting provider (time, IP address, request path, status and error details) for security and troubleshooting. We do not use analytics, advertising or tracking tools, and the app has no third-party advertising or analytics SDKs.

## 3. How we use information

- To provide Qline: run your workspace, show your data to the people in your organisation according to their roles, run the workflows and agents you set up, and produce AI answers, drafts and suggestions.
- To keep Qline secure: authenticate you, prevent abuse, investigate incidents and fix problems.
- To communicate with you about your account, security and important changes.
- To meet legal obligations and to establish or defend legal claims.

Our legal bases under the DPA (and, where they apply, the EU or UK GDPR) are: performance of our contract with you (these services), your consent for optional connections and features, our legitimate interests in security and improving reliability, and compliance with law.

**We do not sell personal information, do not use it for advertising, and do not use your content or connected-account data to train AI models.**

### Automated assessments

Lead triage rates incoming messages (for example "urgent" or "not a lead") so you can prioritise them. These ratings are suggestions for you to review. Qline does not make decisions that have legal or similarly significant effects on anyone without a person involved.

## 4. AI providers

Qline does not run its own AI model. When you use AI features, Qline sends the request to the provider your organisation chose (OpenAI, Anthropic, Google Gemini, xAI or DeepSeek), using your organisation's own key. What is sent depends on what you ask: your message, relevant parts of your workspace (such as records, documents or knowledge you or the AI look up), and content from connected services the AI reads for that request, for example the sender, subject and up to a few thousand characters of an email. Providers process this under their own terms and privacy policies, which your organisation accepts when it creates the key. Some providers are outside the Philippines; for example, DeepSeek processes data in China. Choose a provider whose terms suit your data.

## 5. Google user data

Qline's use and transfer to any other app of information received from Google APIs will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements. In particular:

- We use Google data only to provide and improve the user-facing features described in section 2.
- We transfer Google data to others only to provide those features (for example, to the AI provider your organisation chose, when you ask the AI to read an email or triage leads), to comply with law, for security, or as part of a merger or acquisition with notice to you.
- We do not use Google data for advertising, do not sell it, and do not use it to develop, improve or train generalised AI or machine-learning models.
- People at Qline do not read your Google data unless you give permission for specific items, it is necessary for security or to comply with law, or it is aggregated and anonymised for internal operations.

**What we store from Google:** for each new email Qline checks, the sender's name and email, subject, the first 500 characters of the text, the time received and Qline's lead assessment, so the same message is not processed twice. We do not keep a copy of your mailbox or attachments. Emails the AI reads at your request are not stored beyond the conversation in which you asked, where the AI's reply is saved. For Drive, Sheets, Forms and Calendar, we store IDs and links of the files and events Qline works with, and the text of files you add to your knowledge base.

## 6. Who we share information with

- **People in your organisation**, according to their roles. Private knowledge entries stay visible only to you.
- **Service providers that run Qline:** Neon (database, server functions and file storage, hosted on Amazon Web Services in Singapore) and GitHub (app downloads and update checks).
- **Services you connect and AI providers you choose**, as described above, only to do what you asked.
- **Authorities**, when required by law or a valid legal order, or to protect people's safety, rights or property.
- **A buyer or successor**, if Qline is sold or merged, with notice to you, under this policy.

We do not share personal information with anyone else.

## 7. Where information is stored

Qline's servers, database and files are in the Amazon Web Services Asia Pacific (Singapore) region through Neon. Connected services and AI providers may process data in other countries, including the United States and China. When we transfer personal information outside the Philippines, we remain responsible for it under the DPA and use providers bound by contract to protect it.

## 8. How we protect information

- All traffic uses HTTPS. Android blocks unencrypted connections for the app.
- Passwords are hashed. OAuth tokens, AI keys and Facebook Page tokens are encrypted at rest (AES-256-GCM).
- Each organisation's data is separated in the database with row-level security, and the server checks your role for every request.
- Risky AI actions need a person's approval unless an owner deliberately turns on autopilot; publishing to Facebook and changing code on GitHub always need approval. There is an emergency stop.
- The audit log is tamper-evident. Uploaded files are checked before they are read.

No system is perfectly secure. If a personal data breach happens that the law requires us to report, we will notify the National Privacy Commission and affected people within 72 hours of learning about it, as NPC Circular 16-03 requires, and tell you what we are doing about it.

## 9. How long we keep information

| Information | How long |
| --- | --- |
| Account and workspace content | While your account or organisation is active, until you or an admin deletes it |
| Sign-in sessions | Up to 30 days of inactivity, or until you sign out or end them |
| Connected-account tokens | Until you disconnect the service; disconnecting deletes the tokens and revokes Qline's access where the service allows |
| Leads found in email | Until you or your organisation deletes them |
| Short-lived security records (sign-in and connection requests) | About 30 minutes |
| Hosting request logs | According to Neon's log retention |
| Backups | Overwritten on their normal schedule, generally within 30 days |

After you delete your account, we delete or anonymise your personal information within 30 days, except what the law requires us to keep, or what we need to resolve a dispute or enforce our terms. Content you shared in an organisation stays with that organisation if other members still use it, but your name is removed or replaced.

## 10. Your rights

Under the DPA you have the right to be informed, to access, to object, to correct, to erasure or blocking, to data portability, to damages, and to file a complaint. Depending on where you live, laws such as the GDPR or the California Consumer Privacy Act may give you similar rights.

- **Export:** owners and admins can export an organisation's data in Settings → Export all data.
- **Correct:** you can edit most information directly in the app.
- **Disconnect:** Settings → Integrations, or from the other service's own security settings.
- **Delete your account:** Settings → Delete account, which tells you exactly what happens and sends us the request, or email chrono07g@gmail.com from the address on your account. We confirm it is you, then act within 30 days.
- **Anything else:** email chrono07g@gmail.com. We answer within 15 working days. We may ask you to prove your identity.

If you are not satisfied, you can complain to the [National Privacy Commission of the Philippines](https://privacy.gov.ph) or the data protection authority where you live.

If your information is in an organisation's workspace (for example, you are a contact or lead of a business that uses Qline), please contact that business first. We will pass your request on and help it respond.

## 11. Children

Qline is for adults and businesses. You must be at least 18 to use it. We do not knowingly collect information from anyone under 18. If you believe a child has given us information, contact us and we will delete it.

## 12. Changes to this policy

When our practices change, we will update this policy and its version date. For important changes, we will tell you in the app or by email before they take effect. The current version is always in the app (Settings → Privacy policy) and in the Qline repository.

## 13. Contact

Jazz Sajonia (Qline), Davao City, Philippines · chrono07g@gmail.com
