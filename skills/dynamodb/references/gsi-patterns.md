# DynamoDB GSI Patterns

## What GSIs Are

A Global Secondary Index (GSI) is a complete copy of your table — or a projected subset of it — organized under a different partition key and sort key. DynamoDB maintains the GSI automatically as you write to the base table.

**Key properties:**

- **Different key structure.** The GSI PK and SK are independent of the base table PK and SK. You define them, and they can be any attribute on the item (including attributes that only some items have).
- **Eventually consistent reads.** GSI reads are always eventually consistent. There is a replication lag between a base table write and when that change is visible in a GSI — typically milliseconds, but under sustained heavy write load it can extend. If you need strongly consistent reads, you must query the base table directly.
- **Separate throughput capacity.** Each GSI has its own RCU and RCU provisioned capacity (or its own partition of on-demand capacity). A GSI does not share capacity with the base table. A read against the GSI costs RCUs from the GSI's capacity, not the table's.
- **Written on every relevant base table write.** When you write an item to the base table, DynamoDB automatically propagates that write to any GSI where the item's GSI key attributes exist. You pay WCUs for both the base table write and each GSI write.
- **Items appear in a GSI only if the GSI key attributes exist on the item.** This is what enables sparse indexes.
- **Up to 20 GSIs per table** (increased from the original limit of 5).

---

## GSI Design Principles

### Project Only What You Need

Every item written to the base table generates a GSI write for each GSI that includes that item. The size of the GSI item — determined by which attributes are projected — affects WCU consumption.

DynamoDB offers three projection options:

| Projection | What's in the GSI | Use when |
|---|---|---|
| `KEYS_ONLY` | Base table PK/SK + GSI PK/SK only | You only need to know if the item exists, or you'll use the key to fetch the full item from the base table |
| `INCLUDE` | Keys + specific named attributes | You need a known set of attributes for your access pattern — most common choice |
| `ALL` | Every attribute on the item | You need the full item and the extra write cost is acceptable |

`KEYS_ONLY` is the cheapest GSI to maintain. `ALL` is the most expensive. The question to ask: "What attributes does my application actually need when it queries this GSI?" Project those and nothing more.

If you use `KEYS_ONLY` and realize at query time you need additional attributes, you have two options: fetch each item by its base table key (a `BatchGetItem` against the main table), or update the GSI to project more attributes. Projecting too few is fixable; projecting `ALL` out of laziness costs money every write.

### Design for Selectivity

A GSI partition with millions of items is as problematic as a hot base table partition. When a GSI PK has very low cardinality — like a boolean `isActive` field with values `true` or `false` — every active item lands in one GSI partition, creating a hot spot. Design GSI keys with enough cardinality to distribute reads and writes.

### Sparse Indexes Are Intentional

An item without a GSI key attribute does not appear in that GSI. This is not a limitation — it is a design tool. Only populate GSI key attributes on items you want to appear in the index.

---

## Common GSI Patterns

### 1. Inverted Index

**Problem:** Your base table is keyed by `PK=UserID, SK=OrderID` so you can query "all orders for a user." But you also need to look up a specific order by `OrderID` alone, without knowing the `UserID`.

**Solution:** Create a GSI that swaps PK and SK:

| | Base Table | GSI (Inverted) |
|---|---|---|
| PK | `USER#u1` | `ORDER#o1` |
| SK | `ORDER#o1` | `USER#u1` |

A `GetItem` or `Query` against the GSI with `PK=ORDER#o1` returns the order regardless of which user owns it.

This pattern appears frequently when you have hierarchical data where you sometimes need to traverse the hierarchy from the child up rather than from the parent down.

### 2. GSI Overloading

**Problem:** You have multiple entity types that each need a different secondary access pattern. Creating a separate GSI per entity type burns toward your 20-GSI limit and creates a confusing schema.

**Solution:** Use generic GSI attribute names (`GSI1PK`, `GSI1SK`) and populate them with different values per entity type. One physical GSI serves multiple logical access patterns.

Example — a single GSI with `GSI1PK` and `GSI1SK`:

| Entity | GSI1PK value | GSI1SK value | Serves access pattern |
|---|---|---|---|
| User | `EMAIL#user@example.com` | `USER#u1` | Look up user by email |
| Product | `CATEGORY#electronics` | `PRODUCT#p1` | List products by category |
| Order | `STATUS#PENDING` | `2024-01-15#o1` | List pending orders by date |

A query against the GSI with `GSI1PK=CATEGORY#electronics` returns only products in that category — not users or orders — because only product records have that value in `GSI1PK`.

The type prefix on the key value (`EMAIL#`, `CATEGORY#`, `STATUS#`) is what keeps entity types from colliding in the same GSI. This is GSI overloading in practice.

**Tradeoff:** The generic names (`GSI1PK`, `GSI1SK`) are opaque without documentation. Keep a table-level schema document that maps entity types to their GSI key values.

### 3. Sparse Index

**Problem:** You need to query a subset of items based on a status field — for example, all orders with `status=PENDING` for a fulfillment queue. Most orders are not pending; the majority have been shipped or completed.

**Solution:** Only write the GSI key attributes on items that should appear in the index. When an order moves out of PENDING status, remove the GSI key attributes. The item drops out of the index automatically on the next write.

```
Order created (PENDING):
  gsiStatusPK = "STATUS#PENDING"
  gsiStatusSK = "2024-01-15T10:30:00Z#o1"

Order shipped:
  Remove gsiStatusPK and gsiStatusSK attributes entirely
  (Item is now absent from the GSI)
```

The GSI contains only PENDING orders. Querying it with `PK=STATUS#PENDING` returns exactly the fulfillment queue — no filter needed, no wasted RCUs reading shipped orders.

**Key insight:** The index stays small because most items don't have the key attribute. Write costs are also lower because shipped/completed orders don't generate GSI writes (those attributes are gone).

### 4. Write Sharding for Hot GSI Partitions

**Problem:** A GSI partition key has very low cardinality and very high write volume — for example, a status field where most items are `STATUS#ACTIVE`. All active items hash to the same GSI partition, creating a write hot spot and potentially exceeding the 1,000 WCU per second per partition limit.

**Solution:** Append a random shard suffix to the GSI partition key to distribute writes across N partitions:

```python
import random

shard_count = 10
shard = random.randint(0, shard_count - 1)
gsi_pk = f"STATUS#ACTIVE#{shard}"  # e.g., "STATUS#ACTIVE#4"
```

Writes are now distributed across `STATUS#ACTIVE#0` through `STATUS#ACTIVE#9`. Each partition handles 1/10 of the write load.

**The cost:** Reading requires N parallel queries (one per shard) and merging the results client-side. This is the right tradeoff when write throughput is the constraint. Build the fan-out into your data access layer so callers don't have to know about sharding.

**When to use it:** High-write, low-cardinality GSI keys where you're hitting or approaching partition throughput limits. Don't add sharding pre-emptively — it adds read complexity. Add it when you have evidence of hot partition behavior in CloudWatch metrics (`ConsumedWriteCapacityUnits` by partition, `ThrottledWriteRequests`).

---

## GSI Cost Model

Understanding where GSI costs come from prevents surprises.

**Write cost:**
Every base table write that touches a GSI key attribute or a projected attribute triggers a GSI write. The WCU cost of that GSI write is based on the projected item size (rounded up to the nearest 1 KB).

For a table with 5 GSIs that each project `ALL` attributes, a single 500-byte item write costs:
- 1 WCU for the base table write
- 5 WCU for 5 GSI writes (each 500 bytes rounds up to 1 KB = 1 WCU)
- Total: 6 WCU per item write

If your write volume is 10,000 WPM, that's 60,000 WCUs consumed per minute instead of 10,000. At provisioned pricing, that's 6x the capacity cost.

**Read cost:**
GSI reads consume RCUs from the GSI's capacity. A GSI with `KEYS_ONLY` projection returns small items; a GSI with `ALL` projection returns large items. Larger items consume more RCUs per read.

**Idle cost:**
GSIs on provisioned tables require provisioned RCU/WCU even when idle. On-demand tables have no idle cost.

**Practical guidance:**
- Use `KEYS_ONLY` or `INCLUDE` instead of `ALL` unless you have a specific reason for `ALL`
- Audit GSI count vs. actual query usage — remove GSIs that are never queried
- Monitor `ConsumedWriteCapacityUnits` per GSI in CloudWatch to see which GSIs are expensive

---

## Limits

| Limit | Value |
|---|---|
| GSIs per table | 20 |
| LSIs per table | 5 |
| Attributes per GSI projection (`INCLUDE` mode) | 100 |
| GSI partition throughput limit | 1,000 WCU/sec, 3,000 RCU/sec per partition |
| GSI reads consistency | Eventually consistent only |

The 20 GSI limit is generous. If you approach it, the real problem is usually a base table key design that isn't serving enough access patterns natively. Revisit the design before adding more GSIs.

---

## Anti-Patterns

**`ALL` projection on every GSI.**
This is the most common and most expensive mistake. Developers add `ALL` to avoid thinking about projections, then are surprised by write costs at scale. Always ask what attributes the GSI access pattern actually needs.

**Too many GSIs on write-heavy tables.**
Each GSI adds WCU cost to every write. A table with 10 GSIs on a high-write workload (user events, clickstream, IoT telemetry) will see write costs balloon. For write-heavy tables, minimize GSI count aggressively. Consider whether the secondary access patterns could be served by a separate denormalized table written to in parallel rather than via GSIs.

**Using a GSI for something a base table `Query` could handle.**
If you can serve an access pattern by querying the base table directly with a SK condition (begins_with, between, comparison operators), do that. GSIs add write overhead and eventual consistency lag. The base table query is cheaper, strongly consistent (if needed), and avoids the replication delay.

Example: If your base table SK structure already sorts orders by date within a user partition, querying for "user's orders in January 2024" is `Query PK=USER#u1, SK between ORDER#2024-01-01 and ORDER#2024-01-31`. No GSI needed.

**Creating a GSI for every new access pattern without revisiting the key design.**
GSIs are not free. When a new access pattern arrives that the current schema can't serve, first ask: "Should the base table key design change?" This is a high-cost answer if the table already has data, but the question is worth asking before adding another GSI. Sometimes the better answer is a second table (for archival, reporting, or administrative access) rather than another GSI on the hot table.

**Ignoring GSI replication lag in application logic.**
Writing an item and immediately querying a GSI for that item will sometimes return stale results. Applications that write and then immediately read from a GSI must account for eventual consistency — either by reading from the base table for the immediate confirmation read, or by designing workflows that tolerate a short delay before the GSI reflects the write.
