---
name: dynamodb
description: Amazon DynamoDB guidance — NoSQL key-value and document database, single-table design, GSI patterns, capacity modes, streams. Use when designing, querying, or optimizing DynamoDB tables.
metadata:
  priority: 8
  docs:
    - "https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/"
    - "https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/best-practices.html"
  pathPatterns:
    - 'dynamodb/**'
    - 'tables/**'
    - '**/dynamodb*.ts'
    - '**/dynamodb*.js'
    - '**/table*.ts'
    - '**/table*.js'
  bashPatterns:
    - '\baws\s+dynamodb\b'
  importPatterns:
    - "@aws-sdk/client-dynamodb"
    - "@aws-sdk/lib-dynamodb"
    - "dynamoose"
    - "electrodb"
  promptSignals:
    phrases:
      - "dynamodb"
      - "dynamo db"
      - "partition key"
      - "sort key"
      - "single table design"
      - "global secondary index"
      - "gsi"
      - "nosql"
      - "dynamodb streams"
      - "on-demand capacity"
      - "provisioned capacity"
      - "hot partition"
validate:
  - pattern: 'import.*from.*[''"]aws-sdk[''"]'
    message: 'AWS SDK v2 detected — use @aws-sdk/client-dynamodb and @aws-sdk/lib-dynamodb (v3)'
    severity: error
  - pattern: 'new AWS\.DynamoDB\('
    message: 'AWS SDK v2 DynamoDB — use DynamoDBClient from @aws-sdk/client-dynamodb'
    severity: error
  - pattern: '\.scan\('
    message: 'DynamoDB Scan reads every item — prefer Query with partition key for performance'
    severity: recommended
---

# Amazon DynamoDB

## What It Is & When to Use It

Amazon DynamoDB is a fully managed NoSQL database delivering single-digit millisecond latency at any scale. It's a key-value and document store with automatic scaling, built-in security, and global replication. Use DynamoDB when you know your access patterns upfront, need consistent low-latency at scale, and can model data around partition/sort keys. Avoid it for ad-hoc queries, complex joins, or when access patterns are unknown (use a relational database instead).

## Service Surface

| Property | Value |
|----------|-------|
| **Item size max** | 400 KB |
| **Partition key max** | 2,048 bytes |
| **Sort key max** | 1,024 bytes |
| **GSIs per table** | 20 (soft limit, requestable to 25) |
| **LSIs per table** | 5 (must be created with the table, immutable) |
| **Max tables per region** | 2,500 (soft limit) |
| **Transaction items** | Up to 100 items per transaction |
| **Batch operations** | Up to 25 items per BatchWriteItem, 100 per BatchGetItem |

### Pricing (US East)

| Mode | Writes | Reads | Storage |
|------|--------|-------|---------|
| **On-Demand** | $1.25 per million WRU | $0.25 per million RRU | $0.25/GB-month |
| **Provisioned** | $0.00065 per WCU/hr | $0.00013 per RCU/hr | $0.25/GB-month |
| **Reserved (1yr)** | ~$0.000374 per WCU/hr | ~$0.000075 per RCU/hr | $0.25/GB-month |

**Free tier**: 25 GB storage + 25 WCU + 25 RCU (provisioned mode) always free.

**DynamoDB Streams**: $0.02 per 100,000 read requests. First 2.5M reads free.

**Global Tables**: Replicated WCU pricing is 1.875x standard WCU.

## Mental Model

1. **Partition key + Sort key = Primary key**: The partition key (PK) determines which partition stores the item. The optional sort key (SK) orders items within a partition. Together they uniquely identify an item. All queries must specify the PK — you cannot query without it.

2. **Access pattern first**: DynamoDB requires knowing your access patterns BEFORE designing the table. Unlike SQL, you can't add a new query pattern easily after the fact. Model your data around how it will be read, not how it's structured logically.

3. **Single-table design**: The pattern of storing multiple entity types (User, Order, Product) in one table using overloaded PK/SK values. Enables fetching related entities in a single query. Popularized by Rick Houlihan and Alex DeBrie.
   ```
   PK: USER#123        SK: METADATA          → User profile
   PK: USER#123        SK: ORDER#2024-001    → User's order
   PK: ORDER#2024-001  SK: ITEM#SKU-456      → Order line item
   ```

4. **GSI (Global Secondary Index)**: A full copy of the table with a different PK/SK. Has its own throughput (separate from base table). Eventually consistent only. The key pattern: invert your access — if you query by email, create a GSI with email as PK.

5. **Capacity modes**:
   - **On-Demand**: No capacity planning, auto-scales instantly. 2x cost but zero management. Best for unpredictable workloads or new tables.
   - **Provisioned**: You set WCU/RCU. Auto-scaling available but reacts slowly (2-3 min). Best for steady-state with predictable traffic.
   - Can switch between modes once every 24 hours.

## Common Patterns

### Basic CRUD with Document Client
```typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

// Initialize once outside handler (reused across invocations)
const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

// Put item
await docClient.send(new PutCommand({
  TableName: 'MyTable',
  Item: { PK: 'USER#123', SK: 'METADATA', name: 'Alice', email: 'alice@example.com' },
  ConditionExpression: 'attribute_not_exists(PK)', // prevent overwrite
}));

// Get item
const { Item } = await docClient.send(new GetCommand({
  TableName: 'MyTable',
  Key: { PK: 'USER#123', SK: 'METADATA' },
}));

// Query all orders for a user
const { Items } = await docClient.send(new QueryCommand({
  TableName: 'MyTable',
  KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
  ExpressionAttributeValues: { ':pk': 'USER#123', ':sk': 'ORDER#' },
}));
```

### Single-Table Design with GSI
```typescript
// Table design:
// PK          | SK               | GSI1PK        | GSI1SK          | data...
// USER#123    | METADATA         | alice@mail.com | USER#123        | name, etc.
// USER#123    | ORDER#2024-001   | ORDER#2024-001 | USER#123        | total, etc.
// ORDER#2024  | ITEM#SKU-456     | SKU-456        | ORDER#2024      | qty, price

// Query: Get user by email (via GSI1)
const { Items } = await docClient.send(new QueryCommand({
  TableName: 'MyTable',
  IndexName: 'GSI1',
  KeyConditionExpression: 'GSI1PK = :email',
  ExpressionAttributeValues: { ':email': 'alice@mail.com' },
}));
```

### DynamoDB Streams + Lambda (CDC)
```typescript
import { DynamoDBStreamEvent } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';

export const handler = async (event: DynamoDBStreamEvent) => {
  for (const record of event.Records) {
    if (record.eventName === 'INSERT' || record.eventName === 'MODIFY') {
      const newImage = unmarshall(record.dynamodb!.NewImage!);
      // Process the change...
      console.log('Changed item:', newImage);
    }
  }
};
```

### TTL for Automatic Cleanup
```typescript
// Set a TTL attribute (Unix timestamp in seconds)
await docClient.send(new PutCommand({
  TableName: 'Sessions',
  Item: {
    PK: `SESSION#${sessionId}`,
    SK: 'METADATA',
    userId: '123',
    ttl: Math.floor(Date.now() / 1000) + 86400, // expires in 24 hours
  },
}));
// DynamoDB automatically deletes expired items (within ~48 hours of TTL)
```

## Gotchas

1. **Hot partition throttling**: Even with sufficient total capacity, a single partition is limited to 3,000 RCU + 1,000 WCU. If one partition key value gets disproportionate traffic, requests throttle. Solutions: write sharding (add random suffix to PK), use on-demand mode, or distribute access patterns.

2. **GSI back-pressure throttles the base table**: If a GSI can't keep up with writes (its provisioned capacity is too low), DynamoDB throttles writes to the base table. Always provision GSI capacity >= base table write capacity.

3. **Scan is the enemy**: Scan reads every item in the table and consumes massive RCU. It's almost never the right approach. Design your key schema and GSIs so all access patterns use Query (requires PK) or GetItem.

4. **On-demand is 2x the price**: On-demand mode costs roughly twice provisioned mode at steady state. It's perfect for development, unpredictable traffic, or new tables. Switch to provisioned with auto-scaling once traffic patterns stabilize.

5. **Item collection size limit (with LSI)**: If you have LSIs, all items with the same partition key can't exceed 10 GB. This doesn't apply to tables without LSIs.

6. **Strongly consistent reads cost 2x and don't work on GSIs**: Strongly consistent reads consume double the RCU and are only available on the base table, not GSIs. GSIs are always eventually consistent.

7. **Transactions cost 2x**: Transactional reads/writes consume double the capacity units. Use transactions only when atomicity is required (financial operations, referential integrity).

8. **DynamoDB Streams retention is 24 hours**: Stream records are available for 24 hours. If your Lambda consumer falls behind, you lose data. For longer retention, pipe streams to Kinesis Data Streams.

9. **Adaptive capacity helps but isn't instant**: DynamoDB automatically redistributes capacity to hot partitions, but it takes 5-30 minutes to adapt. Sudden spikes still throttle.

10. **Reserved capacity is use-it-or-lose-it**: 1-year or 3-year commitment for provisioned mode. No refunds, no changes. Only commit after 3+ months of stable usage data.

11. **400 KB item limit is smaller than you think**: After adding attribute names, type descriptors, and DynamoDB overhead, effective payload is ~350 KB. Large items should store data in S3 and keep a reference in DynamoDB.

12. **GSI propagation is asynchronous**: Updates to the base table appear in GSIs with some delay (usually milliseconds, but can be longer under load). Don't rely on GSI for read-after-write consistency.

13. **Don't use single-table design for everything**: Single-table design is powerful for known, stable access patterns. But for rapidly evolving applications, simple tables per entity with GSIs are easier to reason about and modify. Alex DeBrie recommends starting simple.

## Official Documentation

- [DynamoDB Developer Guide](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/)
- [DynamoDB Best Practices](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/best-practices.html)
- [DynamoDB Pricing](https://aws.amazon.com/dynamodb/pricing/)
- [DynamoDB Guide (Alex DeBrie)](https://www.dynamodbguide.com/)
- [Single Table Design Patterns](https://www.alexdebrie.com/posts/dynamodb-single-table/)
