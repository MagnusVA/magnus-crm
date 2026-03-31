# Creating an OAuth app

Follow the procedure below to register and authenticate your public application with the Calendly API v2.

## Register your OAuth application

- Sign up for a Calendly developer account using your GitHub or Google account by clicking the Sign Up button found in the top right corner of this page. *Note: This is not your Calendly user account and is not associated with your Calendly user account.*
- Create a new OAuth application
  - Provide name of your application
  - Select the kind of application (web or native)
  - Select your environment that you want to associate your application
    - Sandbox
    - Production
    - *We recommend starting with Sandbox for development and creating a second application for Production when ready to go live with customer data.*
  - Redirect URI:
    - For the Sandbox environment, we allow HTTP with localhost domain. Example: [http://localhost:1234](http://localhost:1234/)
    - For the Production environment, this must be HTTPS
  - Select scopes based on the Calendly data and functionality that your OAuth app requires access to. Learn more about [scopes](https://developer.calendly.com/scopes).
- For all OAuth applications (web or native) use a specific `redirect_uri`, a Proof Key for Code Exchange (PKCE), and S256 for `code_challenge_method`. For more information about PKCE, see [this guide](https://oauth.net/2/pkce/).
- Proceed into the next step to view/copy your Client Id, Client Secret and Webhook signing key. **Be sure to copy these values as you will not be able to access the Client Secret or Webhook signing key again**.

## Test your application

While we will not enforce PKCE for web applications, we recommend using PKCE conforming to the RFC 7636 specification for both web and native applications. For more information, see [this guide](https://oauth.net/2/pkce/). An example of a javascript implementation can be found [here](https://github.com/aaronpk/pkce-vanilla-js).

To receive an Authorization Code:

- Generate a `CODE_VERIFIER`
- Build a `CODE_CHALLENGE`
- Redirect the user to Calendly's authorization page with the `client_id`, `redirect_uri`, and `code_challenge` replaced with your application's `client_id`, `redirect_uri`, and the `code_challenge` generated in the step above (see example below). Note that this url must be requested using a web browser.

```http
https://auth.calendly.com/oauth/authorize?client_id=CLIENT_ID
&response_type=code
&redirect_uri=com.site.app://auth/calendly
&code_challenge_method=S256
&code_challenge=CODE_CHALLENGE
```

After the user grants access, they will be redirected back to your app with the Authorization Code:

```http
com.site.app://auth/calendly?
code=f04281d639d8248435378b0365de7bd1f53bf452eda187d5f1e07ae7f04546d6
```

To receive an access token:

- [Send a POST request](https://developer.calendly.com/api-docs/be9b32ef4b44c-get-access-token#request-body) to [https://auth.calendly.com](https://auth.calendly.com) with the `grant_type`, `code`, and `redirect_uri`

## Edit your application

To edit attributes for existing OAuth applications:

- Click on the OAuth application's menu icon then select "Edit".
- The following attributes can be edited:
  - Name of app
  - Kind of app
  - Environment type
  - Redirect URI
- Click "Save".

Please note you will not be able to access the Client Secret or Webhook signing key when editing an OAuth application (these values are only displayed when the OAuth application is created).

## See more

Learn what else you can [accomplish with the Calendly API](https://developer.calendly.com/api-use-cases).

For more information about conditions that result in an access token being revoked, please see our [Frequently Asked Questions](https://developer.calendly.com/frequently-asked-questions).
