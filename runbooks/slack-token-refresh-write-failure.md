# Runbook: Slack Token Refresh Write Failure

Severity: P1 - page on first occurrence.

Detector:

```text
[Slack:Tokens] CATASTROPHIC refresh-write-fail
```

## What Happened

Slack returned a fresh `(access_token, refresh_token)` tuple, then the CRM failed to persist it. Slack invalidates the old refresh token after issuing a new one, so the persisted token tuple can no longer refresh the installation. The affected tenant's Slack integration is offline until it reconnects.

## Immediate Response

1. Copy `tenantId`, `installationId`, and `teamId` from the log line.
2. Verify the installation row is marked `status: "token_expired"`:

   ```bash
   npx convex data slackInstallations | grep <installationId>
   ```

3. If the row is not already `token_expired`, patch it before asking the tenant to reconnect.
4. Ask a tenant admin to visit `/workspace/settings?tab=integrations` and reconnect Slack.
5. Confirm the row returns to `status: "active"` with a future `tokenExpiresAt`.

## Notes

- Expected blast radius is one tenant installation.
- Do not attempt to reuse the previous refresh token; Slack has already rotated it.
- Keep `completeRefresh` limited to one database patch and no side effects.
- Future mitigation from the design doc: a token quarantine table can allow manual replay of the new tuple if the write failure happens after Slack returns it.
