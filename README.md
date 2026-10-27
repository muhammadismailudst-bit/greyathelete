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
Name, Gym, Category, Size, Competitions, Items, Note
Ali Khan, Iron Gym, Qatari, M, SBX Series; Savageline, Hand band; T-shirt, paid
```
Only Name is required. One category per athlete. Separate several competitions or items with `;`. New category or item names are added to the lists. A header row and athletes already in the list (same name and gym) are skipped. Up to 500 at a time.

## Photos and PDF
- **Photos:** in Add/Edit, tap **Add photo**. The photo is cropped square and shrunk to about 480px before upload, then stored in the `photos` table.
- **Export PDF:** **⋯ → Export PDF** prints the athletes currently shown (search and filters apply) as an A4 landscape report with the logo, item ticks and totals. On iPhone the print sheet has **Save to Files** / **Share**. It needs Safari or Chrome; in-app browsers such as WhatsApp's may not print.
