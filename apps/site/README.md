# Qline public site

Static home page, privacy policy and terms of service required by Google's OAuth consent screen (Branding → App domain) before Qline's Google Auth Platform audience can move from Testing to In production.

- `index.html` — home page (describes the app, links the privacy policy, lists Google scopes)
- `privacy/index.html` — privacy policy, including the Google API Limited Use disclosure
- `terms/index.html` — terms of service

**The privacy and terms pages are generated.** Edit `apps/mobile/assets/legal/privacy.md` or `terms.md` (the same text the app shows in Settings), then run `node scripts/build-legal.mjs`. CI runs `node scripts/build-legal.mjs --check` and fails if the HTML is out of date.

Plain HTML/CSS with relative links, so it works from any host or sub-path (GitHub Pages, Vercel, own domain). Keep the Google scope tables in sync with `services/api/src/integrations/oauth.ts` (`FEATURE_SCOPES`, `BASE_SCOPES`) and the data handling text in sync with `services/api/src/integrations/leads.ts`.

Preview locally: `python3 -m http.server --directory apps/site`.
