# GBIG App – Setup Instructions

## 1. Add your Supabase Anon Key

Open `.env.local` and replace `YOUR_ANON_KEY_HERE` with your actual Supabase anon key.

Find it at: https://supabase.com/dashboard/project/mtuzmasicpcxcvtslevm/settings/api

The file should look like:
```
VITE_SUPABASE_URL=https://mtuzmasicpcxcvtslevm.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhb...your_real_key_here
```

## 2. Install dependencies

Open a terminal in the `gbig-app` folder and run:

```bash
npm install
```

## 3. Start the dev server

```bash
npm run dev
```

Then open http://localhost:5173 in your browser.

## 4. Enable Magic Link auth in Supabase

In the Supabase dashboard:
- Go to Authentication → Providers
- Make sure "Email" is enabled
- Under "Email" settings, enable "Magic Link" (OTP)

## Project Structure

```
gbig-app/
├── src/
│   ├── lib/
│   │   └── supabase.js          ← Supabase client
│   ├── pages/
│   │   ├── ReservationsPage.jsx ← Tab 1: Bookly iframe
│   │   ├── LeaguePage.jsx       ← Tab 2: Login → Dashboard
│   │   ├── EventsPage.jsx       ← Tab 3: Events from DB
│   │   └── NewsPage.jsx         ← Tab 4: News from DB
│   ├── components/
│   │   ├── LoginScreen.jsx      ← Magic link login
│   │   └── LeagueDashboard.jsx  ← Post-login home
│   ├── App.jsx                  ← App shell + tab bar
│   └── index.css                ← Global styles + CSS vars
├── .env.local                   ← Supabase credentials (don't commit!)
└── index.html
```
