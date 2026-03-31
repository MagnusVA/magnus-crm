# Webhook Errors

When a webhook begins to return error responses (HTTP status codes 3xx, 4xx, or 5xx), Calendly will continue attempting to deliver the message for up to 24 hours. During this period, an exponential back-off strategy is used, meaning delivery attempts become less frequent over time, or until 24 hours after the associated event was booked—whichever comes first.

If no successful delivery occurs within 24 hours, the webhook will be disabled, and you will need to recreate it. These failures typically occur when Calendly tries to send data to your server but your server is unavailable or encounters an error. Importantly, if one message (such as event details) fails to be delivered, Calendly will still attempt to send other messages to your endpoint during this period.