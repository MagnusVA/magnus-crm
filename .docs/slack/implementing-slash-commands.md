# Implementing slash commands

Slash commands allow users to invoke your app by typing a string into the message composer box. By enabling slash commands, your app can be summoned by users from any conversation in Slack. Slash commands created by developers cannot, however, be invoked in message threads.

A submitted slash command will cause a payload of data to be sent from Slack to the associated app. The app can then respond in whatever way it wants using the context provided by that payload.

When part of an app, they can be installed for your workspace as a [single workspace app](/app-management/distribution) or [distributed to other workspaces](/app-management/distribution) via the [Slack Marketplace](/slack-marketplace/distributing-your-app-in-the-slack-marketplace).

Built-in slash commands

There is a set of [built-in slash commands](https://slack.com/help/articles/360057554553-Use-shortcuts-to-take-actions-in-Slack#built-in-shortcuts). These include slash commands such as `/topic` and `/remind`.

Built-in slash commands are unique commands with unique additional features. They, along with [Giphy app](https://slack.com/help/articles/204714258-Giphy-for-Slack) slash commands, are the only slash commands that can be invoked in message threads.

## Understanding the structure of slash commands {#command_structure}

Slash commands require a particular invocation structure that makes them less universally usable compared to [other app entry points](/surfaces/app-design). Ensure you [understand your app's audience](/surfaces/app-design) before implementation.

Let's look at an example slash command for an app that stores a list of to-do tasks:

`/todo ask @crushermd to bake a birthday cake for @worf in #d-social`

Here's the structure:

*   `/todo` - This is the `command`, the part that tells Slack to treat it as a slash command and where to route it. You'll define yours [below](#creating_commands).
*   `ask @crushermd to bake a birthday cake for @worf in #d-social` - This is the `text` portion, it includes everything after the first space following the command. It is treated as a single parameter that is passed to the app that owns the command (we'll discuss this [more below](#app_command_handling)).

We want to make sure that birthday cake gets baked, so read on to find out how to set up commands for your apps as well as how to handle and respond to them.

* * *

## Getting started with slash commands {#getting_started}

In order to get slash commands up and running with your app, you'll have to create the command itself, then prepare your app to be able to handle the interaction flow. We'll describe that flow in more detail in the steps below, but the basic pattern is:

*   A Slack user types in the message box with the command and submits it.
*   A payload is sent via an HTTP POST request to your app.
*   Your app responds.

Let's look closer at the recipe for making a great slash command.

### 1. Creating a slash command {#creating_commands}

You need two things to create a command:

*   A Slack app,
*   The name of your new command.

If you don't already have a Slack app, click below to create one:

[Create an app](https://api.slack.com/apps?new_app=1)

Now let's get to actually creating that command. First, head to your [App Management](https://api.slack.com/apps) dashboard, select the app you wish to work with, then select **Slash Commands** under **Features** in the navigation menu. You'll be presented with a button called **Create New Command**, and when you click it, you'll see a screen prompting you to define your new slash command:

#### Defining slash commands {#defining_slash_command}

*   **Command**: The name of the command, which is the actual string that users will type to trigger a world of magic. Bear in mind our [naming advice below](#naming_your_command) when you pick this.
*   **Request URL**: The URL we'll send a payload to when the command is invoked by a user. You'll want to use a URL that you can set up to receive these payloads as we'll describe [later in this doc](#app_command_handling). If [public distribution](/app-management/distribution) is active for your app, this needs to be an HTTPS URL (and self-signed certificates are not allowed). If you're building an app [solely for your own workspace](/app-management/distribution), it should also be HTTPS.
*   **Short Description**: A short description of what your command does.
*   **Usage Hint**: Displayed to users when they try to invoke the command, so if you have any parameters that can be used with your command, we recommend showing them here. You'll see a preview of the autocomplete entry where this hint is displayed, so make sure you're keeping this hint brief enough not to get truncated.
*   **Escape channels, users, and links sent to your app**: Turning this on will modify the parameters sent with a command by a user. It will wrap URLs in angle brackets and it will translate channel or user mentions into their correlated IDs. Private channels will only include the channel ID (`<C987654321|>`) while public channels will display the channel ID _and name_ (`<C123456789|public-channel-01>`). So, if a user invoked your command like this:

    ```
    /todo ask @crushermd to bake a birthday cake for @worf in #d-social
    ```

    You'll receive the following in the sent data payload:

    ```
    ask <@U012ABCDEF> to bake a birthday cake for <@U345GHIJKL> in <#C012ABCDE>
    ```

    If disabled, the payload will repeat the plain text:

    ```
    ask @crushermd to bake a birthday cake for @worf in #d-social
    ```

    While your eyes might take less offense to the second example, in that case you'd have to resolve those plain-text names yourself using [`users.list`](/reference/methods/users.list) or [`conversations.list`](/reference/methods/conversations.list) if you planned to use any Slack API in your response to the command.

    We recommend that you enable this feature if you expect to receive user or channel mentions in the command text.

#### Naming your slash command {#naming_your_command}

Consider your command's name carefully. Slash commands are not namespaced. This means multiple commands may occupy the same name. If this happens and a user tries to invoke the command, Slack will always invoke the one that was installed most recently. It's an important thing to consider, especially if you're planning to distribute your app.

When you're picking a command name, you'll want to avoid terms that are generic and therefore likely to be duplicated. On the other hand, you don't want the command to be too complicated for users to easily remember.

In essence, a great command is descriptive and understandable but also unique. Naming it after your service is often a good idea.

Once you've created your command, any channel or workspace where your app is installed will immediately be able to start using it, so let's learn what to do when a user types one of your app's commands.

### 2. Preparing your app to receive commands {#app_command_handling}

When a slash command is invoked, Slack sends an HTTP POST to the Request URL [you specified above](#creating_commands). This request contains a data payload describing the source command and who invoked it, like a really detailed knock at the door.

For example, imagine a workspace at example.slack.com installed an app with a command called `/weather`. If someone on that workspace types `/weather 94070` in their `#test` channel and submits it, the following payload would be sent to the app:

#### Payload example {#payload_example}

```
token=gIkuvaNzQIHg97ATvDxqgjtO
&team_id=T0001
&team_domain=example
&enterprise_id=E0001
&enterprise_name=Globular%20Construct%20Inc
&channel_id=C2147483705
&channel_name=test
&user_id=U2147483697
&user_name=Steve
&command=/weather
&text=94070
&response_url=https://hooks.slack.com/commands/1234/5678
&trigger_id=13345224609.738474920.8088930838d88f008e0
&api_app_id=A123456
```

This data will be sent with a `Content-type` header set as `application/x-www-form-urlencoded`. Here are details of some of the important fields you might see in this payload:

##### Command payload info {#command_payload_descriptions}

Parameter | Description
--- | ---
`token` | (Deprecated) This is a verification token, a deprecated feature that you shouldn't use any more. It was used to verify that requests were legitimately being sent by Slack to your app, but you should use the [signed secrets functionality](/authentication/verifying-requests-from-slack) to do this instead.
`command` | The command that was entered to trigger this request. This value can be useful if you want to use a single Request URL to service multiple slash commands, as it allows you to tell them apart.
`text` | This is the part of the slash command _after_ the command itself, and it can contain absolutely anything the user might decide to type. It is common to use this text parameter to provide extra context for the command. You can prompt users to adhere to a particular format by showing them in the [_Usage Hint_ field when creating a command](#creating_commands).
`response_url` | A temporary [webhook URL](/messaging/sending-messages-using-incoming-webhooks) that you can use to [generate message responses](/interactivity/handling-user-interaction#message_responses).
`trigger_id` | A short-lived ID that will allow your app to open [a modal](/surfaces/modals).
`user_id` | The ID of the user who triggered the command.
`user_name` | (Deprecated) The plain text name of the user who triggered the command. Do not rely on this field as it has been [phased out](/changelog/2017-09-the-one-about-usernames). Use the `user_id` instead.
`team_id`, `enterprise_id`, `channel_id`, etc. | These IDs provide context about where the user was in Slack when they triggered your app's command (e.g. the workspace, Enterprise organization, or channel). You may need these IDs for your command response. The various accompanying `*_name` values provide you with the plain text names for these IDs, but as always you should only rely on the IDs as the names might change arbitrarily. We'll include `enterprise_id` and `enterprise_name` parameters on command invocations when the executing workspace is part of an Enterprise organization.
`api_app_id` | Your Slack app's unique identifier. Use this in conjunction with [request signing](/authentication/verifying-requests-from-slack) to verify context for inbound requests.

If [public distribution](/app-management/distribution) is active for your app, Slack will occasionally send your command's request URL a POST request to verify the server's SSL certificate.

These requests will include a parameter `ssl_check` set to `1` and a `token` parameter. See [Verifying requests from Slack](/authentication/verifying-requests-from-slack) for more information. Mostly, you may ignore these requests, but please do [confirm receipt as below](#responding_basic_receipt).

This payload is like getting all the ingredients to bake a really nice cake, so let's take a look at the recipe.

### 3. Responding to commands {#responding_to_commands}

There are three main ingredients in the response cake:

1.  Acknowledge your receipt of the payload.
2.  Do something useful in response right away.
3.  Do something useful in response later.

The first is like the cake itself, a required minimum, but the other two are like optional icing and toppings. We'll examine this more closely.

#### Confirming receipt {#responding_basic_receipt}

This is the step which lets Slack, and therefore the user, know that the command was successfully received by the app, regardless of what the app intends to do. Your app can do this by sending back an empty HTTP 200 response to the original request.

If you don't do this, the user will be shown an error message that indicates that the slash command didn't work — not a great experience for the user, so you should always acknowledge receipt (unless you didn't receive the command, but then you wouldn't know not to respond, and now we've fallen into a logical paradox).

This confirmation _must be_ received by Slack within 3000 milliseconds of the original request being sent, otherwise an `operation_timeout` error will be displayed to the user. If you couldn't [verify the request payload](/authentication/verifying-requests-from-slack), your app should return an error instead and ignore the request. The HTTP 200 response _doesn't have to be empty_ however, it can contain other useful stuff — a plain cake isn't all that tasty, so maybe we should add some icing.

#### Sending an immediate response {#responding_immediate_response}

As mentioned, you can include more substantive info in the body of your HTTP 200 response. In fact, you can use any of the complex [formatting](/messaging/formatting-message-text) or [Block Kit layout options](/messaging#complex_layouts) that are available when sending _any_ [message](/messaging/sending-and-scheduling-messages).

You can include this message either as plain text in the response body:

```
It's 80 degrees right now.
```

Or as a JSON payload in the response body, with a `Content-type` header of `application/json`:

```
{
    "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*It's 80 degrees right now.*"
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "Partly cloudy today and tomorrow"
      }
    }
  ]
}
```

These message responses can even include interactive elements like buttons or menus to allow users to interact more and keep the workflow active. Read our [guide to composing messages](/messaging) to explore the full range of possibilities.

**Message Visibility**

There's one special feature to response messages. When responding with a JSON payload you can directly control whether the message will be visible only to the user who triggered the command (we call these ephemeral messages), or to all members of the channel where the command was triggered.

The `response_type` parameter in the JSON payload controls this visibility; by default it is set to `ephemeral`, but you can specify a value of `in_channel` to post the response into the channel, like this:

```
{
    "response_type": "in_channel",
    "text": "It's 80 degrees right now."
}
```

When the `response_type` is `in_channel`, both the response message and the initial slash command entered by the user will be shared in the channel. For the most clarity, we recommend always declaring your intended `response_type`, even if you wish to use the default `ephemeral` value.

#### Enterprise Grid considerations {#enterprise-grid}

For Enterprise Grid organizations where apps are installed on multiple workspaces within the Grid, users will be prompted to select the workspace they want to run their slash command in when run from within a multi-workspace channel or a DM.

#### Other responses {#responding_response_url}

If you need to respond outside of the 3-second window provided by the request responses above, you still have plenty of options for keeping the workflow alive.

Read our [guide to responding to user interactions](/interactivity/handling-user-interaction#responses). There, we'll explain how you can use fields such as `response_url` or `trigger_id` from your [slash command payload](#command_payload_descriptions) to open modals and send messages.

When you're reading our [guide to responding to user interactions](/interactivity/handling-user-interaction#responses), you'll encounter fields called `replace_original` and `delete_original`, which can be used in conjunction with your `response_url` to modify previously-posted app messages in that interactive chain.

It's important to note that these fields _cannot_ modify the original user-posted message that was used to invoke the slash command.

We also explain [all the multitude of other ways](/interactivity/handling-user-interaction#async_responses) you can top this cake.

### Sending error responses {#responding_with_errors}

There are going to be times when you need to let the user know that something went wrong — perhaps the user supplied an incorrect text parameter alongside the command, or maybe there was a failure in an API being used to generate the command response.

It would be tempting in this case to return an HTTP 500 response to the initial command, but this isn't the right approach. The status code returned as a response to the command should only be used to indicate whether or not the request URL successfully received the data payload — while an error might have occurred in processing and responding to that payload, the communication itself was still successful.

Instead, you should continue to follow the above instructions to send either a response [back via the HTTP request](#responding_immediate_response) or using the `request_url` in a [message response](/interactivity/handling-user-interaction#message_responses). In that response message, communicate the error back to the user:

```
{
  "response_type": "ephemeral",
  "text": "Sorry, slash commando, that didn't work. Please try again."
}
```

* * *

## Best practices {#best-practices}

*   If you're not ready to respond to an incoming command but still want to acknowledge the user's action by having their slash command displayed within the channel, respond to your URL's invocation with a simplified JSON response containing only the `response_type` field set to `in_channel`: `{"response_type": "in_channel"}`.
*   If your command doesn't need to post anything back (either privately or publicly), respond with an empty HTTP 200 response. Only do so if you are absolutely sure no response is necessary or desired. Even a short "Got it!" ephemeral response is better than nothing.
*   Help your users understand how to use your command. **Provide a help action that explains your command's usage**. If your slash command was `/please`, you should provide a response to `/please help` that lists the other actions available.
*   Always [validate](/authentication/verifying-requests-from-slack) an incoming slash command request that has been issued to you by Slack.
*   Turn on [escaping for usernames, channels, and links](#creating_commands) by flipping the toggle in your slash command's configuration dialog. Always work with user IDs and channel IDs.
*   [Give your command a descriptive and unique name](#naming_your_command) to avoid conflicts with other apps.
*   Using multiple commands with multiple apps or development environments? Look for `api_app_id` to differentiate which app is intended for the slash command invocation.
