# Deploying Hidden Gem

## Supabase (already provisioned)

Project ref `sfncertevakntsfvovsz` in the "Hidden Gem" org. `supabase/schema.sql` has already been applied. `js/config.js` already points at this project's URL and publishable (anon) key — safe to have in the client, since real access control is entirely in the RLS policies in `supabase/schema.sql`.

## Vercel

1. Go to https://vercel.com/new
2. Import the `andrewquinn737/Hidden-Gem` GitHub repo (authorize Vercel's GitHub App if this is the first import).
3. Framework preset: **Other** — no build command, no output directory. This is a static site with no build step.
4. Deploy. Every push to `main` after this auto-deploys.

No environment variables are needed for the core app — Supabase connection details are already in `js/config.js`.

## Stage 5 — external integrations (not yet wired)

These need credentials only the project owner can create:

- **Google Calendar sync**: a Google Cloud OAuth client (Client ID + Secret).
- **Apple Calendar sync**: no external account needed — each user supplies their own iCloud app-specific password in-app (generated at appleid.apple.com), used for CalDAV.
- **Email invites**: a [Resend](https://resend.com) API key.
- **SMS invites**: a Twilio account (Account SID, Auth Token, phone number) — Twilio requires billing, there's no free ongoing SMS provider.

Once provided, these get set as Supabase Edge Function secrets and wired into `supabase/functions/`.
