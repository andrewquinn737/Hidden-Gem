# Hidden Gem

Find it. Mark it. Share it. An adventure app for creating, storing, and sharing pins for hard-to-find places — map, a public/private pin list with social features, a scheduler that syncs planned visits to Google/Apple calendars, and a profile.

## Stack

Plain HTML/CSS/JS, no build step — every page is a static file that pulls in `css/style.css` and its own `js/*.js` module. [Supabase](https://supabase.com) (Postgres + Auth + Storage + Edge Functions) for the backend, [Leaflet](https://leafletjs.com) + OpenStreetMap for the map, deployed on [Vercel](https://vercel.com).

## Local development

No build step, so any static file server works:

```bash
npx serve .
```

or

```bash
python3 -m http.server 8000
```

## Database

`supabase/schema.sql` is the source of truth for tables, RLS policies, and storage bucket setup. Apply it via the Supabase SQL editor or Management API on a fresh project.

## Deployment

See `DEPLOYMENT.md`.
