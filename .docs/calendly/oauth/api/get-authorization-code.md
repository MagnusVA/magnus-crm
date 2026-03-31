# Get Authorization Code

`GET` `https://auth.calendly.com/oauth/authorize`

The **Authorization Code** is a temporary code that your client exchanges for an access token. While this flow is supported, we recommend using the PKCE flow for all OAuth applications.

## Web applications

To receive a user's Access Token, have your app redirect the user to Calendly's authorization page with the `client_id` and `redirect_uri` replaced with your application's `client_id` and `redirect_uri` (see example below). Note that this URL must be requested using a web browser.

```
https://auth.calendly.com/oauth/authorize?client_id=CLIENT_ID&response_type=code&redirect_uri=https://my.site.com/auth/calendly
```

When a user grants access, their browser is redirected to the specified `redirect_uri`. The Authorization Code is passed inside the `code` query parameter:

```
https://my.site.com/auth/calendly?code=f04281d639d8248435378b0365de7bd1f53bf452eda187d5f1e07ae7f04546d6
```

## PKCE Flow (recommended)

The flow for mobile or native applications requires PKCE conforming to the RFC 7636 specification. This flow is also recommended for web apps to mitigate against authorization code injection. For more information, see [this guide](https://oauth.net/2/pkce/). An example of a JavaScript implementation can be found [here](https://github.com/aaronpk/pkce-vanilla-js).

To receive an Authorization Code:

- Generate a `CODE_VERIFIER`
- Build a `CODE_CHALLENGE`
- Redirect the user to Calendly's authorization page with the `client_id`, `redirect_uri`, and `code_challenge` replaced with your application's `client_id`, `redirect_uri`, and the `code_challenge` generated in the step above (see example below). Note that this URL must be requested using a web browser.

```
https://auth.calendly.com/oauth/authorize?client_id=CLIENT_ID&response_type=code&redirect_uri=com.site.app://auth/calendly&code_challenge_method=S256&code_challenge=CODE_CHALLENGE
```

After the user grants access, they will be redirected back to your app with the Authorization Code:

```
com.site.app://auth/calendly?code=f04281d639d8248435378b0365de7bd1f53bf452eda187d5f1e07ae7f04546d6
```

## Request

### Query parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `client_id` | string | Yes | The ID provided by Calendly for the web application |
| `code_challenge` | string | Yes | Use a code challenge for native clients |
| `code_challenge_method` | string | Yes | The method used for native clients. **Examples:** `S256` |
| `redirect_uri` | string | Yes | The redirect URI for your OAuth application. **Examples:** `https://my.site.com/auth/calendly` |
| `response_type` | string | Yes | The response type (which is always `"code"`). **Allowed value:** `code` |

## Responses

### 200 OK

OK

Exchange the `code` from the redirect for tokens via [Get Access Token](./get-accesstoken.md).

### Example request (cURL)

**Web applications** (query string matches the documentation example):

```bash
curl -G 'https://auth.calendly.com/oauth/authorize' \
  --data-urlencode 'client_id=CLIENT_ID' \
  --data-urlencode 'response_type=code' \
  --data-urlencode 'redirect_uri=https://my.site.com/auth/calendly'
```

**PKCE** (query string matches the documentation example):

```bash
curl -G 'https://auth.calendly.com/oauth/authorize' \
  --data-urlencode 'client_id=CLIENT_ID' \
  --data-urlencode 'response_type=code' \
  --data-urlencode 'redirect_uri=com.site.app://auth/calendly' \
  --data-urlencode 'code_challenge_method=S256' \
  --data-urlencode 'code_challenge=CODE_CHALLENGE'
```
