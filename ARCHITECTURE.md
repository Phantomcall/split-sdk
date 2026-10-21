# Architecture

## Request Deduplication for Idempotency

Idempotent operations are protected by a request deduplication layer that
prevents the same logical request from being executed more than once.

### Design

- **Idempotency key**: every idempotent request carries a client-supplied
  `Idempotency-Key` header (or an equivalent key derived from the request
  payload). The key uniquely identifies the logical operation.
- **Request tracking**: a deduplication store records each key together with
  its state (`in-flight` or `completed`), the owning request, and timestamps.
- **Duplicate detection**: when a request arrives with a key that is already
  tracked, the layer does not re-execute the operation. If the original is
  still `in-flight`, the duplicate waits for (or is rejected with a conflict
  response for) the original result. If it is `completed`, the cached
  response is returned immediately.
- **Response caching**: the outcome (status, headers, body) of a completed
  idempotent request is cached against its key so that retries receive the
  identical response.
- **Cleanup**: tracked entries and cached responses expire after a
  configurable TTL and are purged by a periodic cleanup task, bounding memory
  usage and allowing keys to be reused after the retention window.
- **Metrics**: the layer exposes counters for deduplicated requests, cache
  hits, in-flight collisions, and expired entries so operators can observe
  deduplication behavior.

### Guarantees

- Repeated requests with the same idempotency key produce the same response
  and never execute the underlying operation twice.
- Concurrent duplicates are serialized against the original request.
- Stale entries are removed automatically by the cleanup process.
