# Split Tab

Split bills with friends and settle up once a month.

- **Accounts:** sign up with email and password. Log in is the first screen.
- **Friends:** find people by username or email and send an invite. They accept it in the app.
- **Groups and expenses:** add a bill with a description, who paid, and who was involved. Split it equally or by exact amounts.
- **Balances:** the app works out who owes whom. Turn on **Simplify group debts** to settle in the fewest payments. Tap **Mark paid** to record a payment.
- **Live:** everyone in a group sees new expenses the moment they're added.
- **Notifications:** friends get a push notification when they're added to a bill, paid, or invited. Everyone gets a settle-up reminder on the last evening of each month.

It's a web app you install to your phone's Home Screen, so there's no app store. The data and logins live in a free [Supabase](https://supabase.com) project that you own.

---

## Setup (about 20 minutes, once)

You need: a Supabase account (free), this GitHub repo, and Node.js on your computer for two commands.

### 1. Create the database

1. Go to [supabase.com](https://supabase.com) → **New project**. Pick any name and a strong database password. Choose a region near you (e.g. West US).
2. When it's ready, open **SQL Editor** → **New query**. Paste the whole contents of [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql) and click **Run**. You should see "Success".
3. Open **Project Settings → API**. Keep this tab open. You'll need the **Project URL** and the **anon public** key.

### 2. Set up sign-in

In **Authentication → URL Configuration**:

- **Site URL:** `https://nsanati.github.io/finance-brothers/`
- **Redirect URLs:** add `https://nsanati.github.io/finance-brothers/**`

By default, Supabase emails new users a confirmation link. To let friends sign up without one, turn off **Authentication → Providers → Email → Confirm email**. The built-in email sender is rate-limited, so turning it off avoids "email rate limit exceeded" when several friends join at once.

### 3. Make notification keys

On your computer, run:

```bash
npx web-push generate-vapid-keys
```

It prints a **Public Key** and a **Private Key**. Keep both.

### 4. Deploy the notification functions

**No-terminal option:** in Supabase go to **Edge Functions → Deploy a new function → Via Editor**, paste [`supabase/dashboard/notify.ts`](supabase/dashboard/notify.ts), name it `notify`, deploy, then in its **Settings** turn off **Verify JWT with legacy secret**. Repeat with [`supabase/dashboard/month-end.ts`](supabase/dashboard/month-end.ts) named `month-end`. Add the four secrets (below) under **Edge Functions → Secrets**.

**Terminal option:**

Install the [Supabase CLI](https://supabase.com/docs/guides/cli/getting-started), then from this repo's folder run the commands below. Replace the capitalized parts. `YOUR-PROJECT-REF` is the code in your Project URL (`https://YOUR-PROJECT-REF.supabase.co`). `PICK-A-LONG-RANDOM-SECRET` can be any long random string; you'll reuse it in step 5.

```bash
supabase login
supabase link --project-ref YOUR-PROJECT-REF

supabase secrets set \
  VAPID_PUBLIC_KEY="YOUR-PUBLIC-KEY" \
  VAPID_PRIVATE_KEY="YOUR-PRIVATE-KEY" \
  VAPID_SUBJECT="mailto:you@example.com" \
  CRON_SECRET="PICK-A-LONG-RANDOM-SECRET"

supabase functions deploy notify --no-verify-jwt
supabase functions deploy month-end --no-verify-jwt
```

### 5. Schedule the month-end reminder

1. In Supabase, go to **Database → Extensions** and enable **pg_cron** and **pg_net**.
2. In the **SQL Editor**, run this with your values filled in:

```sql
select cron.schedule(
  'split-tab-month-end',
  '0 2 1 * *',  -- 02:00 UTC on the 1st = the evening of the last day of the month in California
  $$
  select net.http_post(
    url     := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/month-end',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-cron-secret', 'PICK-A-LONG-RANDOM-SECRET'),
    body    := '{}'::jsonb
  );
  $$
);
```

To test it right away, run just the `select net.http_post(...)` part on its own. Everyone with an open balance who has notifications on gets the reminder.

### 6. Publish the app with GitHub Pages

In this repo on GitHub:

1. **Settings → Pages → Build and deployment → Source:** choose **GitHub Actions**.
2. **Settings → Secrets and variables → Actions → Variables tab → New repository variable.** Add three:

   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | Project URL from step 1 |
   | `SUPABASE_ANON_KEY` | anon public key from step 1 |
   | `VAPID_PUBLIC_KEY` | Public Key from step 3 |

   These three are public by design. They're visible to anyone who opens the app. **Never** put the VAPID *private* key or Supabase's `service_role` key here.
3. **Actions** tab → **Deploy app to GitHub Pages** → **Run workflow**.

When it finishes, the app is live at **https://nsanati.github.io/finance-brothers/**.

> GitHub Pages is free for public repos. A private repo needs a paid GitHub plan for Pages, or you can deploy the same build to Netlify or Vercel instead.

---

## For your friends

Send them the link. Then:

1. **Sign up** with their name, a username, email, and password.
2. **Install it:**
   - **iPhone:** open the link in Safari → Share → **Add to Home Screen**. Notifications on iPhone only work from the Home Screen app (iOS 16.4 or later).
   - **Android:** Chrome menu → **Install app**.
3. Open it, go to **Account → Turn on notifications**.
4. Go to **Friends**, search your username, and send an invite, or accept yours.

---

## Run it on your computer

```bash
cp .env.example .env.local   # fill in the three values
npm install
npm run dev
npm test                     # checks the balance math
```

If you change `src/lib/ledger.js`, run `npm run sync-ledger` and redeploy `month-end`, so the server's reminder uses the same math.

## How it's built

- `src/`: React app (Vite). Screens: login/sign-up, Groups, Group (expenses and balances), Friends, Account.
- `public/sw.js`: service worker that shows push notifications.
- `supabase/migrations/0001_init.sql`: tables plus row-level security. People only see groups they're in, and expenses are checked on the server so shares always add up to the total.
- `supabase/functions/notify`: sends a push when someone adds an expense, records a payment, or sends or accepts an invite.
- `supabase/functions/month-end`: the monthly settle-up reminder.
