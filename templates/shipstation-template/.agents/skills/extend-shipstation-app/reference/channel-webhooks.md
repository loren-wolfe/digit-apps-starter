# Channel inbound webhooks

This template does **not** declare or handle inbound store webhooks.

Channel adapters are outbound-only (`afterDigitShipped` after Sutton writeback).
See [channels.md](channels.md) and [webhooks.md](webhooks.md).

## Jobs

| Job | Trigger |
| --- | --- |
| `poll-outbound-push` | Scheduled Sutton → SS push (when fulfillment method is scheduled) plus label poll |

## Activity actions

- `channel.fulfillment` — after outbound adapter
