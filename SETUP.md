# Macro Tracker – setup

Everything here is free. Plan on about 30 minutes, once.
In the steps below, `USERNAME` is your *other* GitHub account's username, and `macro-tracker` is the repository name. If you choose a different name, use it everywhere.

---

## 1. Put the app on GitHub Pages (≈10 min)

1. Open a **private/incognito browser window** (so you don't use the GitHub account this laptop is signed in to), go to github.com and sign in with your other account.
2. Click **+ → New repository**. Name: `macro-tracker`. Visibility: **Public**. Click **Create repository**.
3. On the new repository page, click **uploading an existing file**. Drag in **every file in this folder** (`index.html`, `app.js`, `styles.css`, `config.js`, `sw.js`, `manifest.webmanifest`, the three `.png` icons and this `SETUP.md`). Click **Commit changes**.
4. Go to **Settings → Pages**. Under *Build and deployment*, set Source to **Deploy from a branch**, Branch to **main** and folder **/ (root)**, then **Save**.
5. After a minute or two, the app is live at **`https://USERNAME.github.io/macro-tracker/`**.

The app already works at this point: logging, barcode lookups, USDA search, weight and targets. Google sync and label photos need steps 2 and 3.

## 2. Turn on Google Sheet sync (≈15 min)

1. Go to **console.cloud.google.com** and sign in with the Google account you'll use for your data.
2. Create a new project (top bar → project picker → **New project**), e.g. "Macro Tracker".
3. **APIs & Services → Library**: search for and **Enable** both **Google Sheets API** and **Google Drive API**.
4. **Google Auth Platform** (also shown as *OAuth consent screen*) → **Get started**:
   - App name "Macro Tracker", your email as support and contact email, Audience **External**.
   - **Audience** page: leave it in **Testing** and add **test users**: your Gmail address and your friend's.
   - **Data access** page: **Add or remove scopes** → add `.../auth/drive.file` (*See, edit, create and delete only the specific Google Drive files you use with this app*). Save.
5. **Clients → Create client** → Application type **Web application**:
   - **Authorized JavaScript origins:** `https://USERNAME.github.io`
   - **Authorized redirect URIs:** `https://USERNAME.github.io/macro-tracker/` (the trailing `/` matters)
   - Click **Create** and copy the **Client ID** (ends in `.apps.googleusercontent.com`).
6. Open `config.js`, paste the Client ID between the quotes after `GOOGLE_CLIENT_ID:`, save, and upload `config.js` to the repository again (**Add file → Upload files**, then **Commit**).

The Client ID is not a secret; it is fine in a public repository.

When you first connect, Google shows **"Google hasn't verified this app"**. That's expected for your own unpublished app: click **Continue**.

## 3. Get a Gemini key for label photos (≈2 min, each person)

1. Go to **aistudio.google.com/apikey** and click **Create API key**.
2. In the app: **Settings → Label reading → Gemini API key**, paste it, then **Save keys**.

The key is stored only on that device, so add it on your phone and laptop separately. Note: on Gemini's free tier, Google may use what you send (your label photos) to improve its products.

## 4. Put it on your iPhone

1. Open `https://USERNAME.github.io/macro-tracker/` in **Safari**.
2. Tap **Share → Add to Home Screen → Add**.
3. Always open the app from that icon. Apps added to the Home Screen aren't subject to Safari's automatic clearing of website data.
4. In the app: **Settings → Connect Google**, and paste your Gemini key.

On the laptop, open the same address and **Connect Google** with the same account. Both devices then sync through the same sheet.

## 5. Your friend

- Add their Gmail as a **test user** (step 2.4) if you haven't already.
- Send them the link. They do steps 3 and 4 with their own Google account and Gemini key. Their data goes to their own Drive, separate from yours.
- To share your saved foods: **Settings → Export saved foods**, send them the file, and they use **Import a file**.

## Updating the app later

Upload the changed files to the repository again. The app picks up the new version the next time it's opened with an internet connection.

## Troubleshooting

| Problem | Fix |
|---|---|
| `redirect_uri_mismatch` when connecting Google | The redirect URI in step 2.5 must exactly match the app's address, including `https://` and the trailing `/`. |
| `access_denied` / "app is in testing" | Add that Google account as a test user (step 2.4). |
| "Reconnect Google" appears | Normal: Google's sign-in from a browser lasts about an hour. Tap it. Anything logged in the meantime is saved on the phone and syncs afterward. |
| Gemini says the model is not found | Google renamed or retired the model. Enter a current model name (listed at ai.google.dev) in Settings → Model. |
| USDA search says "rate limit" | Get a free key at fdc.nal.usda.gov/api-key-signup and add it in Settings. |
| Camera doesn't open for barcode scanning | Allow camera access for the site in iPhone Settings → Safari → Camera, or use "Take a photo of the barcode instead". |

## How the app counts days

- A new day starts at **3 am**, so a 1 am snack counts toward the previous day.
- Weigh-ins from **3 am to 3 pm** are *morning*, and from **3 pm to 3 am** are *night*.
- The weight trend uses morning weights only.
