# App manifest reference

Manifests are written in YAML or JSON using a specific structure. The Deno Slack SDK enables writing manifests in TypeScript.

## Example JSON Manifest

```json
{
  "_metadata": {
    "major_version": 2,
    "minor_version": 1
  },
  "display_information": {
    "name": "The Very Fantastic Name of Your App",
    "long_description": "A very long description...",
    "description": "A shorter description.",
    "background_color": "#0000AA"
  },
  "settings": {
    "allowed_ip_address_ranges": ["123.123.123.123","124.124.124.124"],
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": false,
    "event_subscriptions": {
      "request_url": "https://example.com/slack/the_Events_API_request_URL",
      "bot_events": ["app_home_opened","message_metadata_deleted","link_shared","assistant_thread_started","message.im","function_executed"],
      "user_events": ["reaction_added"],
      "metadata_subscriptions": [
        {"app_id": "A123ABC456","event_type": "star_added"},
        {"app_id": "A123ABC456","event_type": "star_removed"},
        {"app_id": "*","event_type": "task_added"}
      ]
    },
    "incoming_webhooks": {"incoming_webhooks_enabled": false},
    "interactivity": {
      "is_enabled": true,
      "request_url": "https://example.com/slack/message_action",
      "message_menu_options_url": "https://example.com/slack/message_menu_options"
    },
    "is_hosted": false,
    "function_runtime": "remote"
  },
  "features": {
    "app_home": {"home_tab_enabled": false,"messages_tab_enabled": false,"messages_tab_read_only_enabled": false},
    "assistant_view": {
      "assistant_description": "this is a string description of the app assistant.",
      "suggested_prompts": [{"title": "User help","message": "How do I use this awesome app?"}]
    },
    "bot_user": {"display_name": "Your Amazingly Helpful Bot","always_online": false},
    "shortcuts": [
      {"name": "Use your app","callback_id": "a-really-cool-callback_id","description": "Awesome and Helpful App","type": "message"}
    ],
    "slash_commands": [
      {"command": "/z","description": "You see a mailbox in the field.","should_escape": false,"usage_hint": "/zork open mailbox","url": "https://example.com/slack/slash/please"}
    ],
    "unfurl_domains": ["example.com"]
  },
  "oauth_config": {
    "scopes": {
      "bot": ["commands","chat:write","chat:write.public","metadata.message:read","links:read","assistant:write","im:history","reactions:write"],
      "user": ["channels:history","reactions:read","reactions:write"]
    },
    "redirect_urls": ["https://example.com/slack/auth"],
    "token_management_enabled": true
  }
}
```

## Example YAML Manifest

```yaml
_metadata:
  major_version: 2
  minor_version: 1
display_information:
  name: The Very Fantastic Name of Your App
  long_description: A very long description...
  description: A shorter description.
  background_color: "#0000AA"
settings:
  allowed_ip_address_ranges:
    - 123.123.123.123
    - 124.124.124.124
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
  event_subscriptions:
    request_url: https://example.com/slack/the_Events_API_request_URL
    bot_events:
      - app_home_opened
      - message_metadata_deleted
      - link_shared
      - assistant_thread_started
      - message.im
      - function_executed
    user_events:
      - reaction_added
  interactivity:
    is_enabled: true
    request_url: https://example.com/slack/message_action
features:
  bot_user:
    display_name: Your Amazingly Helpful Bot
    always_online: false
  slash_commands:
    - command: /z
      description: You see a mailbox in the field.
      should_escape: false
      usage_hint: /zork open mailbox
      url: https://example.com/slack/slash/please
oauth_config:
  scopes:
    bot:
      - commands
      - chat:write
      - chat:write.public
  redirect_urls:
    - https://example.com/slack/auth
  token_management_enabled: true
```

## Manifest Reference Sections

The following tables describe the settings you can define within an app manifest.

### Metadata {#metadata}

Field | Description | Required
--- | --- | ---
`_metadata` | A group of settings that describe the manifest. | Optional
`_metadata.major_version` | An integer that specifies the major version of the manifest schema to target. | Optional
`_metadata.minor_version` | An integer that specifies the minor version of the manifest schema to target. | Optional

### Slack Marketplace {#slack-marketplace}

Field | Description | Required
--- | --- | ---
`app_directory` | An object containing information to be listed in the Slack Marketplace. | Optional
`app_directory.app_directory_categories` | An array of strings. | Optional
`app_directory.use_direct_install` | Boolean value if the app should use direct install. | Optional
`app_directory.direct_install_url` | A string URL of the install page. | Optional
`app_directory.installation_landing_page` | A string URL of the installation landing page. | Required (if `app_directory` subgroup is included)
`app_directory.privacy_policy_url` | A link to your app's privacy policy. | Required
`app_directory.support_url` | A link to your app's support URL. | Required
`app_directory.support_email` | An email address to contact your app's support. | Required
`app_directory.supported_languages` | An array of strings representing the languages supported by the app. | Required
`app_directory.pricing` | A string of pricing information. | Required

### Display {#display}

Field | Description | Required
--- | --- | ---
`display_information` | A group of settings that describe parts of an app's appearance within Slack. | Required
`display_information.name` | A string of the name of the app. Maximum length is 35 characters. | Required
`display_information.description` | A string with a short description of the app. Maximum length is 140 characters. | Optional
`display_information.long_description` | A string with a longer version of the description. Maximum length is 4000 characters. | Optional
`display_information.background_color` | A string containing a hex color value. | Optional

### Features {#features}

Field | Description | Required
--- | --- | ---
`features` | A group of settings corresponding to the **Features** section. | Optional
`features.app_home` | A subgroup of settings that describe [App Home](/surfaces/app-home) configuration. | Optional
`features.app_home.home_tab_enabled` | A boolean that specifies whether or not the Home tab is enabled. | Optional
`features.app_home.messages_tab_enabled` | A boolean that specifies whether or not the Messages tab is enabled. | Optional
`features.app_home.messages_tab_read_only_enabled` | A boolean that specifies whether or not users can send messages to your app. | Optional
`features.assistant_view` | Settings related to assistant view for AI features. | Optional
`features.assistant_view.assistant_description` | A string description of the app assistant. | Required (if `assistant_view` subgroup is included)
`features.assistant_view.suggested_prompts` | An array of hard-coded prompts. | Optional
`features.bot_user` | A subgroup of settings that describe bot user configuration. | Optional
`features.bot_user.display_name` | A string containing the display name of the bot user. Max 80 chars. | Required (if `bot_user` subgroup is included)
`features.bot_user.always_online` | Whether the bot user always appears online. | Optional
`features.shortcuts` | An array of settings groups that describe shortcuts. Max 10. | Optional
`features.shortcuts[].name` | Name of the shortcut. | Required
`features.shortcuts[].callback_id` | callback_id of this shortcut. Max 255 chars. | Required
`features.shortcuts[].description` | Short description. Max 150 chars. | Required
`features.shortcuts[].type` | One of `message` or `global`. | Required
`features.slash_commands` | An array of slash command settings. Max 50. | Optional
`features.slash_commands[].command` | The slash command. Max 32 chars, must start with `/`. | Required
`features.slash_commands[].description` | Description of the slash command. Max 2000 chars. | Required
`features.slash_commands[].should_escape` | Whether channels/users/links should be escaped. Defaults `false`. | Optional
`features.slash_commands[].url` | Full `https` request URL. | Optional
`features.slash_commands[].usage_hint` | Usage hint. Max 1000 chars. | Optional
`features.unfurl_domains` | Array of valid unfurl domains. Max 5. | Optional

### OAuth {#oauth}

Field | Description | Required
--- | --- | ---
`oauth_config` | A group of settings describing OAuth configuration for the app. | Optional
`oauth_config.redirect_urls` | An array of OAuth redirect URLs. Max 1000. | Optional
`oauth_config.scopes` | A subgroup of settings that describe permission scopes configuration. | Optional
`oauth_config.scopes.bot` | An array of bot scopes to request upon app installation. Max 255. | Optional
`oauth_config.scopes.bot_optional` | An array of optional bot scopes. Optional scopes must also be listed in the corresponding bot fields. | Optional
`oauth_config.scopes.user` | An array of user scopes to request upon app installation. Max 255. | Optional
`oauth_config.scopes.user_optional` | An array of optional user scopes. | Optional
`oauth_config.token_management_enabled` | A boolean that indicates if token management should be enabled. | Optional

### Settings {#settings}

Field | Description | Required
--- | --- | ---
`settings` | Group of settings corresponding to the Settings section of an app's config pages. | Optional
`settings.allowed_ip_address_ranges` | Array of IPs that conform to the Allowed IP Ranges feature. Max 10. | Optional
`settings.event_subscriptions` | A subgroup of settings that describe Events API configuration. | Optional
`settings.event_subscriptions.request_url` | The full `https` URL that acts as the Events API request URL. | Optional
`settings.event_subscriptions.bot_events` | Array of event types to subscribe to. Max 100. | Optional
`settings.event_subscriptions.user_events` | Array of event types to subscribe to on behalf of authorized users. Max 100. | Optional
`settings.event_subscriptions.metadata_subscriptions` | Array of objects with `app_id` and `event_type`. | Optional
`settings.incoming_webhooks` | Object with single boolean property `incoming_webhooks_enabled`. | Optional
`settings.interactivity` | A subgroup of settings that describe interactivity configuration. | Optional
`settings.interactivity.is_enabled` | Whether interactivity features are enabled. | Required (if using `interactivity` settings)
`settings.interactivity.request_url` | The full `https` interactive Request URL. | Optional
`settings.interactivity.message_menu_options_url` | The full `https` interactive Options Load URL. | Optional
`settings.org_deploy_enabled` | Whether organization-wide deployment is enabled. Required for functions. | Optional
`settings.socket_mode_enabled` | Whether Socket Mode is enabled. | Optional
`settings.token_rotation_enabled` | Whether token rotation is enabled. | Optional
`settings.is_hosted` | Whether the app is hosted by Slack. | Optional
`settings.siws_links` | Object indicating use of SIWS Links. | Optional
`settings.siws_links.initiate_uri` | A string that follows pattern ^https:\/\/. | Optional
`settings.function_runtime` | Runtime of any functions declared in the manifest: `remote` or `slack`. | Required (if using `functions`)

### Functions {#functions}

The function settings should be used to create custom workflow steps available for use in workflows either defined in the manifest or built directly in Workflow Builder.

The function property is a map, where the keys are the `callback_id` of the step.

Field | Description | Required
--- | --- | ---
`functions.<callback_id>` | A unique string identifier in snake_case format; max 100 characters. | Optional
`functions.<callback_id>.title` | A string to identify the step; max 255 characters. | Required
`functions.<callback_id>.description` | A succinct summary of what your step does. | Required
`functions.<callback_id>.input_parameters` | Object describing input parameters. | Required
`functions.<callback_id>.output_parameters` | Object describing output parameters. | Required

### Workflows {#workflows}

Field | Description | Required
--- | --- | ---
`workflows` | Declare the workflow the app provides. | Optional
`workflows.title` | String title of the workflow. | Required
`workflows.description` | String description of the workflow. | Required
`workflows.input_parameters` | Array of properties used as workflow inputs. | Optional
`workflows.output_parameters` | Array of properties used as workflow outputs. | Optional
`workflows.steps` | Array of step objects in the workflow. | Required
`workflows.suggested_triggers` | Array of trigger objects. | Optional

### Datastores {#datastores}

Field | Description | Required
--- | --- | ---
`datastores` | Declares the datastores used by the app. | Optional
`datastores.primary_key` | A unique string. | Required
`datastores.attributes` | An object of datastore attributes. | Required
`datastores.attributes.type` | Object type of the attribute. | Required
`datastores.attributes.items` | Object with required `type` and `properties` array. | Optional
`datastores.attributes.properties` | An object array of properties. | Optional
`datastores.time_to_live_attribute` | String representing the TTL attribute. | Optional

### Outgoing domains {#outgoing-domains}

Field | Description | Required
--- | --- | ---
`outgoing_domains` | An array of accepted egress domains for an app with `function_runtime` = `slack`. Max 10 items. | Optional

### Types {#types}

Field | Description | Required
--- | --- | ---
`types` | Declare the types the app provides. Max 50. | Optional
`types.type` | String type. | Required
`types.title` | String title of the type. | Optional
`types.description` | String description of the type. | Optional
`types.is_required` | Boolean indicating if the type is required. | Optional
`types.is_hidden` | Boolean indicating if the type is hidden. | Optional
`types.hint` | String hint for the type. | Optional

### Events {#metadata_events}

Field | Description | Required
--- | --- | ---
`metadata_events` | Declare the events the app can emit. Either an `object` or `reference`. | Optional
`metadata_events.object.type` | Type of event. | Required (if subgroup included)
`metadata_events.object.title` | The string title of the event. | Optional
`metadata_events.object.description` | The string description of the event. | Optional
`metadata_events.object.required` | Array of required objects. | Optional
`metadata_events.object.additionalProperties` | Boolean indicating additional properties. | Optional
`metadata_events.object.nullable` | Boolean indicating if the object is nullable. | Optional
`metadata_events.object.properties` | Object of properties, max 50. | Optional

### External auth providers {#external-auth-providers}

Field | Description | Required
--- | --- | ---
`external_auth_providers` | Declares the OAuth configuration used by the app. | Optional
`external_auth_providers.provider_type` | `CUSTOM` or `SLACK_PROVIDED`. | Required
`external_auth_providers.options` | Configuration options. | Required
`external_auth_providers.options.client_id` | String, max 1024 chars. | Required
`external_auth_providers.options.provider_name` | String, max 255 chars. | Required (if CUSTOM)
`external_auth_providers.options.authorization_url` | String, max 255 chars. Pattern ^https:\/\/. | Required (if CUSTOM)
`external_auth_providers.options.token_url` | String, max 255 chars. Pattern ^https:\/\/. | Required (if CUSTOM)
`external_auth_providers.options.scope` | String array of scopes. | Required
`external_auth_providers.options.identity_config` | Identity configuration object. | Required (if CUSTOM)
`external_auth_providers.options.use_pkce` | Boolean flag indicating PKCE. | Optional

### Compliance {#compliance}

Field | Description | Required
--- | --- | ---
`compliance` | Compliance certifications for GovSlack. | Optional
`compliance.fedramp_authorization` | FedRAMP certification. | Optional
`compliance.dod_srg_ilx` | DoD SRG. | Optional
`compliance.itar_compliant` | ITAR compliance. | Optional
