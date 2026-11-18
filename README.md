# Log de ideias

A personal dashboard for logging and prioritizing ideas (science experiments, apps, software, games, other).
It runs entirely in the browser on GitHub Pages: no backend, no build step, no third-party scripts.

## How it works

- `index.html` is the whole app (HTML, CSS and vanilla JS).
- `ideias.enc` holds the ideas, encrypted with your password.
- `cofre.enc` ("vault") holds a GitHub fine-grained token, encrypted with the same password.
- Both files are created by the site itself during the initial setup. They are never written by hand.

Encryption uses WebCrypto only: PBKDF2-SHA256 (600,000 iterations, random 16-byte salt per file)
and AES-GCM 256 (new random 12-byte IV on every write). File format:

```json
{"v":1,"kdf":"PBKDF2-SHA256","iter":600000,"salt":"<base64>","iv":"<base64>","ct":"<base64>"}
```

On open, the site fetches `cofre.enc` from Pages, asks for the password, decrypts the token, and then
reads `ideias.enc` through the GitHub contents API (so it never sees a stale Pages copy). Every change is
written back with `PUT /repos/{owner}/{repo}/contents/ideias.enc` as a commit named `Update ideas`.
If the file changed elsewhere in the meantime, the site reloads it and tells you, instead of overwriting.

**What you accept by using this:** the encrypted files are public, the password is the only barrier,
and the commit history keeps every older encrypted version. Pick a long passphrase.

## Initial setup

1. Enable GitHub Pages for this repository (branch `main`, folder `/`).
2. Create a fine-grained personal access token at
   <https://github.com/settings/personal-access-tokens/new>:
   - **Repository access:** "Only select repositories", and pick only this repository.
   - **Repository permissions:** "Contents" set to "Read and write".
   - Nothing else.
   - **Expiration:** GitHub lets you pick from 1 to 366 days, or no expiration on a personal account.
     The token is revoked automatically when it expires, and GitHub does not document any reminder
     email, so note the date. A token unused for a year is also revoked automatically.
3. Open the Pages URL. Since `cofre.enc` does not exist yet, the setup screen appears.
   Paste the token, choose a password (at least 8 characters; a phrase of 5 or more words is
   recommended) and confirm. The site validates the token, then writes `ideias.enc` and `cofre.enc`.
4. Pages takes a few minutes to publish `cofre.enc`. Until then, reloading may show the setup screen
   again; the site will refuse to overwrite an existing setup.

From then on, on any device, the password alone opens the dashboard.

## Changing the token

When the token expires or loses access, the ideas already loaded stay visible and a banner offers
**Trocar token**. You can also open it from the ⚙ settings menu. Create a new token as in step 2 and
paste it there; the site re-encrypts `cofre.enc` with your current password.

If the token is already invalid when you log in, the ideas are still read (the repository is public)
and the same banner appears.

## Changing the password

⚙ settings → **Trocar senha**. Both files are re-encrypted with new salts. Other devices will ask for
the new password. Older commits remain decryptable with the old password.

## Importing ideas

⚙ settings → **Importar ideias** reads a local JSON file (`{"ideas": [...]}` or a plain list, same
fields as the data model; only `title` is required). Ideas whose title already exists are skipped.
The file is read only in the browser and saved encrypted in a single `Update ideas` commit.
Keep import files out of this repository and delete them afterwards.

## "Lembrar neste dispositivo"

Optional, off by default. It stores the derived AES keys as non-extractable `CryptoKey` objects in
IndexedDB (never the password). **Bloquear** deletes them.

## Recovering from a half-finished setup

If `ideias.enc` exists but `cofre.enc` does not, the setup screen refuses to continue so no data is
overwritten. Either restore `cofre.enc` from the commit history, or delete `ideias.enc` from the
repository yourself if you are sure you want to start over.

## Score

The "O que faz sentido agora?" panel sets `horizon` (weeks: 0.5, 4, 12, 26), `budget` (0–3) and
`wNov` (1, 2, 4). For each idea:

```
base  = (wNov * novelty + 2 * excitement) / (wNov + 2) / 5
tfit  = effortWeeks <= horizon ? 1 : max(0.25, horizon / effortWeeks)
over  = cost - budget
rfit  = over <= 0 ? 1 : (over == 1 ? 0.6 : 0.3)
score = round(100 * base * tfit * rfit)
```

The panel choice is stored per device in `localStorage`.

## Tests

`tests/run-tests.js` checks the crypto (round trip, wrong password, tampering, accents) and the score
formula against fixed cases, using the code inside `index.html` and fictitious data only:

```
node tests/run-tests.js
```
