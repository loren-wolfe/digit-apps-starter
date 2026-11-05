# MCP setup

Both MCPs are required before changing Sutton GraphQL or ShipStation HTTP. If either is
disconnected, **stop** and ask the user to connect it. Do not invent schema, permission
keys, or ShipStation request bodies.

Do **not** put a ShipStation API key or secret (or Sutton token) in MCP config, `mcp.json`,
or committed files. Each organization manages `SHIPSTATION_API_KEY`,
`SHIPSTATION_API_SECRET` (V1), `JWT_TOKEN` (Sutton staff generate this Clerk JWT and
place it in the org’s app secrets) in Sutton's built-in App Secrets UI. There is
no MCP tool for app env vars or secrets.

## Sutton MCP

Already required by sutton-app. Use:

- Resources: `graphql-schema://index`, `graphql-schema://type/{TypeName}`,
  `graphql-schema://search/{query}`
- Tools: `appPermissions`, `apps`, publish flow (`generateAppUploadLink` → POST zip →
  `publishApp` → poll `appPublish`)

Live org queries are optional. Schema lookup is not.

## ShipStation docs MCP

Official server: **documentation only**. It does not create labels or list carriers for
the customer’s account.

Cursor `mcp.json` (HTTP):

```json
{
  "mcpServers": {
    "shipstation-docs": {
      "url": "https://docs.shipstation.com/mcp"
    }
  }
}
```

Use it to confirm method, path, auth, and JSON shape for the API version you are
calling, then implement the call in `src/backend/shipstation.js` (via `ssFetch`).

- **V2:** `https://api.shipstation.com`, header `api-key`. Map:
  [shipstation-v2-map.md](shipstation-v2-map.md).
- **V1:** `https://ssapi.shipstation.com`, Basic `key:secret`. Map:
  [shipstation-v1-map.md](shipstation-v1-map.md).

Runtime mode is **not** chosen in MCP config. Key alone = V2; key + secret = V1.

## Fallback if docs MCP is down

1. Ask the user to connect `https://docs.shipstation.com/mcp`.
2. If they cannot: fetch the **live** OpenAPI for that session (V2:
   `https://docs.shipstation.com/_bundle/apis/@shipstation-v2/openapi.yaml`).
   Do not commit that file. Do not paste ShipStation prose docs into the repo.

A third-party *live* ShipStation API MCP (key in Cursor, tools that POST to ShipStation)
is out of scope. Org credentials stay in Sutton.
