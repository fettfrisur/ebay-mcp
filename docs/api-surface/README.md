# eBay API surface for this keyset

What the "Search app" production keyset can call, derived from eBay's official OpenAPI 3.1 contracts
(`https://developer.ebay.com/develop/api/spec/<name>_api.json`) and the scopes granted to the app.
Result computed on 2026-11-02 over 32 REST APIs and 418 operations.

## Regenerate

```sh
pip install pyyaml openapi-spec-validator   # validator is optional
python3 scripts/build-api-surface.py build/api-surface
```

This downloads the contracts and writes `operations.csv`, `operations.json` and
`ebay-app-token-api.openapi.json` (a merged, validated OpenAPI 3.1 file of the tier-A operations,
useful as input when designing MCP tools). `ebay-app-token-api.openapi.json` (about 1 MB) and
`operations.csv` are committed in this folder; re-run the script and copy them over to refresh them.
`operations.json` and the downloaded contracts are not committed.
If the app's granted scopes change, edit `CC` and `AC` at the top of the script.

## Tiers

- **A, app token**: callable with `client_credentials` and no eBay login. Granted client-credential scopes: `api_scope` and `commerce.feedback.readonly`. This is what the Worker uses.
- **B, user consent**: callable only with an `authorization_code` token from a signed-in eBay user, using the app's granted user scopes. Not usable by the Worker as built.
- **X, not granted**: no accepted scope is granted to the app.

When an operation lists several scopes, any one suffices (eBay's convention).

| API | A: app token | B: user consent | X: not granted |
|---|---:|---:|---:|
| account |  | 37 |  |
| analytics |  | 4 |  |
| browse | 6 |  | 1 |
| catalog |  | 2 |  |
| charity | 2 |  |  |
| deal |  |  | 4 |
| developer_analytics | 1 | 1 |  |
| edelivery_international_shipping |  |  | 28 |
| feed |  | 23 |  |
| feedback | 2 | 3 |  |
| finances |  | 10 | 3 |
| fulfillment |  | 15 |  |
| identity |  | 1 |  |
| inventory |  | 36 |  |
| key_management | 3 |  |  |
| leads |  |  | 2 |
| logistics |  |  | 6 |
| marketing | 2 | 82 |  |
| marketplace_insights |  |  | 1 |
| media |  | 10 | 3 |
| message |  | 5 |  |
| metadata | 28 |  |  |
| negotiation |  |  | 2 |
| notification | 21 |  |  |
| offer |  |  | 2 |
| order |  |  | 10 |
| post_order |  |  | 38 |
| recommendation |  | 1 |  |
| stores |  | 8 |  |
| taxonomy | 9 |  |  |
| translation | 1 |  |  |
| vero |  | 5 |  |
| **total** | **75** | **243** | **100** |

Tier A highlights: Browse (`item_summary/search`, `search_by_image`, `item/{item_id}`, `get_item_by_legacy_id`, `get_items_by_item_group`, `check_compatibility`), Taxonomy (all 9, including category suggestions and item aspects), Metadata (all 28 policy lookups), Notification (all 21), Feedback (`GET /feedback`, `GET /feedback_rating_summary`), Charity, Translation, Key Management, and `GET /developer/analytics/v1_beta/rate_limit`.

## Caveats

- Eligibility comes from the contracts, not from calls to eBay. Some APIs also need business approval beyond scope. The authoritative runtime check is `GET /developer/analytics/v1_beta/rate_limit` with an app token (see the debug-passthrough note in [the handoff](../history/2026-10-24-handoff.md); the IP lock keeps it out of reach from Claude's sandbox).
- Two upstream defects are repaired in the merged file: a Metadata path parameter without `in`, and duplicate `required` entries in some Feedback schemas.
- Some contracts use a version suffix in the file name (`account_api_v1.json`, `order_api_v1.json`, `vero_api_v2.json`), and Marketplace Insights is served as YAML.
