# ebay-mcp
ebay mcp server. Requires official ebay developer account api credentials.

A dependency-free Cloudflare Worker exposing three read-only MCP tools:

- `search_ebay`: German eBay listing search, with price, condition, location, images, and seller reputation.
- `get_ebay_item`: listing details, specifications, condition notes, shipping, and seller reputation.
- `get_seller_feedback`: seller feedback summaries and comments.

The entry module is [`worker.js`](worker.js), using Cloudflare compatibility date `2025-09-01`. Its server version is **2.0.3**. The source is byte-for-byte identical to the live Worker checked on 30 October 2026; see [the recorded comparison](docs/history/active-source-check.json).

## Configuration

Provide these Cloudflare Worker secrets:

| Name | Purpose |
| --- | --- |
| `EBAY_CLIENT_ID` | eBay production App ID |
| `EBAY_CLIENT_SECRET` | eBay production client secret |
| `ACCESS_KEY` | shared MCP access key |

The Worker uses app-only eBay OAuth. It returns plain-text tool results and keeps OAuth tokens in memory; it does not persist eBay listing or feedback data.

Claude uses `/mcp` with `x-api-key` or a Bearer token and the implemented Anthropic IP restriction. ChatGPT uses `/mcp/<URL-encoded ACCESS_KEY>` with the implemented OpenAI connector IP checks. `ALLOW_ALL_IPS="true"` is the development override; it does not remove the access-key requirement. This describes the imported implementation, not a guarantee that external providers' IP ranges or APIs will remain unchanged.

## Recovered development history

The [history timeline](docs/history/README.md) links seven recovered source commits, covering all 14 retained Cloudflare versions. Each has the evidenced historical author date and the actual reconstruction committer date, with version IDs and SHA-256 checksums in its message. The original repository initialization and license remain intact.

The [original handoff](docs/history/2026-10-24-handoff.md) records design decisions and eBay API discoveries. The [version manifest](docs/history/cloudflare-versions.json) also records configuration-only events and points each version at its corresponding source commit.

No original Git commits existed for these recovered snapshots. They are explicitly reconstructed history, imported on 30 October 2026. The import did not redeploy the live Worker.

## Verification

With Python 3, Git, and a complete clone:

```sh
python3 scripts/verify-history.py
```

This checks all 14 source hashes, the seven source commits and their dates, the original license, and the recorded live-source match. It verifies against saved evidence without calling Cloudflare or eBay.

Check the entry module's syntax with Node.js:

```sh
node --input-type=module --check < worker.js
```
