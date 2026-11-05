# ShipStation Template — COM Requirements Assessment

**App:** Sutton ShipStation integration template (Phase 1)  
**Date:** September 2026  
**Scope:** COM-01 through COM-08

---

## Summary

The template delivers a Phase 1 integration: operators pick and pack in Sutton, push eligible orders to ShipStation for label purchase, and receive tracking writeback when labels are created. It meets the core outbound/inbound sync story for most customers out of the box, with a few gaps where behavior depends on Sutton platform features or org configuration.

| Verdict | Requirements |
| --- | --- |
| **Met** | COM-06, COM-07, COM-08 |
| **Mostly met** | COM-01, COM-02 |
| **Platform-dependent / partial** | COM-03, COM-04, COM-05 |

---

## Requirement-by-requirement

### COM-01 — Order push: Sutton → ShipStation

**Verdict: Mostly met**

When a sales order is eligible, the app pushes it to ShipStation with ship-to address, line items (SKU + quantity), and order reference ID (`external_shipment_id` / `shipment_number`).

| Spec element | Status |
| --- | --- |
| Ship-to, SKUs, quantities, order reference | ✅ Implemented |
| Manual push | ✅ “Push selected” in fulfillment queue |
| Automatic push on fulfillable | ⚠️ 5-minute scheduled poll when fulfillment method is Scheduled; Manual push waits for Refresh |
| Fulfillable = inventory + production complete | ⚠️ Requires packed items on an awaiting-carrier Sutton shipment; no explicit production-complete check |

---

### COM-02 — Fulfillment writeback: ShipStation → Sutton

**Verdict: Mostly met**

When ShipStation creates a label, the five-minute poll (and Refresh) writes tracking back to Sutton: tracking number, carrier, ship date, and shipment status set to shipped.

| Spec element | Status |
| --- | --- |
| Tracking number | ✅ Written to Sutton shipment |
| Carrier name | ✅ Written to shipment notes |
| Ship date | ✅ Written as `dropOffDate` |
| Shipment cost | ⚠️ Stored in app database only — not written to Sutton |
| Sales order status → shipped | ⚠️ App updates **shipment** status; order-level status relies on Sutton cascading |

---

### COM-03 — Tracking propagation: Sutton → sales channel

**Verdict: Partial / platform-dependent**

After writeback, channel notification is **not implemented in this app**. The template assumes Sutton’s Rutter integration pushes fulfillments to connected commerce channels (Shopify, etc.) once tracking is on the Sutton shipment. A Faire adapter exists as an extension stub only.

**Prerequisite for COM-03:** Rutter (or channel-specific adapters) configured in Sutton.

---

### COM-04 — Pick list generation

**Verdict: Met via Sutton platform, not this app**

Pick lists are generated and executed in **Sutton’s native UI**. The app displays pick status in the fulfillment queue but does not generate pick lists or pick-list PDFs.

---

### COM-05 — Packing slip generation

**Verdict: Partial**

Packing is performed in Sutton. The app offers a **sales order PDF** download from the queue (line items and order reference are on the Sutton document). There is no dedicated packing-slip PDF in the template.

---

### COM-06 — Label printing in ShipStation

**Verdict: Met**

By design: eligible orders are pushed to ShipStation; operators select carriers, rate-shop, and print labels in ShipStation. Label purchase inside Sutton is explicitly out of scope (Phase 2).

---

### COM-07 — Manual order entry

**Verdict: Met**

Users create sales orders manually in Sutton (phone, email, etc.). Any eligible order can be pushed to ShipStation via manual push or the scheduled poll. No channel-origin restriction.

---

### COM-08 — Inventory gate

**Verdict: Met**

Only orders with sufficient available inventory (`fully_available` on all remaining lines) are eligible for push. Orders without inventory are skipped with a clear reason and remain in the queue.

---

## Intended workflow (Phase 1)

```
Sutton                          ShipStation                    Sales channel
─────                          ───────────                    ─────────────
Create / receive SO
Pick & pack (native)
Push when eligible      ──►    Rate shop & print label
                        ◄──    Webhook: label created
Update Sutton shipment
(Rutter / adapters)     ──────────────────────────────►    Tracking & fulfillment
```

---

## Gaps to close for strict COM compliance

1. **Event-driven push** — Replace or supplement the 5-minute poll with real-time triggers when orders become fulfillable.
2. **Shipment cost writeback** — Persist label cost on the Sutton shipment (or order), not only in the app database.
3. **Channel propagation** — Document Rutter as a hard prerequisite, or implement channel adapters (Shopify, Faire, etc.) in the app.
4. **Documents** — Clarify or add dedicated pick-list and packing-slip outputs if sales order PDF is insufficient.

---

## Configuration notes

| Setting | Default | Effect on COM-01 |
| --- | --- | --- |
| `default_fulfillment_method` | `scheduled` | 5-minute poll pushes eligible awaiting-carrier shipments |
| `default_fulfillment_method` | `manual` | Push only on Refresh |
| Scheduled poll | Every 300s | Label writeback always; outbound push only when scheduled |

**Required secrets:** `SHIPSTATION_API_KEY`, `JWT_TOKEN`. Optional `SHIPSTATION_API_SECRET` for V1.

---

*Assessment based on the shipstation-template codebase (Phase 1 as documented in SPEC.md).*
