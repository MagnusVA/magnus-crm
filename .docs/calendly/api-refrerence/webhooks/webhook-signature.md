# Webhook Signatures

Gain confidence in the authenticity of your webhooks when you use a **webhook signing key**, a unique secret key shared between your application and Calendly, to verify the events sent to your endpoints. The webhook signing key will produce the `Calendly-Webhook-Signature`, which you can use to compare against an expected webhook signature, to verify events from Calendly.

## Webhook signing keys for personal access tokens

When you authenticate with personal access tokens, you have the option to set a webhook signing key when you create the webhook subscription. You can use the same signing key for all webhooks or use a unique signing key for each webhook. Neither are required, but greatly enhance the security of the data you receive at your endpoint.

Using the same signing key for all webhooks lets you quickly verify the source of the events sent to your endpoints, but using a unique signing key for every webhook enhances the security of each one when working with multiple integrations.

## Webhook signing keys for OAuth 2.0

When you create an OAuth 2.0 app, a webhook signing key will automatically be generated for all webhooks related to your application. The webhook signing key is a unique secret key shared between your application and Calendly.

### Retrieve your webhook signing key

If you didn't receive a webhook signing key for an OAuth 2.0 application you've previously created or need to retrieve one because you lost it, then contact [support+developer@calendly.com](mailto:support+developer@calendly.com).

## Verifying Signatures

When Calendly sends your app a webhook, it will include the `Calendly-Webhook-Signature` header in the following format:

```
Calendly-Webhook-Signature: t=1492774577,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
```

Compare the `Calendly-Webhook-Signature`, prefixed by `v1=`, to the expected signature. If they match, then you can trust that the event payload was issued by Calendly and has not been tampered with.

### Prevent Replay Attacks

So you can mitigate replay attacks, Calendly utilizes a timestamp in the `Calendly-Webhook-Signature` header, prefixed by `t=`, that you can use to reject the webhook if the timestamp in the signature header is too old based on the tolerance zone.

In the example below, the tolerance zone is set to 3 minutes, so any webhooks received that are older than 3 minutes will be rejected. See the examples of webhook signature verification code in different languages below.

```ruby
require 'OpenSSL'

# Your application's webhook signing key
webhook_signing_key = ENV['WEBHOOK_SIGNING_KEY']

# Extract the timestamp and signature from the header
calendly_signature = request.headers['Calendly-Webhook-Signature']
signature_hash = Hash[*calendly_signature.split(/[\,,\=]/)]

t = signature_hash['t'] # UNIX timestamp
signature = signature_hash['v1']

raise 'Invalid Signature' if t.nil? || signature.nil?

# Create the signed payload by concatenating the timestamp (t), the character '.', and the request body's JSON payload.
signed_payload = t + '.' + request.body.read

digest = OpenSSL::Digest::SHA256.new
hmac = OpenSSL::HMAC.new(webhook_signing_key, digest)

# Determine the expected signature by computing an HMAC with the SHA256 hash function.
expected_signature = (hmac << signed_payload).to_s

if expected_signature != signature
  # Signature is invalid!
  raise 'Invalid Signature'
end

### Prevent replay attacks ###

# If an attacker intercepts the webhook's payload and signature they could potentially re-transmit the request. This is known as a replay attack. This type of attack can be mitigated by utilizing the timestamp in the Calendly-Webhook-Signature header. In the example below we set the application's tolerance zone to 3 minutes. This helps mitigate replay attacks by ensuring that requests that have timestamps older than 3 minutes ago will not be considered valid.

three_minutes = 180
tolerance = three_minutes

if Time.at(t.to_i) < Time.now - tolerance
  # Signature is invalid!
  # The signature's timestamp is outside of the tolerance zone defined above.
  raise "Invalid Signature. The signature's timestamp is outside of the tolerance zone."
end
```
