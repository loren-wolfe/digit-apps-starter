# Webhooks

This template does **not** declare, subscribe, verify, or process inbound webhooks.

Tracking, carrier, and cost come from the 5-minute poll and `POST /sync/poll`
(`GET /v2/labels` or V1 `GET /orders/{id}`).

Do not add `backend.webhooks` to `manifest.json` unless a customer clone explicitly
asks for a store inbound adapter and you reintroduce a verify → job pipeline.
