# Deferred Production Slack App Creation

## Current Rollout Decision

The production Slack app will **not** be created during the initial Phase 1 setup.
Build and verify the Slackbot v1 feature thoroughly against the dev Slack app,
dev Slack workspace, and dev Convex deployment first. Only after dev QA passes
end-to-end should the production Slack app be registered, configured, and wired
to the production Convex deployment.

This temporarily overrides any phase text that says to create or configure both
dev and prod Slack apps at the start. The dev app remains required for the
feature work; the prod app is deferred until the explicit production rollout
window.

During the dev-first period:

- Do create and configure the dev Slack app.
- Do not create the production Slack app.
- Do not paste a production Slack manifest into Slack App Config.
- Do not generate or store Slack-issued production app credentials, because they
  do not exist yet.
- Do not set production `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`,
  `SLACK_SIGNING_SECRET`, `SLACK_STATE_SIGNING_SECRET`, or `SLACK_REDIRECT_URI`
  for Slackbot until the production app exists.
- Do not complete the Slack privacy/support URL setup until the generic legal
  and support pages/routes exist.
- Do keep `token_rotation_enabled: true` in any committed prod manifest template
  or CI guard. The deferred decision is "no prod app yet", not "prod app with
  relaxed token rotation."
- Do keep Public Distribution off. It cannot be activated before the prod app
  exists, and it still remains the final launch action after prod QA.

When dev QA is complete, resume the prod path by creating the prod Slack app
with token rotation enabled, capturing its credentials, setting production
Convex env vars, deploying the production code, pasting the prod manifest, and
running the prod QA/go-live gates before activating Public Distribution.

## Phase-by-Phase Impact

### Phase 1 - OAuth Install & Token Rotation

- **1A Step 1: Decide Slack-app ownership**
  - Still decide ownership for both environments now if possible.
  - Only the dev app is registered immediately. Record that prod registration is
    intentionally deferred.

- **1A Step 2: Create the dev Slack app**
  - Proceed as written. Use the real dev Convex `.convex.site` OAuth redirect
    URL and keep `token_rotation_enabled: true`.

- **1A Step 3: Repeat Step 2 for prod**
  - Deferred. Do not create the prod Slack app yet.
  - Resume this exact step during the production rollout window. Use the real
    prod Convex callback URL and verify `token_rotation_enabled: true` before
    saving.

- **1A Step 4: Generate state-signing secrets**
  - Generate the dev `SLACK_STATE_SIGNING_SECRET` now.
  - Generate the prod `SLACK_STATE_SIGNING_SECRET` later, during prod app
    creation, so all prod Slack secrets are captured in one controlled pass.

- **1A Step 5: Read off Slack-issued secrets**
  - Capture only dev `Client ID`, `Client Secret`, and `Signing Secret` now.
  - Prod values are unavailable until the prod Slack app is created.

- **1A Step 6: Prepare branding assets**
  - Still prepare shared branding now. It will be reused for prod later.
  - Do not upload assets to a prod app until that app is created.

- **1A Step 7: Set privacy + support URLs**
  - Deferred. Do not complete this step until the generic privacy/legal and
    support URLs exist.
  - This applies to both dev and prod. If Slack allows the dev app to be created
    and tested without these URLs, continue dev testing and leave this item open.
  - Resume this step before any production app setup, Marketplace/App Directory
    work, or Public Distribution activation.

- **1A Step 8: Document the registered apps**
  - Document the dev app immediately.
  - Add a prod placeholder entry that says: "Production Slack app not created
    yet; deferred until dev QA passes."

- **1H Step 1: Commit the manifest YAMLs to source control**
  - The dev manifest is active source-of-truth now.
  - The prod manifest may be committed as a template and CI-protected, but it
    must not be pasted anywhere until the prod Slack app exists.

- **1H Step 2: Set Convex env vars on the dev deployment**
  - Proceed as written for dev.

- **1H Step 3: Verify dev Convex routes are live**
  - Proceed as written for dev.

- **1H Step 4: Substitute and paste the dev manifest**
  - Proceed as written for dev.

- **1H Step 5: Install the dev app to your testing workspace**
  - Proceed as written for dev.

- **1H Step 6: End-to-end dev validation**
  - Proceed as written for dev. This is the main gate before any prod Slack app
    work resumes.

- **1H Step 7: Set Convex env vars on the prod deployment**
  - Deferred. There is no prod Slack app, so the prod Slack credentials do not
    exist.
  - Resume after prod app creation and before pasting the prod manifest.

- **1H Step 8: Deploy the Phase 1 code to prod**
  - Deferred if the whole production rollout is deferred.
  - If code is deployed to prod before the prod Slack app exists, do not expose
    a "Connect Slack" prod path and do not expect Slack env vars to be present.

- **1H Step 9: Substitute and paste the prod manifest - irreversible gate**
  - Deferred. This cannot happen without a prod Slack app.
  - Resume only after prod Convex routes are deployed, prod Slack env vars are
    set, and `curl` smoke tests pass.

- **1H Step 10: Set up alerting on the catastrophic log signature**
  - Can be drafted during dev, but production paging should be finalized before
    the prod app is installed by any tenant.

- **1H Step 11: Confirm Public Distribution is still disabled**
  - Not applicable until the prod app exists.
  - When the prod app is created, explicitly verify Public Distribution is off.

- **1I Step 1: Add the CI lint workflow**
  - Still useful now if `slack-manifest.prod.yaml` is committed as a template.
  - If the prod manifest file is not committed yet, add this guard in the same
    PR that introduces it.

- **1I Step 3: Verify the lint rule fires**
  - If no prod manifest file exists yet, defer this verification.
  - If the prod manifest template exists, run the verification now.

### Phase 2 - Slash Command Modal

- **Phase 2 prerequisite: manifest published in 1H**
  - Interpret as "dev manifest published" during the dev-first period.
  - No prod Slack app or prod manifest publication is required for Phase 2 dev
    work.

- **2B Step 4: Verify manifest URLs**
  - Run against the dev Convex host only.
  - Prod URL checks are deferred until the prod app and prod manifest exist.

- **2C Step 4: Smoke-test against the live Slack workspace**
  - Use the dev Slack workspace and dev Slack app only.

- **2D Step 3: Verify interactivity**
  - Use the dev Slack workspace and dev Slack app only.

- **2E: End-to-End Verification**
  - Run entirely in dev.
  - Any "better than production" latency or signature confidence still needs to
    be rechecked later in prod before Public Distribution.

### Phase 3 - Lead, Opportunity & Slack-User Directory

- **3A Step 1: Invoke `convex-migration-helper`**
  - Still required. This phase widens existing production tables even though the
    prod Slack app is deferred.

- **3A Step 8: Pre-prod manual checks**
  - Run in dev before any production database deploy.

- **3A Step 9: Promote to prod**
  - Deferred if the production rollout is deferred.
  - This step is about production Convex schema/data safety, not Slack app
    creation. When production rollout resumes, run it before any prod Slack app
    install can create Slack-sourced rows.

- **3D/3E/3F verification steps**
  - Use dev data, dev Slack installation rows, and dev Slack requests.
  - Do not expect prod Slack installation rows to exist.

- **3G Step 2: End-to-end verification**
  - Run in the dev Slack workspace first.
  - The "verify in dev before deploying to prod" note remains mandatory; prod
    verification waits until the prod Slack app exists.

### Phase 4 - Calendly to Slack Join

- **4B Step 8: Verify**
  - Use dev Convex, dev Slack-qualified opportunities, and Calendly sandbox/test
    bookings.

- **4C: End-to-End Test Gates**
  - Run all scenarios in dev first.

- **4C Promotion to prod note**
  - Deferred. Do not run prod Slack/Calendly QA until the prod Slack app exists,
    prod Convex is deployed, and a real prod installation has been completed.
  - Before Public Distribution, re-run these Phase 4 scenarios in prod as the
    phase already requires.

### Phase 5 - Integrations UI, Channel Config, Notifications, Stale Digest

- **Phase 5 prerequisite: manifest scopes granted in 1H**
  - During dev-first work, this means the dev app has granted
    `chat:write`, `chat:write.public`, `channels:read`, `groups:read`, and
    `users:read`.
  - Prod scope grants wait until prod app install.

- **5A Step 5: Verify channel listing/config mutations**
  - Use the dev tenant and dev Slack app only.

- **5B Step 5: Verify confirmation messages**
  - Use dev channel configuration and dev Slack messages.

- **5C Step 5: Verify stale digest**
  - Use dev tenant data and dev Slack channels.

- **5D Step 5: Verify Integrations card**
  - The card can be built and tested in dev.
  - If code reaches prod before the prod Slack app exists, make sure the prod UI
    does not invite users into a broken Slack OAuth path.

- **5E Step 3: Verify channel picker**
  - Use the dev app installation only.

- **5F: End-to-End Onboarding QA + Copy Review**
  - Run the full onboarding QA in dev first.
  - The copy review still blocks production ship. Do not treat dev-only QA as
    permission to launch prod.

### Phase 6 - Lifecycle, Metrics, Dogfood, and Go-Live

- **6A Step 4: Verify Events API lifecycle handling**
  - Re-paste the dev manifest to exercise dev URL verification during dev QA.
  - Prod URL verification is deferred until the prod app exists and the prod
    manifest is pasted.

- **6B Step 3: Verify reactivate flow**
  - Use the dev Slack app uninstall/reconnect cycle first.
  - Repeat in prod later after the prod app exists.

- **6C Step 5: Invoke `convex-performance-audit`**
  - Can be run after dev data exists, but production launch still needs a final
    audit/acceptance pass before Public Distribution if production usage volume
    assumptions changed.

- **6D Step 5: Verify metrics cards**
  - Verify with dev-created Slack-qualified rows first.
  - Prod cards cannot show real Slack conversion data until the prod app has an
    installation and prod test submissions.

- **6E Step 1: Set up log alerting**
  - Draft and test from dev now.
  - Production paging must be finalized before prod tenant dogfood starts.

- **6E Step 3: Dogfood with one real tenant**
  - Deferred until the prod Slack app exists.
  - This step requires a real prod Slack install, not only dev QA.

- **6E Step 4: Address dogfood findings**
  - Deferred until prod dogfood has produced findings.

- **6E Step 5: Final go-live checklist**
  - This is where the deferred prod app work is resumed and completed.
  - Complete the production versions of Phase 1 1A and 1H before checking this
    off: prod app creation, prod secrets, prod Convex env vars, prod manifest
    paste, prod route smoke tests, and prod QA.

- **6E Step 6: Post-launch monitoring**
  - Deferred until after Public Distribution is activated.

## Production Resume Checklist

Use this when dev QA is complete and the team is ready to create the production
Slack app:

1. Create the prod Slack app from the bootstrap manifest with
   `token_rotation_enabled: true`.
2. Store prod `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`,
   and a freshly generated prod `SLACK_STATE_SIGNING_SECRET`.
3. Set production Convex Slack env vars, including `SLACK_REDIRECT_URI` matching
   the prod manifest exactly.
4. Deploy the production Convex code and smoke-test all Slack-facing prod URLs.
5. Paste the prod manifest and verify `token_rotation_enabled: true` in the
   rendered preview before saving.
6. Confirm Public Distribution is still disabled.
7. Complete prod QA from Phases 4C, 5F, and 6E.
8. Dogfood with one real tenant.
9. Activate Public Distribution only after the final go-live checklist passes.
