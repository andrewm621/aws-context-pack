# DynamoDB Single-Table Design

## What It Is and Why

Single-table design (STD) is the practice of storing all entity types for an application in one DynamoDB table rather than creating a separate table per entity. A User, an Order, an OrderItem, and a Product all live in the same table — distinguished by their key structure, not by which table they're in.

This sounds wrong to anyone with a relational database background. It is intentional and it is the correct DynamoDB pattern when used appropriately.

**Why DynamoDB rewards this approach:**

DynamoDB pricing and performance are governed by partition-level throughput. When you issue a `Query` against a single partition, you pay for exactly what you read and get single-digit millisecond latency. When you need data that spans multiple entity types in a relational model — say, a user and all their orders — a relational JOIN is "free" in terms of round trips. In DynamoDB, fetching from two separate tables requires two separate requests. Single-table design lets you co-locate related entities under the same partition key, so one `Query` returns a user record and all their orders together.

**The core mechanic:** DynamoDB's PK+SK structure is a general-purpose sorting and grouping mechanism. You define what those keys *mean* for each entity type. A PK of `USER#123` might have SK values of `METADATA`, `ORDER#456`, `ORDER#789` — letting you fetch the user profile and all their orders with a single `Query` on that partition.

---

## When to Use Single-Table Design

Single-table design pays off when:

- **Access patterns are known and stable.** STD requires designing your keys around your queries. If you know you need "get user + their last 10 orders" and "get all orders for a product," you can design for it. If access patterns are a moving target, the design will break.
- **Read-heavy workloads.** STD shines at eliminating round trips. The more your hot paths are reads that join multiple entity types, the more you benefit.
- **Cost-sensitive scale.** At high request volume, eliminating even one DynamoDB request per API call compounds significantly. STD collapses multiple reads into one.
- **Teams that understand DynamoDB.** STD is not a beginner pattern. The payoff is real, but so is the learning curve and the cost of getting the key design wrong.

---

## When NOT to Use Single-Table Design

STD is frequently over-applied. Avoid it when:

- **Access patterns are frequently changing.** Every new access pattern that your key structure can't serve requires either a table scan (expensive) or a new GSI. If your product is in early discovery and your data model shifts monthly, STD creates rework rather than savings.
- **Small teams new to DynamoDB.** The mental overhead is real. A team that doesn't deeply understand partition design, hot keys, and GSI tradeoffs will make costly mistakes. Multiple tables with simple, obvious schemas is a legitimate choice — don't let STD dogma override good judgment.
- **Simple CRUD applications.** If you have five entity types and every access pattern is "get entity by ID" or "list all entities of type X," multiple tables with simple keys are easier to reason about, easier to debug, and cost-equivalent.
- **When you need ad-hoc querying.** DynamoDB is not a query engine. If business stakeholders need flexible reporting or you don't know your access patterns at design time, use RDS or Aurora and let DynamoDB serve specific hot paths.
- **Regulatory or data isolation requirements.** Separate tables give you fine-grained IAM, independent backup/restore, and table-level encryption key control. When isolation matters more than performance, separate tables are the right answer.

---

## Design Process

Follow this sequence. Do not skip steps or reverse them.

### Step 1: List All Entities

Write down every data entity your application manages. For an e-commerce application:

- User
- Order
- OrderItem
- Product
- ProductCategory

### Step 2: List All Access Patterns

Write down every query your application will make, in plain English. Be exhaustive.

```
1.  Get user by user ID
2.  Get all orders for a user (most recent first)
3.  Get a single order by order ID
4.  Get all items in an order
5.  Get all orders containing a specific product
6.  Get product by product ID
7.  Get all products in a category
8.  Get order count for a user (for display in profile)
9.  Get all open orders (status = PENDING) for fulfillment team
10. Get order history for a date range
```

This list is the specification your key design must satisfy.

### Step 3: Design PK/SK to Serve the Most Patterns

Look at your access patterns and find the groupings. Patterns 1, 2, and 8 all start with "for a given user." That tells you USER#\{userId\} should be a partition key. Patterns 3 and 4 both start with "for a given order." That suggests ORDER#\{orderId\} as a partition key.

Design the main table keys to serve as many patterns as possible without GSIs:

| Entity | PK | SK |
|---|---|---|
| User | `USER#\{userId\}` | `METADATA` |
| Order | `USER#\{userId\}` | `ORDER#\{orderId\}` |
| OrderItem | `ORDER#\{orderId\}` | `ITEM#\{productId\}` |
| Product | `PRODUCT#\{productId\}` | `METADATA` |
| ProductCategory | `CATEGORY#\{categoryId\}` | `PRODUCT#\{productId\}` |

With this structure:
- Pattern 1: `GetItem` PK=`USER#123`, SK=`METADATA`
- Pattern 2: `Query` PK=`USER#123`, SK begins_with `ORDER#` (sorted by order ID, which can embed timestamps)
- Pattern 3: `Query` PK=`ORDER#456`, SK=`ITEM#*` (but wait — order metadata needs its own record)
- Pattern 4: `Query` PK=`ORDER#456`, SK begins_with `ITEM#`

Notice the tension: an Order appears in the user partition (SK = `ORDER#456`) but its items live in an order partition (PK = `ORDER#456`). This is normal. An entity can have a record in multiple partitions for different access patterns — as long as you keep them in sync on writes.

### Step 4: Add GSIs for Remaining Patterns

Patterns that the base table can't serve become GSI candidates. Patterns 5, 7, and 9 from the example can't be served by the base table design above — they need GSIs.

---

## E-Commerce Example: Full Key Structure

### Base Table

| Entity | PK | SK | Attributes |
|---|---|---|---|
| User | `USER#u1` | `METADATA` | name, email, createdAt |
| Order (on user) | `USER#u1` | `ORDER#2024-01-15#o1` | orderId, status, total |
| Order (own record) | `ORDER#o1` | `METADATA` | userId, status, total, createdAt |
| OrderItem | `ORDER#o1` | `ITEM#p1` | productId, quantity, price |
| Product | `PRODUCT#p1` | `METADATA` | name, categoryId, price, stock |
| Category → Product | `CATEGORY#electronics` | `PRODUCT#p1` | productId, name, price |

The `ORDER#2024-01-15#o1` SK embeds a timestamp prefix so that `Query` on `USER#u1` with SK beginning_with `ORDER#` returns orders sorted chronologically.

### GSI 1: Order Lookup by Order ID (Inverted Index)

Some access patterns need to start from an order ID without knowing the user ID. Add a GSI:

| GSI1PK | GSI1SK | (projected) |
|---|---|---|
| `ORDER#o1` | `USER#u1` | orderId, userId, status, total |

This is populated on Order records stored under the user partition. The GSI inverts the relationship.

### GSI 2: Orders by Status (Sparse Index)

Fulfillment needs all `PENDING` orders. Add a sparse index where only items with `gsi2pk` attribute appear:

| Entity | GSI2PK | GSI2SK |
|---|---|---|
| Order (status=PENDING) | `STATUS#PENDING` | `\{createdAt\}#\{orderId\}` |
| Order (status=SHIPPED) | *(attribute absent — not in index)* | |

When an order ships, remove `gsi2pk` and `gsi2sk` attributes. The record drops out of the index automatically.

---

## Key Patterns

### Composite Keys

Composite keys combine a type prefix with an identifier using a delimiter:

```
USER#f47ac10b-58cc-4372-a567-0e02b2c3d479
ORDER#2024-01-15T10:30:00Z#o1
ITEM#p1
```

The type prefix (`USER#`, `ORDER#`) allows:
- All entity types to coexist in one table without key collisions
- begins_with queries to filter by entity type within a partition
- Human-readable keys that simplify debugging

The timestamp in SK prefixes (`ORDER#2024-01-15#`) enables chronological sorting within a `Query`.

### GSI Overloading

Rather than creating a GSI per entity type, use generic attribute names (`GSI1PK`, `GSI1SK`) and populate them differently per entity type. One GSI serves lookups across multiple entity types:

| Entity | GSI1PK | GSI1SK |
|---|---|---|
| Order | `STATUS#PENDING` | `2024-01-15#o1` |
| Product | `CATEGORY#electronics` | `PRODUCT#p1` |
| User | `EMAIL#user@example.com` | `USER#u1` |

A single GSI with `GSI1PK` and `GSI1SK` handles order-by-status lookups, product-by-category lookups, and user-by-email lookups. The "overloading" is the reuse of the same GSI attribute names for semantically different purposes.

### Sparse Indexes

A sparse index is a GSI that only contains a subset of table items — specifically, those where the GSI key attributes exist. Items without those attributes don't appear in the GSI at all.

Use cases:
- Active records only (items with `status=ACTIVE` have a `gsiActiveKey`; completed items don't)
- Flagged items for review queues
- Items pending action that should auto-remove from the index when processed

Sparse indexes are cost-efficient because the GSI only stores a fraction of the base table's data.

### Adjacency List Pattern

For hierarchical or graph-like data (A belongs to B, B belongs to C), the adjacency list pattern stores both "parent has children" and "child knows its parent" in the same table:

```
PK=USER#u1,    SK=USER#u1       → User record (self-reference)
PK=USER#u1,    SK=ORDER#o1      → User owns Order
PK=ORDER#o1,   SK=ORDER#o1      → Order record (self-reference)
PK=ORDER#o1,   SK=ITEM#i1       → Order contains Item
PK=ORDER#o1,   SK=ITEM#i2       → Order contains Item
```

Querying `PK=ORDER#o1` returns the order itself plus all its items. The self-reference record at SK=`ORDER#o1` carries the full order metadata.

---

## Common Mistakes

**Over-indexing (more than 5 GSIs as a warning sign, hard limit is 20).** If you're adding a new GSI for each access pattern, your base table key design is probably wrong. GSIs add write cost and complexity. Revisit the key design first.

**Not planning for writes.** Every GSI write is a separate capacity consumption event. A table with 5 GSIs that all project ALL attributes means a single item write costs 6x the base write (1 base + 5 GSI). Model your write costs before finalizing GSI count.

**Ignoring hot partitions.** If millions of users are querying the same partition key — say, a `STATUS#PENDING` GSI partition that holds all pending orders — you'll hit throughput limits. Write sharding (appending a random suffix like `STATUS#PENDING#3`) distributes load across multiple partitions at the cost of requiring parallel queries to retrieve all items.

**Fetching items you don't need.** `Query` with broad `begins_with` on SK can return thousands of items when you need ten. Use `Limit`, `FilterExpression` (post-fetch filter, not a pre-fetch index), and tighter SK ranges to control result set size.

**Treating STD as all-or-nothing.** Nothing prevents having one single-table design for your hot, well-understood access patterns and separate tables for reporting, archival, or administrative use cases. Mix as needed.
