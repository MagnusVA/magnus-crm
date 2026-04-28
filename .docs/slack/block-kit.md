# Block Kit

The Block Kit UI framework is built with _blocks_, _block elements_ and _composition objects_.

_Blocks_ are visual components that can be arranged to create app layouts. Apps can add blocks to _surfaces_ like [the Home tab](/surfaces/app-home), [messages](/messaging) and [modals](/surfaces/modals). You can include up to 50 blocks in each message, and 100 blocks in modals or Home tabs.

Blocks may also contain _block elements_. Block elements are usually interactive components, such as buttons and menus.

Blocks and block elements are built with _composition objects_. Composition objects define text, options, or other interactive features within certain blocks and block elements.

Whether you're composing layouts for modals, messages, or tabs, the Block Kit building experience is the same — your app will be sculpting specially-structured JSON to express itself. The result is clear, interactive communication between your app and its users.

* * *

## Placing blocks within surfaces {#adding_blocks}

Blocks are used within all [app surfaces](/surfaces): [Home tabs](/surfaces/app-home), [messages](/messaging) and [modals](/surfaces/modals) can all be designed using blocks.

Each of them uses a `blocks` array that you prepare by [stacking individual blocks together](#stack_of_blocks).

Check out [app surfaces](/surfaces) to learn more about using these different surfaces, and how to add blocks to your app's [Home tab](/surfaces/app-home#composing), [messages](/messaging), and [modals](/surfaces/modals#composing_modal).

Some blocks can only be used in particular app surfaces.

Read the [Block Kit reference guides](/reference/block-kit/blocks) to check if a block is compatible with your app's surfaces.

## Building blocks {#getting_started}

There's no special setup needed to start using blocks in [app surfaces](/surfaces). However, just as when you open a pack of generic, colorful, interlocking plastic bricks, you should read the instructions first.

### Defining a single block {#block_basics}

Each block is represented in our APIs as a JSON object. Here's an example of a [`section`](/reference/block-kit/blocks/section-block) block:

```
{
  "type": "section",
  "text": {
    "type": "mrkdwn",
    "text": "New Paid Time Off request from <example.com|Fred Enriquez>\n\n<https://example.com|View request>"
  }
}
```

Every block contains a `type` field — specifying which of the [available blocks](/reference/block-kit/blocks) to use — along with other fields that describe the content of the block.

[Block Kit Builder](https://api.slack.com/tools/block-kit-builder) is a visual prototyping sandbox that will let you choose from, configure, and preview all the available blocks.

If you want to skip the builder, the [block reference guide](/reference/block-kit/blocks) contains the specifications of every block, and the JSON fields required for each of them.

### Stacking multiple blocks {#stack_of_blocks}

Individual blocks can be stacked together to create complex visual layouts.

When you've chosen each of the blocks you want in your layout, place each of them in an array, in visual order, like this:

```
[
  {
    "type": "header",
    "text": {"type": "plain_text","text": "New request"}
  },
  {
    "type": "section",
    "fields": [
      {"type": "mrkdwn","text": "*Type:*\nPaid Time Off"},
      {"type": "mrkdwn","text": "*Created by:*\n<example.com|Fred Enriquez>"}
    ]
  },
  {
    "type": "section",
    "fields": [
      {"type": "mrkdwn","text": "*When:*\nAug 10 - Aug 13"}
    ]
  },
  {
    "type": "section",
    "text": {"type": "mrkdwn","text": "<https://example.com|View request>"}
  }
]
```

[Block Kit Builder](https://api.slack.com/tools/block-kit-builder) will allow you to drag, drop, and rearrange blocks to design and preview Block Kit layouts.

Alternatively you can use the [block reference guide](/reference/block-kit/blocks) to manually generate a complete `blocks` array, like the one shown above.

Your newly created array of blocks can be used [with a range of different app surfaces](#adding_blocks).

### Accessibility considerations {#accessibility}

When posting messages, it is expected behavior that screen readers will default to the top-level `text` field of the post, and will not read the content of any interior `blocks` in the underlying structure of the message. Therefore, to make an accessible app, you must either:

*   include all necessary content for screen reader users in the top-level `text` field of your message, or
*   do not include a top-level `text` field if the message has `blocks`, and allow Slack attempt to build it for you by appending content from supported `blocks` to be read by the screen reader.

* * *

## Adding interactivity to blocks with block elements {#making-things-interactive}

Blocks can be made to interact with users via Block Kit _elements_. Elements include interactive components such as buttons, menus and text inputs.

Here's an example of a [`button`](/reference/block-kit/block-elements/button-element) element within a [`section`](/reference/block-kit/blocks/section-block) block.

```
{
  "blocks": [
    {
      "type": "section",
      "text": {"type": "mrkdwn","text": "This is a section block with a button."},
      "accessory": {
        "type": "button",
        "text": {"type": "plain_text","text": "Click Me","emoji": true},
        "value": "click_me_123",
        "action_id": "button-action"
      }
    }
  ]
}
```

When you add an interactive component to a surface in your Slack app, you've opened the door to user interaction. People will push your app's buttons and expecting a helpful and prompt reaction.

Apps need to handle the requests that start to flow their way, and respond appropriately. Follow our [guide to handling user interaction](/interactivity/handling-user-interaction) to prepare your app for the interactivity that Block Kit will inspire.

Block Kit builder allows you to add elements to blocks as well. Give it a try! Alternatively, read the [Block Kit element reference guide](/reference/block-kit/block-elements) for all the info you'll need for manually implementing individual elements.

* * *

## Onward {#onward}

Check out the following guides for everything blocks:

*   [Blocks](/reference/block-kit/blocks)
*   [Block elements, including interactive components](/reference/block-kit/block-elements)
*   [Composition objects](/reference/block-kit/composition-objects)
*   [View objects](/reference/views)
