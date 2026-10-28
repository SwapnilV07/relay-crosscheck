Responses captured from the live Relay API on 28 Oct 2026 (from a browser, no API key):

- status-v3-success.json: GET /intents/status/v3?requestId=<real request>
- status-v3-unknown.json: GET /intents/status/v3?requestId=0x00..00 (returns 200 with status "unknown", not 404)
- requests-v3-no-key.json: GET /requests/v3 without x-api-key (400)
- requests-v2-429.json: GET /requests/v2 after two or three calls (429, no Retry-After header)
