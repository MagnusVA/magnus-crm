# Measure Whop payment coverage

Run this once for one Whop account before deciding whether to build automatic wins or record later instalments. Use Node.js 24 or later. The script reads the CRM export from disk and makes only GET requests to Whop's payments endpoint.

## Prepare the inputs

1. Create a read-only Account API key for the business in Whop. Use `payment:basic:read` and `member:email:read`. Add `member:phone:read` if needed to see the checkout phone. Use the matching sandbox account and key with `--sandbox`.
2. Export the intended Convex deployment separately with `npx convex export --path <zip>`, then extract the archive outside the repository. Check the deployment before running the export. The script never calls Convex.
3. Check for `documents.jsonl` under `leads`, `leadIdentifiers`, `opportunities`, `paymentRecords`, `leadMergeHistory`, and `meetings`. If a required table was verified empty and omitted from the archive, add an empty file under its directory in the extract.
4. Use a single-tenant extract. A full multi-tenant export works when it includes a Whop connection that identifies the requested account and environment. Keep the export outside the repository since it contains customer data and may contain integration credentials.

## Run the measurement

Run from a private directory outside the repository. Set `CRM_REPO`, `CRM_EXPORT`, and `WHOP_ACCOUNT` to the absolute checkout path, absolute extracted folder path, and Whop account ID. In Bash or Zsh, load the read-only key into the environment without putting the value in the command history.

```sh
read -rs WHOP_API_KEY
export WHOP_API_KEY
node "$CRM_REPO/scripts/whop-measure.mjs" \
  --account "$WHOP_ACCOUNT" \
  --crm "$CRM_EXPORT" \
  --out "$PWD/whop-measurement.md" \
  --sample-out "$PWD/whop-measurement-sample.local.json"
unset WHOP_API_KEY
```

The default window is the last 90 complete UTC days. For a fixed window, add `--from YYYY-MM-DD --to YYYY-MM-DD`. The start date is inclusive and the end date is exclusive. For example, `--from 2026-08-01 --to 2026-11-01` covers August through October.

The command creates two new files and refuses to overwrite existing ones. Both default to the current directory. Keep `whop-measurement*.md` and `*.local.json` outside the repo. The command refuses to write either file inside a Git checkout unless you explicitly pass `--allow-repo-output`.

The sample contains personal data in the form of payment, person, and deal IDs. **Do not commit or share it.** Review the IDs against both systems by hand and keep the sample local. Review the aggregate report before sharing it.

## Read the results

- Check that the two scans agree and that Whop returned the requested account. Verify the gross collected total by currency against the same account and UTC window in Whop. The payments endpoint filters by creation time. A charge created before the window and collected during it can explain a dashboard difference. The separate refund and dispute filters count affected payments by event time.
- Check the email match rate and the five payer evidence buckets. A phone can flag a conflict and can surface a candidate for review. The check uses surviving people after CRM merges. Review the local sample for each hard case marked present. A window with fewer than 60 paid payments gives you every paid payment. Choose a longer window if you need a larger sample.
- Read historical deal counts alongside the snapshot fallback rate. The optional `domainEvents` export lets the script reconstruct stage transitions. Otherwise it uses available deal dates and the exported snapshot. The readiness count applies the product's rule at scan time, including the seven-day age limit. It uses `tenantPaymentConnections`, `paymentProviderBindings`, `providerPayments`, and `tenantPrograms` when present. A missing connection, mapping, or import cutoff cannot produce a ready payment.
- Use the known-person coverage rows to estimate payments outside Whop and Whop receipts missing from the CRM. The unresolved-person rows show the part the script cannot attribute. The amount comparison uses Whop's gross total as the percentage base. The product never links by amount or time.
- Read the ranked catalog and membership distributions as activity inside the window. The capacity estimate starts with stored rows and adds unallocated observed charges that have a candidate deal. Some manual records may already cover those charges. Unplaced payments can raise the maximum after review.
- Move CRM-made links ahead of automatic wins if fewer than 85% of paid payments identify one person by email. Move the shared payment summary ahead of later payment recording if the projected maximum reaches 40. Before rollout, assign someone in Billing to review the expected daily exceptions. Test whose email Whop supplies and verify webhook signatures separately in the sandbox.

## Replay synthetic pages

Use `--dry-run /private/path/fixtures.json` in place of a key. The CLI follows the same cursor and account checks. Supply a CRM folder with synthetic rows and use dates that include the fixture timestamps.

The fixture file is an object with four properties. Each is an array of Whop list responses, with one or more pages.

| Key | Pages |
| --- | --- |
| `first` | All statuses in the creation window, first scan |
| `second` | The same creation window, repeated scan |
| `refunds` | The refund-time filter |
| `disputes` | The dispute-opened-time filter |

An empty scan uses `[{"data":[],"page_info":{"has_next_page":false,"end_cursor":null}}]`. A nonfinal page sets `has_next_page` to true and supplies a distinct `end_cursor`. Include the requested `account_id` on every in-scope payment. Keep fixtures containing real payment data out of the checkout.
