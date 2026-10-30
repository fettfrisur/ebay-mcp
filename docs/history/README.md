# Recovered development history

Imported on 30 October 2026 from exact Cloudflare module bytes, version metadata, deployment records, and two previously saved files. The source snapshots were preserved without edits.

## How to read the dates

The seven code commits are ordered by the first Cloudflare version containing each distinct source state. Their author dates use those version-creation timestamps. Their committer dates record this reconstruction. The author name explicitly identifies Codex as the history reconstructor; it does not claim sole original authorship. The saved handoff attributes the early implementation to the user working with Claude; conversation summaries attribute the later ChatGPT access change to work with ChatGPT.

Cloudflare timestamps establish that a snapshot existed then; they do not establish when editing began. Git retains whole seconds; the manifest and commit trailers preserve full timestamp precision. The repository’s original 30 October initialization commit remains the ancestor of the reconstruction, so the first recovered author date precedes its parent’s author date. No existing history was rewritten.

## Seven distinct source states

Times in this table are Europe/Berlin (CEST on 24 October).

| First observed | Cloudflare versions | Server version | Source commit and change |
| --- | --- | --- | --- |
| 24 Oct 2026 21:32:12 CEST | 1, 2, 3, 4, 5, 6 | 1.0.0 | [2174a3d](https://github.com/fettfrisur/ebay-mcp/commit/2174a3dda71eefb5faf7b216a9e9ef2ce35ccdc1) — Initial app-only eBay OAuth, German listing search and item details, JSON tool output, and an access key in the MCP URL path. |
| 24 Oct 2026 21:59:50 CEST | 7, 8 | 1.1.0 | [8efc033](https://github.com/fettfrisur/ebay-mcp/commit/8efc033dc3f228febd47158174a910d9cbaf273a) — Add header/Bearer authentication, the Anthropic egress allowlist, image URLs, and MCP read-only annotations while retaining the URL-key route. |
| 24 Oct 2026 22:27:34 CEST | 9 | 1.2.0 | [c77f15f](https://github.com/fettfrisur/ebay-mcp/commit/c77f15ff73f5f39e5cc1fcc1ab3e5d7a3d9da9d1) — Remove URL-key access and distinguish working used, refurbished, and for-parts listings with explicit eBay condition IDs. |
| 24 Oct 2026 22:58:34 CEST | 10 | 1.2.0 | [a21cfd1](https://github.com/fettfrisur/ebay-mcp/commit/a21cfd1a5d8c54ac24cf3ce808c23d06e58e528a) — Keep OAuth tokens per scope and add a temporary read-only debug passthrough to investigate eBay Browse and Feedback responses. The server still identifies itself as 1.2.0. |
| 24 Oct 2026 23:03:03 CEST | 11 | 2.0.0 | [b6a8fb1](https://github.com/fettfrisur/ebay-mcp/commit/b6a8fb1e69cd9db8777cc530fd7c6f9db1a7cde1) — Replace JSON results with readable text, inline seller reputation, add the seller-feedback tool and explicit failure reasons, and remove the temporary debug passthrough. |
| 24 Oct 2026 23:05:07 CEST | 12 | 2.0.1 | [b107d90](https://github.com/fettfrisur/ebay-mcp/commit/b107d9050b87e5d39cedda5a926f56c31314b8fd) — Change Feedback API filters from role:BUYER to role:SELLER because the role denotes the rated user. This recovers the corrected seller-feedback behavior. |
| 24 Oct 2026 23:42:27 CEST | 13, 14 | 2.0.3 | [8d5dee3](https://github.com/fettfrisur/ebay-mcp/commit/8d5dee3eb7214bf7fc7c1924ec4c7d6f981c01b2) — Restore URL-key authentication for ChatGPT with OpenAI connector IP checks while preserving the Claude header route. Cloudflare version 14 later uploaded identical source. |

## Configuration events with unchanged source

| Cloudflare version | UTC observation time | Event visible in metadata |
| --- | --- | --- |
| 2 | 2026-10-24T19:32:13.615586Z | ACCESS_KEY secret added. |
| 3 | 2026-10-24T19:40:50.373914Z | EBAY_CLIENT_ID initially added as plain_text. |
| 4 | 2026-10-24T19:41:42.523484Z | EBAY_CLIENT_SECRET initially added as plain_text. |
| 5 | 2026-10-24T19:45:02.814447Z | EBAY_CLIENT_SECRET changed to secret_text. |
| 6 | 2026-10-24T19:45:17.996352Z | EBAY_CLIENT_ID changed to secret_text. |
| 8 | 2026-10-24T20:21:13.861867Z | ACCESS_KEY updated; code unchanged. |
| 14 | 2026-10-29T16:15:34.340672Z | Same source as version 13; ALLOW_ALL_IPS plain_text binding appears. Its value was not exported. |

The 29 October version 14 does **not** contain a newer source implementation. Version 13 from 24 October and version 14 have SHA-256 `7ab08c6e8aa37074acea72974addf2a548ccec4055c46ab171c1edd3cf845849`.

## Evidence and design notes

- [cloudflare-versions.json](cloudflare-versions.json): all 14 version IDs, exact observation timestamps, source hashes, code-commit mappings, and binding names/types. Binding values and account identities are excluded.
- [cloudflare-deployments.json](cloudflare-deployments.json): all 13 retained deployment records. Version creation does not necessarily mean a separate deployment; version 3 has no corresponding retained deployment record.
- [active-source-check.json](active-source-check.json): fresh read-only comparison with the version serving 100% of traffic before this import.
- [2026-10-24-handoff.md](2026-10-24-handoff.md): contemporary design notes for 2.0.1, including readable output, explicit failure reasons, no result persistence, and lessons about eBay seller-role filtering. Account identity and deployment hostname redacted; an editorial notice identifies those changes.
- [saved-file-provenance.json](saved-file-provenance.json): original saved-file timestamps and hashes; the saved JavaScript exactly matches Cloudflare version 12.
- [conversation-notes.json](conversation-notes.json): dated secondary summaries. They are not verbatim transcripts, and suggested features are explicitly distinguished from implemented behavior.

## Limits and validation

No additional Claude disk snapshots survived. There is no recovered source identifying itself as 2.0.2; no missing draft or code change has been invented. The temporary Feedback API debug passthrough is present in its historical investigation commit and absent from the current source.

All 14 recovered module byte lengths and SHA-256 hashes were checked locally against hashes computed during retrieval, and all passed Node module syntax checks. The import verifier checks the chronological commit chain and source mappings. Local initialization, tool-list, and authentication smoke checks use synthetic credentials and a mocked IP-list response; they do not call eBay. These checks validate the import and basic handling, not current external eBay API behavior.

The current entry module is the exact recovered live source. Documentation, the verifier, and ignore rules were added in a separate present-day commit; no production deployment was changed.
