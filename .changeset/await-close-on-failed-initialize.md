---
'@modelcontextprotocol/client': patch
---

Wait for the transport to finish closing when the legacy initialize handshake fails, so `connect()` rejects only after that close has settled. A `connect()` retried on a new transport is no longer torn down by the previous transport's close.
