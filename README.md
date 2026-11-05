# Grey Athlete Kit Log

Tracks which athlete, from which gym, received which kit items (head band, flag, bag, badge, T-shirt), grouped by batch (e.g. T-100), with a note per person and a note per batch. Staff unlock it with a shared PIN.

- **Site:** static files on GitHub Pages (`index.html`, `styles.css`, `app.js`, `config.js`)
- **Data:** Supabase (free tier). The PIN is checked on the server; without a valid session the database returns nothing.

## One-time setup

### 1. Create the database
1. Make a free account at supabase.com and create a new project.
2. Open **SQL Editor → New query**, paste all of `supabase/setup.sql`, and click **Run**.
3. In a new query, set the staff PIN (6–12 digits):
   ```sql
   select public.set_pin('your-pin');
   ```
   Run it again any time to change the PIN. Changing it logs everyone out.

### 2. Connect the site
In Supabase, open **Project Settings → API** (or the **Connect** button) and copy:
- the **Project URL** (`https://xxxx.supabase.co`)
- the **anon** or **publishable** key

Put both in `config.js`. They are safe to publish: the database refuses everything without a PIN session.

### 3. Turn on GitHub Pages
On GitHub, open the repo's **Settings → Pages**. Under **Build and deployment**, choose **Deploy from a branch**, set the branch to **master** and the folder to **/ (root)**, then click **Save**.

The site will be at `https://muhammadismailudst-bit.github.io/greyathelete/` within a minute or two.

## How the security works
- Every table has row level security turned on with no policies, and all table rights are taken away from the public API roles. The browser can't read or write the tables directly.
- The app can only call a fixed set of database functions. Every function except `login` needs a session token.
- `login` checks the PIN against a bcrypt hash and returns a token that lasts 30 days. **Lock** ends the session.
- After 20 wrong PINs in 10 minutes from anyone, new logins pause for up to 10 minutes. People already logged in can keep working.
- The page sets a strict Content Security Policy. It only talks to `*.supabase.co`.

Limits to know: everyone shares one PIN, so the app can't tell who changed what. Anyone who knows the PIN can see and change all records.

## Bulk add format
Tap **⋯ → Bulk add** and paste one athlete per line (commas, or rows copied from Excel / Google Sheets):

```
Name, Gym, Nationality, Phone, Instagram, Category, Size, Competitions, Items, Note
Ali Khan, Iron Gym, Qatari, +974 5555 1234, ali.khan, Rx, M, SBX Series; Savageline, Hand band; T-shirt, paid
```
Only Name is required. One category per athlete. Separate several competitions or items with `;`. New category, competition or item names are added to the lists. A header row and athletes already in the list (same name and gym) are skipped. Up to 500 at a time.

## Photos and PDF
- **Photos:** in Add/Edit, tap **Add photo**. The photo is cropped square and shrunk to about 480px before upload, then stored in the `photos` table.
- **Export PDF:** **⋯ → Export PDF** builds an A4 landscape PDF of the athletes currently shown (search and filters apply), or of the events on the Events tab, with the logo, ticks, totals and page numbers. It is made in the browser (jsPDF + html2canvas in `vendor/`), so there is no print dialog and no browser date/URL on the pages. On phones it opens the Share sheet; on computers it downloads.

## Events (synced with Google Calendar)
The **Events** tab shows the **Grey Events** Google Calendar live: events added or changed in Google Calendar appear in the app, and adding, editing or deleting in the app (admins only) changes Google Calendar.

How: the app calls the Supabase Edge Function `supabase/functions/calendar`, which checks the signed-in user's role (`my_access`) and talks to Google with a service account.

One-time setup:
1. Google Cloud (Grey Athletes project): enable **Google Calendar API**; create a service account; add a **JSON key**.
2. Google Calendar → Grey Events → **Settings and sharing → Share with specific people**: add the service account's email with **Make changes to events**.
3. Supabase → Edge Functions → Secrets: `GOOGLE_SERVICE_ACCOUNT` = the whole JSON key file. (Optional: `GREY_CALENDAR_ID`, `ALLOWED_ORIGINS`.)
4. Deploy the `calendar` function with JWT verification off (it checks the user itself).

The old `events` table (supabase/008_events.sql) is no longer used by the app.

## Google sign-in and roles (supabase/009_google_login.sql)
Staff sign in with Google; the PIN is retired. Roles live in `app_users` and are enforced in the database:
- **admin**: everything, including **⋯ → Team & access** to add people by Gmail address.
- **viewer**: the Events tab only, read-only.
A Google account that isn't on the team sees "No access yet".

One-time setup (before running 009):
1. Google Cloud Console → new project → **OAuth consent screen** (External, app name, support email) → **Publish app**.
2. **Credentials → Create credentials → OAuth client ID → Web application**.
   - Authorized JavaScript origins: `https://muhammadismailudst-bit.github.io`
   - Authorized redirect URIs: `https://gjrsjygtlnlqovjulnrq.supabase.co/auth/v1/callback`
3. Supabase → **Authentication → Sign In / Providers → Google**: enable, paste Client ID and Client Secret, save.
4. Supabase → **Authentication → URL Configuration**: Site URL and Redirect URLs = `https://muhammadismailudst-bit.github.io/greyathelete/`
5. Run `supabase/009_google_login.sql` in the SQL Editor.
