# How to handle single-use refresh tokens

Calendly is updating its **OAuth 2.1** implementation to better protect against token replay and abuse. The main change is in how **refresh tokens** behave when you call **`POST /oauth/token`**.

This guide explains what's changing and shows the **correct way to implement refresh token rotation** so your integration keeps working smoothly.

---

## What's Changing

Previously, a refresh token could be successfully reused multiple times, and was only revoked indirectly after an access token created from it was used.

Going forward, Calendly will use **single-use refresh tokens with rotation**, aligned with OAuth 2.1 best practices:

- A **refresh token is revoked immediately after a successful** `POST /oauth/token` call.
- Each successful response from `POST /oauth/token` will still return:
  - a new **access token**, and
  - a new **refresh token**.
- **Access token behavior** (lifetime, scopes, etc.) does **not** change.

If your integration tries to **reuse a refresh token that has already been used**, the request will fail after this change.

---

## How Your Integration Should Handle Refresh Tokens

Calendly recommends that your OAuth client:

- Treats **refresh tokens as single-use**.
- **Immediately overwrites** the stored refresh token with the new `refresh_token` from every successful `POST /oauth/token` response.
- Does **not keep or reuse** older refresh token values.

In practice, your logic should be:

1. Call `POST /oauth/token` with the current authorization code or refresh token.
2. On success, **update your storage** with the **new** `access_token` and `refresh_token` from the response.
3. Only ever use the **most recently stored** refresh token for future refreshes.

If you already overwrite the stored refresh token on each successful refresh today, you should not need to change your integration.

---

## Example: Correct Refresh Token Rotation

Here's a simplified pattern you can adapt to your code.

### Handling a Token Response

```javascript
async function handleTokenResponse(userId, tokenResponse) {
  await db.updateUserTokens({
    userId,
    accessToken: tokenResponse.access_token,
    // Always remove the old refresh token
    refreshToken: tokenResponse.refresh_token,
    accessTokenExpiresAt: new Date(
      Date.now() + tokenResponse.expires_in * 1000,
    ),
  });
}
```

### Refreshing an Access Token Safely

```javascript
async function refreshAccessToken(userId) {
  const tokens = await db.getUserTokens(userId);

  if (!tokens || !tokens.refreshToken) {
    return null;
  }

  const response = await fetch('/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: CLIENT_ID,
    }),
  });

  if (response.status === 200) {
    const json = await response.json();
    await handleTokenResponse(userId, json);
    // now includes NEW refresh token
    return db.getUserTokens(userId);
  }

  if (response.status === 400 || response.status === 401) {
    // Refresh token is invalid, expired, or already used.
    await db.clearUserTokens(userId);
    // If the refresh token is already invalid, reauthorize
    // the user to Calendly
    await promptUserToReconnectCalendly(userId);
    return null;
  }
}
```

This approach ensures:

- Each refresh token is **used once** and rotated away.
- On refresh failure (e.g., 400/401), you **clear tokens** and ask the user to **re-authorize** instead of retrying endlessly.
- Refresh tokens are handled **only on the server side**, in secure storage.

---

## Next Steps, Timeline, and Support

The deadline for updating your refresh token behavior is August 31, 2026. Before then, we recommend:

- Reviewing your token storage and rotation logic.
- Confirming you **overwrite** refresh tokens on each successful refresh.
- Verifying that your error handling cleanly falls back to a **new authorization** when a refresh fails.

If you have questions or need help updating your integration, please contact [Calendly developer support](https://developer.calendly.com/get-help).

## FAQs

**Q: What changed with Calendly's OAuth refresh tokens?**

**A:** Calendly is updating its OAuth implementation to use **single-use refresh tokens with rotation**, per OAuth 2.1 guidelines. Previously, a refresh token could be reused multiple times to get new access tokens. Going forward, **each refresh token can only be used once,** when you use it to refresh, that refresh token becomes invalid and you'll get a new refresh token in the response. This means your integration needs to update the stored refresh token every time you refresh the access token. The access tokens themselves and their lifespans haven't changed, but refresh tokens now rotate on each use for improved security.

**Q: Why is Calendly making this change?**

**A:** This change is to **improve security and align with OAuth 2.1 best practices**. Single-use (rotating) refresh tokens help protect against **token replay attacks** and abuse. OAuth 2.1 formalizes an approach to make integrations more secure. In short, it's a proactive upgrade to keep your data safe and adhere to the latest standards.

**Q: What do I need to update in my integration?**

**A:** You need to ensure your OAuth client code **handles refresh tokens as single-use and implements refresh token rotation**. In practice, this means: after calling `POST /oauth/token` (to either get initial tokens or refresh them), **take the new refresh_token returned in the response and save it (replace the old one)**. Do **not** reuse the old refresh token again. Always use the latest refresh token that was issued. Most OAuth libraries that handle refresh tokens already have support for this, double-check your library's docs. If you implemented the flow manually, you may need to add logic to update the stored token. Also, make sure your error handling is ready: if you do accidentally use an outdated refresh token, the API will return an invalid_grant error, and your integration should catch that and prompt the user to re-connect their Calendly account (obtaining a new authorization code).

**Q: Will my existing refresh tokens stop working? Do users need to re-authenticate right now?**

**A:** There's no immediate hard cut-off that invalidates all refresh tokens, but behavior is changing once the feature rolls out. **Existing refresh tokens will still work, but only for one use each once rotation is enforced.** This means as soon as you use a refresh token under the new system, that particular token won't work again. Your integration should seamlessly handle this by using the new refresh token that comes back. End-users do *not* have to re-authenticate immediately *if* your integration is updated to handle rotation. They might have to re-auth later if a refresh token gets invalidated and your code wasn't updated (in which case your app would likely ask them to log in again). To avoid forcing re-auth, implement the rotation logic now so the transition is smooth. Calendly will notify developers of the timeline; we suggest updating your code before the hard enforcement date to ensure continuity.

**Q: How will I know if I've implemented refresh token rotation correctly?**

**A:** A good test is to go through a token refresh cycle twice in a row and see if the second attempt succeeds. For example, simulate your token refresh process: use refresh token R1 to get a new token (response gives you new refresh token R2). Then try to use R1 again (which should fail if rotation is working), and use R2 to get another token (which should succeed and yield R3). In a properly implemented integration, you would never actually try R1 again because you'd have replaced it with R2 internally. But this thought experiment illustrates what should happen: **any attempt to reuse a refresh token that's already been used will be rejected by Calendly**. If your integration always uses the latest refresh token and that flow works continuously, you've done it right.

**Q: What error will I get if I don't update my code?**

**A:** If your code reuses an old refresh token, the Calendly API will respond to the refresh request with an **error**. Specifically, you'll get HTTP 400 (Bad Request) or 401, and the JSON error will be "invalid_grant" (with a description like "authorization grant is invalid, expired, or revoked"). This is the same error used for an expired or truly invalid token, but in this case it means the token was already used and is now revoked. If you see this error when refreshing, it's a strong indicator that your code attempted to use a refresh token more than once. The solution is to obtain a new authorization (if you've lost the latest token) and implement the rotation logic going forward.

**Q: Is there a deadline for making these changes?**

**A:** Calendly is rolling out the refresh token rotation in early 2026 and will enforce it for all integrations by mid-2026. We haven't publicly announced an exact cut-off date in this FAQ answer, but **expect that by summer 2026 all apps must adhere to the new behavior**. Calendly will send out communications (emails, developer portal announcements) with the specific timeline. It's highly recommended to update your integration **now** rather than waiting. If you don't update, your integration will start failing to refresh tokens once the enforcement is in place. In short: there is a firm deadline (approximately six months from announcement) after which non-rotating integrations will no longer function correctly.

**Q: My app was working fine, why fix it if it isn't broken?**

**A:** While your integration might appear fine today, the change is about to be in effect or already active for new apps. If your app is older, Calendly provided a grace period, but that will end. Think of this like depreciation of an old API method, it might still work for now, but it's officially deprecated and will be removed. If you don't "fix it," it *will* break in the near future. Moreover, even during the grace period, adopting the new logic is beneficial for security. It's not just about compliance; it ensures your integration is following the recommended security practices, which protects you and your users. Making the update now prevents future emergencies when the old behavior is turned off.
