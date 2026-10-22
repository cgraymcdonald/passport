# wlg-bingo-app: S3 upload add-on for Conference Passport

Adds an "Upload Excel to S3" button to the existing Conference Passport PWA (GitHub Pages,
origin https://cgraymcdonald.github.io). One shared team password unlocks an encrypted IAM key
that can only `s3:PutObject` on `s3://wlg-bingo-app/uploads/*`. Account 741448930687, region eu-west-3.
The existing "Send to team" flow (SEND_URL) and Excel downloads are untouched.

## Files

| File | Role |
| --- | --- |
| `provision_bingo_uploader.sh` | One-time AWS side: versioning, CORS (origin defaults to cgraymcdonald.github.io), scoped policy, IAM user `bingo-app-uploader` |
| `build_webapp.py` | Encrypts the access key with the team password and writes `s3-upload.js` from `s3-upload.template.js` |
| `s3-upload.template.js` | The add-on (password dialog, SigV4 presign, PUT). Do not host this one |
| `remove_native_send.py` | Removes the page's own "Send Excel to WLG" flow (button, password field, note, code) and re-anchors the add-on button above the download buttons. All-or-nothing, writes `.bak` files |

## Deploy

```bash
cd ~/Documents/WGX/AWS_mgmt/wlg-bingo-app && conda activate aws && pip install cryptography

# 1. AWS side (profile admin, account 741448930687). Optional: ALLOWED_CIDRS="ip1/32,ip2/32"
./provision_bingo_uploader.sh

# 2. Create the key and build s3-upload.js in one step (the secret is never shown or saved)
aws iam create-access-key --user-name bingo-app-uploader --profile admin \
    --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text \
| python3 build_webapp.py --from-stdin --generate
#    -> save the generated team password in the password manager before pressing Enter

# 3. Remove the page's native send flow and re-anchor the add-on (index.html and s3-upload.js, same folder)
python3 remove_native_send.py index.html s3-upload.js

# 4. Commit to the Pages repo: index.html (patched) + s3-upload.js (generated). Nothing else.
```

Service worker: the page registers `sw.js`. Add `s3-upload.js` to its cached asset list and bump its cache
version, otherwise installed copies keep serving the old `index.html` without the button.

## How it works

1. `build_webapp.py`: PBKDF2-HMAC-SHA256 (600k iterations) -> AES-256-GCM over the access key; only ciphertext goes in `s3-upload.js`.
2. The first press of the button asks for the password once per session (auto-forget after 15 min idle); a wrong password fails GCM authentication.
3. The page exposes `window.passportExport()` (reusing `allSheets`, `xlsxBlob`, `fname`), so the uploaded workbook
   is identical to "Download Excel (everything)": sheets Bingo, Contacts, Meeting Notes, Notes (with Generated and Time zone).
4. The add-on signs a 5-minute SigV4 PUT URL (unsigned payload, host-only) and uploads straight to S3 from the browser.
5. Key layout: `uploads/YYYY-MM-DD/<attendee name>/<HHMMSS>_<uuid8>_WLG_Passport_<conference>_<name>.xlsx`.
   The name is the "Your name" field of the Passport header (self-declared). Each press creates a new snapshot object.
6. Online only: no queue, and the password is asked once per session (not remembered). Offline the button says so; the page's own offline save keeps working.
7. The page's previous native flow (config.js `S3_UPLOAD_ENC`, offline queue, remembered password, unsent-changes tracking) was removed on purpose. `window.S3_UPLOAD_ENC` in config.js is now unused and can be deleted.

## Rotation (an IAM user holds at most 2 keys)

```bash
aws iam list-access-keys --user-name bingo-app-uploader --profile admin
# create the new key + rebuild s3-upload.js as in step 2, commit, wait for Pages, then:
aws iam delete-access-key --user-name bingo-app-uploader --access-key-id <OLD_KEY_ID> --profile admin
```

Recommended cadence: every 180 days (same as the Cyberduck procedure).

## Known limits (accepted by design)

- The Pages repo is public if the repo is public: the ciphertext is readable by anyone, so the password is the only
  protection against offline brute force. Always use `--generate` (about 124 bits).
- Anyone with the password can write to `uploads/*` and add storage cost; no per-user attribution.
- Revocation = delete the access key (invalidates every copy of the page).
- No file size cap in S3 itself; the add-on only uploads the workbook it builds.

## Verified vs not verified

Verified: SigV4 against the official AWS docs vector and botocore (identical PUT URL for eu-west-3);
Python-encrypt / browser-decrypt round trip, wrong password and tampered blob rejected; patch script on the real anchors
(applies on the real current index.html, idempotent, aborts without writing on a mismatch); end-to-end in jsdom with real SheetJS: injected button, name and empty-card guards,
password dialog, signed PUT, uploaded workbook contains the four sheets, second upload reuses the session;
provisioning flow and generated IAM/CORS JSON against a stubbed `aws`.
Not verified: a real upload to the live bucket, a real browser, and the page's own `sw.js` (not seen).
After deploy: upload once, then `aws s3 ls s3://wlg-bingo-app/uploads/ --recursive --profile admin --region eu-west-3`.
