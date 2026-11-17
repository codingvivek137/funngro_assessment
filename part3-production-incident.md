# Part 3 — Production incident: first 30 minutes

My first goal is to stop more users from losing access to money. I would not start by changing database indexes or restarting everything. I would first find out whether payouts are being accepted by the gateway, whether our database is slow, and whether requests are being duplicated.

## Minute 0–5: Confirm impact and stop the risk

1. I would declare an incident and tell the on-call/backend lead, support and the person responsible for payouts. I would ask support to collect a few affected user IDs and withdrawal references, without sharing bank details in chat.
2. I would check the last hour against the previous hour:
   - Request rate and error rate for `/api/wallet/withdraw`.
   - p50, p95 and p99 latency.
   - Number of pending withdrawals and the number of gateway success/failure responses.
   - Whether the 11-second latency affects all API routes or only withdrawal.
3. If we cannot confirm that the payout path is safe, I would temporarily disable new withdrawals using a feature flag or gateway circuit breaker. I would keep wallet reads and withdrawal-history reads available if they are healthy. I would not delete pending records or manually change balances.

**Decision:** If the gateway is accepting payouts but our API is timing out, I would stop client retries from creating new payout attempts and preserve the existing references. If we cannot guarantee idempotency, I would pause new withdrawals until we can verify the state of in-flight requests.

## Minute 5–10: Check application logs

I would inspect logs for a small time window around affected requests and group them by request ID, user ID and withdrawal/reference ID.

Example commands (assuming structured JSON logs are available on the application host):

```bash
# Recent withdrawal errors
grep 'wallet/withdraw' app.log | grep -E '"status":5[0-9][0-9]|error|timeout' | tail -200

# Search for one known withdrawal/reference
grep 'WD-REFERENCE-HERE' app.log

# Find gateway timeout/error messages
grep -Ei 'gateway|payout|timeout|ECONNRESET|ETIMEDOUT' app.log | tail -200
```

If logs are in a central logging platform, I would run the equivalent filters there rather than relying on one server's local file.

I would look for:
- MongoDB query timeouts or connection-pool wait messages.
- Gateway timeouts, 429s, 5xx responses or authentication errors.
- The same user/request/reference appearing multiple times.
- A large increase in requests per user.
- Whether the handler logs success before the gateway result is known.

**Decision:** If the same withdrawal is being submitted repeatedly, I would rate-limit or temporarily block duplicate attempts and check whether the gateway supports idempotency. I would not assume every timeout means the gateway failed.

## Minute 10–20: Check MongoDB Atlas and the gateway

### MongoDB Atlas

I would open Atlas Metrics and compare the incident window with the previous hour. I would check:

- CPU utilization and memory.
- Disk IOPS, disk latency and available storage.
- Connections and connection-pool pressure.
- Read/write operation rate.
- Network in/out.
- Replication lag and tickets/alerts for elections.
- Query execution time and slow-query logs/profiler.

I would look especially for collection scans and slow ledger queries. The original handler loads a user's complete ledger history and sorts it. On a 40-million-document collection without a `{ userId, createdAt }` index, that is a strong suspect.

Example checks in `mongosh`:

```js
// Check indexes on the large collections
db.ledger.getIndexes();
db.wallets.getIndexes();

// Check whether a user's ledger history can use an index
db.ledger
  .find({ userId: ObjectId("USER_ID_HERE") })
  .sort({ createdAt: -1 })
  .limit(20)
  .explain("executionStats");

// Check wallet lookup plan
db.wallets
  .find({ userId: ObjectId("USER_ID_HERE") })
  .explain("executionStats");
```

I would look at `COLLSCAN`, `totalDocsExamined`, `totalKeysExamined` and `executionTimeMillis`. I would not run an expensive full-collection query during the incident.

### Payment gateway

I would check the gateway dashboard for:
- Payout success, failure and pending counts.
- Gateway p95 latency.
- 4xx/5xx responses and rate limits.
- Whether the affected references were accepted.
- Whether the gateway has a status lookup or reconciliation endpoint.

**Decision:** If the gateway shows a payout as successful while our database says pending, I would not send it again. I would reconcile and update our record using the original gateway reference. If the gateway is failing, I would keep new withdrawals paused and wait for confirmed status before retrying.

## Minute 20–30: Contain, reconcile and communicate

1. I would keep withdrawals paused if we still cannot prove that retries are safe. If we have confirmed idempotency and the gateway is healthy, I would consider enabling a small percentage of traffic and watch it closely.
2. I would build a list of affected withdrawal IDs and compare our records with gateway statuses: succeeded, failed, pending or unknown.
3. For a confirmed success, I would update the internal status without sending another payout. For a confirmed permanent failure, I would follow the approved refund process and create a reversal ledger entry. For unknown outcomes, I would leave the request pending and investigate; I would not refund blindly.
4. I would tell Support what users should be told: the request is being checked, and they should not submit another withdrawal for the same amount while it is under investigation. I would give them a way to identify affected requests by withdrawal ID.
5. I would share a short incident update with the team: impact, what is paused, what we know from the gateway, and the next check.

## What I would not do

- I would not restart MongoDB or the application as my first move. It can hide evidence and may not fix a slow query or gateway problem.
- I would not manually increase or decrease wallet balances without a verified withdrawal record and an auditable correction.
- I would not retry every failed or timed-out payout. A timeout can mean the gateway completed the transfer but our system missed the response.
- I would not build a new index blindly during peak traffic. I would confirm the query plan and understand the operational impact first.
- I would not tell users that money is lost or that a payout succeeded until the gateway status is verified.

**My priority is to prevent duplicate payouts, preserve an audit trail, and reconcile every affected withdrawal before reopening the endpoint.**
