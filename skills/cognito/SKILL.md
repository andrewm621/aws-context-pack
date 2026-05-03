---
name: cognito
description: Amazon Cognito guidance — user pools, identity pools, hosted UI, OAuth/OIDC, JWT tokens, MFA, custom auth flows, federation. Use when implementing authentication and authorization with AWS.
metadata:
  priority: 5
  docs:
    - "https://docs.aws.amazon.com/cognito/latest/developerguide/"
  pathPatterns:
    - 'auth/**'
    - 'cognito/**'
  bashPatterns:
    - '\baws\s+cognito-idp\b'
    - '\baws\s+cognito-identity\b'
  importPatterns:
    - "@aws-sdk/client-cognito-identity-provider"
    - "@aws-sdk/client-cognito-identity"
    - "aws-cdk-lib/aws-cognito"
    - "amazon-cognito-identity-js"
  promptSignals:
    phrases:
      - "cognito"
      - "user pool"
      - "identity pool"
      - "cognito auth"
      - "hosted ui"
      - "cognito jwt"
      - "cognito mfa"
      - "cognito federation"
      - "cognito trigger"
      - "aws authentication"
---

## What It Is & When to Use It

Amazon Cognito is AWS's managed authentication and authorization service. It splits into two distinct products that are often used together but solve different problems.

**User Pools** are user directories. They handle everything related to your users' identities: sign-up, sign-in, email/phone verification, password policies, MFA, account recovery, and token issuance. A User Pool is also an OAuth 2.0 / OIDC server — it issues ID tokens, access tokens, and refresh tokens that your application uses to authenticate API calls. You do not need to write any backend authentication logic; Cognito handles the full auth lifecycle.

**Identity Pools** (formerly Federated Identities) solve a different problem: granting temporary AWS credentials to users so they can call AWS services directly from client-side code. An Identity Pool accepts a token from a trusted source (a Cognito User Pool, Google, Facebook, Apple, SAML, or an OIDC provider), then calls STS AssumeRoleWithWebIdentity and returns short-lived IAM credentials. This is what lets a browser app upload directly to S3 or query DynamoDB without routing through your backend.

Most applications use a User Pool alone. They add an Identity Pool only when clients need direct AWS service access.

**When to choose Cognito:**
- You are building on AWS and want authentication that integrates natively with API Gateway, AppSync, ALB, and IAM policies
- You need direct AWS resource access from client-side code (requires Identity Pool)
- You are comfortable with the operational model (managed service, limited DX customization)
- Cost matters at scale — Cognito is extremely cheap for high-volume apps

**When to consider alternatives:**

| Scenario | Better choice | Reason |
|---|---|---|
| Rich pre-built UI components, excellent DX | Auth0 or Clerk | Cognito's hosted UI is minimal; Amplify UI is better but opinionated |
| Employee/workforce SSO | IAM Identity Center (SSO) | Built for SAML/OIDC enterprise federation; not end-user auth |
| Multi-tenant SaaS with complex org structures | Auth0 Organizations or WorkOS | Cognito has no native tenant/org model |
| Fully custom auth without SRP overhead | Custom JWT issuer | Cognito forces specific auth flows; CUSTOM_AUTH adds Lambda latency |
| Mobile apps with Amplify | Cognito + Amplify Libraries | First-class support; libraries handle token refresh, storage, social sign-in |

---

## Service Surface

### User Pools vs Identity Pools

| Dimension | User Pool | Identity Pool |
|---|---|---|
| Primary function | User directory + OAuth/OIDC server | Temporary AWS credential vending |
| Issues | ID token, access token, refresh token (JWTs) | STS credentials (access key, secret key, session token) |
| Backed by | Cognito-managed user store | IAM roles + STS |
| Supports social login | Yes (via Hosted UI federation) | Yes (directly or via User Pool token) |
| Required together? | No | No — but common pairing |
| Auth flows | SRP, password, custom, SAML/OIDC federation | Exchange any trusted identity token for IAM creds |

### Pricing

| Tier | Cost |
|---|---|
| First 50,000 MAU | Free |
| 50,001 – 100,000 MAU | $0.0055 / MAU |
| 100,001 – 1,000,000 MAU | $0.0046 / MAU |
| 1,000,001 + MAU | $0.0032 / MAU |
| SAML / OIDC federation MAU | $0.015 / MAU (replaces standard rate) |
| Advanced security features | $0.050 / MAU (adaptive auth, compromised credentials) |
| SMS MFA | Standard SNS rates (~$0.00645/message in US) |

Identity Pools: free up to 50,000 MAU, then same tiered pricing as User Pools.

### Key Limits

| Resource | Limit | Notes |
|---|---|---|
| User pools per account | 1,000 | Soft limit; can request increase |
| App clients per pool | 500 | Was 50 — increased in 2023 |
| Custom attributes per pool | 50 | Cannot be deleted or renamed after creation |
| Groups per pool | 10,000 | No nested groups |
| Users per pool | Unlimited (practical limit ~40M) | |
| Admin API rate limit | 5–50 req/sec depending on action | InitiateAuth is 25/sec by default |
| Email send rate (Cognito SES) | 50 emails/day | Use your own SES for production |
| Lambda trigger timeout | 5 seconds | Sync triggers; auth fails if trigger times out |

### Token Types

| Token | Contains | Default TTL | Use |
|---|---|---|---|
| ID token | User claims (sub, email, phone, groups, custom attributes) | 1 hour | Authenticate to your application; verify user identity |
| Access token | Scopes, groups, username, client_id | 1 hour | Call API Gateway / AppSync authorized with Cognito; call Cognito's own UserInfo endpoint |
| Refresh token | Opaque | 30 days | Exchange for new ID + access tokens without re-authentication |

All three are JWTs (RS256 signed). Verify with the pool's JWKS endpoint: `https://cognito-idp.{region}.amazonaws.com/{userPoolId}/.well-known/jwks.json`

### Auth Flows

| Flow | Use case | Security notes |
|---|---|---|
| `USER_SRP_AUTH` | Default; password never leaves client | Uses Secure Remote Password protocol — recommended |
| `USER_PASSWORD_AUTH` | Simpler but sends password to Cognito | Only use server-side or for migration |
| `CUSTOM_AUTH` | Passwordless OTP, magic links, biometric | Fully customizable via Lambda triggers |
| `ADMIN_USER_PASSWORD_AUTH` | Server-side admin auth | Requires secret; never use client-side |
| `REFRESH_TOKEN_AUTH` | Token renewal | Standard; always implement this |

---

## Mental Model

Cognito has five core primitives. Understand these and everything else follows.

### 1. User Pool — User Directory + OAuth Server

A User Pool is two things fused together: a database of users, and a fully compliant OAuth 2.0 / OIDC authorization server. You configure it once (username type, password policy, MFA requirements, attribute schema) and it handles the full authentication lifecycle.

When a user signs in, the User Pool runs the SRP challenge exchange, validates credentials, evaluates MFA, runs any triggers, then issues three JWTs. Your app receives these tokens and uses them to prove identity — to your own API, to API Gateway, to AppSync, or to an Identity Pool.

The User Pool's OIDC discovery endpoint (`/.well-known/openid-configuration`) makes it compatible with any standard OIDC library.

### 2. Identity Pool — AWS Credential Vending Machine

An Identity Pool does not store users. It takes a token from a trusted identity source and calls STS on your behalf, returning temporary IAM credentials (15-minute to 12-hour lifetime).

Two modes:
- **Authenticated:** User provides a valid token (from User Pool or social provider). Identity Pool maps it to an IAM role. STS credentials let the client call AWS services directly.
- **Unauthenticated (guest):** No token required. Maps to a separate, restricted IAM role. Use for guest access to public resources.

The IAM policies attached to those roles control what AWS services the user can touch. You can use IAM policy variables like `${cognito-identity.amazonaws.com:sub}` to scope access per-user (e.g., a user can only read their own S3 prefix).

### 3. App Client — OAuth Client Configuration

An App Client is the OAuth client that talks to your User Pool. Each app (web, iOS, Android, backend service) gets its own App Client with its own settings:
- Client ID (always present) and optional client secret (server-side only)
- Allowed OAuth flows (Authorization Code, Implicit, Client Credentials)
- Allowed scopes
- Callback and logout URLs
- Token validity settings (can differ per client)

Multiple App Clients per pool is the standard pattern for multi-platform apps. A mobile app client might have no secret and use PKCE; a backend service client might use Client Credentials flow for machine-to-machine auth.

### 4. Triggers — Lambda Hooks at Every Auth Step

Triggers are Lambda functions Cognito invokes synchronously at specific points in the auth lifecycle. They let you customize behavior without forking or replacing Cognito.

Key triggers and their use cases:

| Trigger | When it fires | Common use |
|---|---|---|
| Pre Sign-up | Before user is created | Block domains, pre-approve users, auto-confirm |
| Post Confirmation | After email/phone verified | Create user record in your DB |
| Pre Authentication | Before auth challenge | Check if user is allowed to sign in (rate limit, ban) |
| Post Authentication | After successful auth | Audit log, analytics |
| Pre Token Generation | Before tokens issued | Add custom claims to ID/access token |
| Custom Message | Before sending email/SMS | Branded verification emails |
| Migrate User | When user not found in pool | Transparent migration from legacy auth |
| Define / Create / Verify Auth Challenge | Custom auth flow steps | Passwordless OTP, magic links |

Triggers must respond within 5 seconds or the auth operation fails. Keep them fast — avoid cold starts on every auth call by using provisioned concurrency for high-traffic auth flows.

### 5. Hosted UI — Cognito's Built-in Login Page

The Hosted UI is a Cognito-managed web interface for sign-in, sign-up, MFA, password reset, and social/SAML federation. It lives at `https://{domain}.auth.{region}.amazoncognito.com/`.

Customization is limited to: a logo, custom CSS, and your domain (custom domain with ACM cert or `*.auth.region.amazoncognito.com` subdomain). The HTML structure is fixed.

Use the Hosted UI when:
- You need social federation or SAML and don't want to implement the OAuth dance yourself
- You want the fastest path to a working auth flow
- You don't have strong branding requirements on the auth page

Use custom UI (Amplify Libraries or raw SDK) when:
- Your auth page must match your app's design
- You need progressive profiling or multi-step sign-up flows
- You want full control over the UX

---

## Common Patterns

### Pattern 1: User Pool with MFA and Password Policy (CDK)

```typescript
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as cdk from 'aws-cdk-lib';

export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.userPool = new cognito.UserPool(this, 'AppUserPool', {
      userPoolName: 'my-app-user-pool',

      // Sign-in options — CANNOT change after creation
      signInAliases: {
        email: true,
        username: false, // email-only sign-in
      },
      // Case sensitivity for email — CANNOT change after creation
      signInCaseSensitive: false,

      // Self-registration
      selfSignUpEnabled: true,
      autoVerify: { email: true },

      // Attribute schema — custom attributes cannot be removed after creation
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: false, mutable: true },
      },
      customAttributes: {
        tenantId: new cognito.StringAttribute({ mutable: false }),
        role: new cognito.StringAttribute({ mutable: true }),
      },

      // Password policy
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: cdk.Duration.days(3),
      },

      // MFA — can be made stricter but not looser after creation
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: {
        sms: true,
        otp: true, // TOTP authenticator apps
      },

      // Account recovery
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,

      // Use your own SES for production — Cognito's default is 50 emails/day
      email: cognito.UserPoolEmail.withSES({
        fromEmail: 'no-reply@example.com',
        fromName: 'My App',
        sesRegion: 'us-east-1',
      }),

      // Removal policy — RETAIN in production
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // App client for web application (no secret, PKCE)
    this.userPoolClient = this.userPool.addClient('WebClient', {
      userPoolClientName: 'web-client',
      generateSecret: false,

      // Token validity
      idTokenValidity: cdk.Duration.hours(1),
      accessTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      enableTokenRevocation: true,

      // Auth flows
      authFlows: {
        userSrp: true,        // Standard; recommended
        userPassword: false,  // Only enable if needed
        custom: false,
      },

      // OAuth
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: false,
        },
        scopes: [
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: ['https://example.com/callback', 'http://localhost:3000/callback'],
        logoutUrls: ['https://example.com/', 'http://localhost:3000/'],
      },

      preventUserExistenceErrors: true, // Don't leak whether email is registered
    });

    // Hosted UI domain
    this.userPool.addDomain('CognitoDomain', {
      cognitoDomain: { domainPrefix: 'my-app-auth' },
    });

    // Outputs
    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
  }
}
```

### Pattern 2: JWT Verification in API Middleware (AWS SDK v3 + aws-jwt-verify)

The recommended library for verifying Cognito JWTs in Node.js is `aws-jwt-verify` (published by AWS). It fetches JWKS automatically and caches them.

```bash
npm install aws-jwt-verify @aws-sdk/client-cognito-identity-provider
```

```typescript
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { CognitoIdentityProviderClient, GetUserCommand } from '@aws-sdk/client-cognito-identity-provider';

// Create verifier once at module level — it caches JWKS
const idTokenVerifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID!,
  clientId: process.env.COGNITO_CLIENT_ID!,
  tokenUse: 'id',
});

const accessTokenVerifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID!,
  clientId: process.env.COGNITO_CLIENT_ID!,
  tokenUse: 'access',
});

// Express/Hono middleware example
export async function requireAuth(req: Request): Promise<CognitoJwtPayload> {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Missing or malformed Authorization header');
  }

  const token = authHeader.slice(7);

  try {
    // Verify signature, expiry, audience, issuer
    const payload = await accessTokenVerifier.verify(token);
    return payload;
  } catch (err) {
    throw new Error('Invalid or expired token');
  }
}

// Extract typed claims from ID token
interface AppClaims {
  sub: string;
  email: string;
  'custom:tenantId': string;
  'cognito:groups': string[];
}

export async function getUserClaims(idToken: string): Promise<AppClaims> {
  const payload = await idTokenVerifier.verify(idToken);
  return payload as unknown as AppClaims;
}

// Call Cognito UserInfo endpoint with access token (avoids re-verifying JWT)
const cognitoClient = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION!,
});

export async function getCurrentUser(accessToken: string) {
  const command = new GetUserCommand({ AccessToken: accessToken });
  const response = await cognitoClient.send(command);
  return response.UserAttributes?.reduce(
    (acc, attr) => ({ ...acc, [attr.Name!]: attr.Value }),
    {} as Record<string, string>
  );
}
```

### Pattern 3: Custom Auth Flow — Passwordless OTP via Lambda Triggers

Three Lambda triggers work together: `DefineAuthChallenge`, `CreateAuthChallenge`, `VerifyAuthChallenge`.

```typescript
// Lambda: define-auth-challenge.ts
// Controls the state machine — what challenge comes next
import { DefineAuthChallengeTriggerHandler } from 'aws-lambda';

export const handler: DefineAuthChallengeTriggerHandler = async (event) => {
  const sessions = event.request.session;

  if (sessions.length === 0) {
    // Start: issue OTP challenge
    event.response.challengeName = 'CUSTOM_CHALLENGE';
    event.response.issueTokens = false;
    event.response.failAuthentication = false;
  } else if (
    sessions.length === 1 &&
    sessions[0].challengeName === 'CUSTOM_CHALLENGE' &&
    sessions[0].challengeResult === true
  ) {
    // OTP was correct — issue tokens
    event.response.issueTokens = true;
    event.response.failAuthentication = false;
  } else {
    // Failed or too many attempts
    event.response.issueTokens = false;
    event.response.failAuthentication = true;
  }

  return event;
};
```

```typescript
// Lambda: create-auth-challenge.ts
// Generates and sends the OTP
import { CreateAuthChallengeTriggerHandler } from 'aws-lambda';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';

const snsClient = new SNSClient({ region: process.env.AWS_REGION });
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });

export const handler: CreateAuthChallengeTriggerHandler = async (event) => {
  // Only create OTP on first challenge
  if (event.request.session.length === 0) {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = (Date.now() + 5 * 60 * 1000).toString(); // 5 minutes

    // Store OTP in DynamoDB for verification
    await dynamoClient.send(new PutItemCommand({
      TableName: process.env.OTP_TABLE!,
      Item: {
        userId: { S: event.userName },
        otp: { S: otp },
        expiry: { N: expiry },
      },
    }));

    // Send OTP via SNS (SMS) or SES (email)
    const phone = event.request.userAttributes.phone_number;
    await snsClient.send(new PublishCommand({
      PhoneNumber: phone,
      Message: `Your verification code is ${otp}. Valid for 5 minutes.`,
    }));

    event.response.publicChallengeParameters = { destination: phone };
    event.response.privateChallengeParameters = { userId: event.userName };
    event.response.challengeMetadata = 'OTP_CHALLENGE';
  }

  return event;
};
```

```typescript
// Lambda: verify-auth-challenge.ts
// Validates the OTP the user submitted
import { VerifyAuthChallengeResponseTriggerHandler } from 'aws-lambda';
import { DynamoDBClient, GetItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });

export const handler: VerifyAuthChallengeResponseTriggerHandler = async (event) => {
  const userId = event.request.privateChallengeParameters.userId;
  const submittedOtp = event.request.challengeAnswer;

  const result = await dynamoClient.send(new GetItemCommand({
    TableName: process.env.OTP_TABLE!,
    Key: { userId: { S: userId } },
  }));

  const storedOtp = result.Item?.otp?.S;
  const expiry = Number(result.Item?.expiry?.N ?? 0);
  const isValid = storedOtp === submittedOtp && Date.now() < expiry;

  event.response.answerCorrect = isValid;

  if (isValid) {
    // Clean up used OTP
    await dynamoClient.send(new DeleteItemCommand({
      TableName: process.env.OTP_TABLE!,
      Key: { userId: { S: userId } },
    }));
  }

  return event;
};
```

```typescript
// Client: initiating the custom auth flow
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const client = new CognitoIdentityProviderClient({ region: 'us-east-1' });

async function signInPasswordless(email: string, otp: string) {
  // Step 1: Initiate CUSTOM_AUTH flow
  const initiateResponse = await client.send(new InitiateAuthCommand({
    AuthFlow: 'CUSTOM_AUTH',
    ClientId: process.env.COGNITO_CLIENT_ID!,
    AuthParameters: { USERNAME: email },
  }));

  const session = initiateResponse.Session!;

  // Step 2: Respond with OTP
  const authResponse = await client.send(new RespondToAuthChallengeCommand({
    ClientId: process.env.COGNITO_CLIENT_ID!,
    ChallengeName: 'CUSTOM_CHALLENGE',
    Session: session,
    ChallengeResponses: {
      USERNAME: email,
      ANSWER: otp,
    },
  }));

  return authResponse.AuthenticationResult;
  // { IdToken, AccessToken, RefreshToken, ExpiresIn }
}
```

### Pattern 4: Identity Pool for Direct S3 Access from Browser

```typescript
// CDK: identity pool + S3 bucket with per-user prefix
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cognitoIdentity from '@aws-cdk/aws-cognito-identitypool-alpha'; // or CfnIdentityPool

const userFileBucket = new s3.Bucket(this, 'UserFiles', {
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  encryption: s3.BucketEncryption.S3_MANAGED,
});

// IAM role for authenticated users
const authenticatedRole = new iam.Role(this, 'CognitoAuthRole', {
  assumedBy: new iam.FederatedPrincipal(
    'cognito-identity.amazonaws.com',
    {
      StringEquals: { 'cognito-identity.amazonaws.com:aud': identityPoolId },
      'ForAnyValue:StringLike': { 'cognito-identity.amazonaws.com:amr': 'authenticated' },
    },
    'sts:AssumeRoleWithWebIdentity'
  ),
});

// Per-user S3 access — ${cognito-identity.amazonaws.com:sub} resolves at runtime
authenticatedRole.addToPolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
  resources: [
    `${userFileBucket.bucketArn}/private/\${cognito-identity.amazonaws.com:sub}/*`,
  ],
}));

// List only the user's own prefix
authenticatedRole.addToPolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['s3:ListBucket'],
  resources: [userFileBucket.bucketArn],
  conditions: {
    StringLike: {
      's3:prefix': ['private/${cognito-identity.amazonaws.com:sub}/*'],
    },
  },
}));
```

```typescript
// Client: exchange Cognito ID token for AWS credentials, then upload to S3
import {
  CognitoIdentityClient,
  GetIdCommand,
  GetCredentialsForIdentityCommand,
} from '@aws-sdk/client-cognito-identity';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

async function uploadUserFile(idToken: string, file: File, userId: string) {
  const identityClient = new CognitoIdentityClient({ region: 'us-east-1' });

  // Step 1: Get an identity ID for this user
  const { IdentityId } = await identityClient.send(new GetIdCommand({
    IdentityPoolId: process.env.IDENTITY_POOL_ID!,
    AccountId: process.env.AWS_ACCOUNT_ID!,
    Logins: {
      [`cognito-idp.us-east-1.amazonaws.com/${process.env.USER_POOL_ID}`]: idToken,
    },
  }));

  // Step 2: Exchange identity ID + token for IAM credentials
  const { Credentials } = await identityClient.send(new GetCredentialsForIdentityCommand({
    IdentityId: IdentityId!,
    Logins: {
      [`cognito-idp.us-east-1.amazonaws.com/${process.env.USER_POOL_ID}`]: idToken,
    },
  }));

  // Step 3: Use temporary credentials for S3
  const s3Client = new S3Client({
    region: 'us-east-1',
    credentials: {
      accessKeyId: Credentials!.AccessKeyId!,
      secretAccessKey: Credentials!.SecretKey!,
      sessionToken: Credentials!.SessionToken!,
    },
  });

  await s3Client.send(new PutObjectCommand({
    Bucket: process.env.USER_FILES_BUCKET!,
    Key: `private/${userId}/${file.name}`,
    Body: await file.arrayBuffer(),
    ContentType: file.type,
  }));
}
```

---

## Gotchas

**1. Several User Pool settings are immutable after creation.**
Username attributes (whether sign-in uses email, phone number, or username), username case sensitivity, and MFA cannot be loosened after the pool is created. Plan your username strategy before deploying. Migrating users to a new pool is painful — it requires the Migrate User trigger and careful orchestration.

**2. Custom attributes cannot be removed or renamed.**
You can add custom attributes at any time, but never remove them. Once `custom:tenantId` exists, it exists forever on every user in that pool. Use generic names if you're unsure, and think carefully before adding anything you might regret.

**3. Default email sending will block you in production.**
Cognito's built-in email uses a shared SES pool limited to 50 verification emails per day. Hit that limit and users cannot sign up. Always configure your own SES identity before launching. This takes SES out of sandbox mode (requires AWS support request) and configuring it in the User Pool.

**4. Lambda trigger timeouts fail auth operations.**
Every trigger has a hard 5-second timeout. If your trigger takes longer (slow DB query, cold start, third-party API call), Cognito rejects the auth operation and the user sees an error. Use Lambda provisioned concurrency for any trigger on a high-traffic auth path. Keep trigger logic minimal and async-safe.

**5. Token expiry defaults are often wrong for your use case.**
The default 1-hour access/ID token is reasonable. The default 30-day refresh token is very long — consider shortening it for sensitive applications. You cannot rotate refresh tokens on a schedule in Cognito; implement your own session management at the app layer if needed. Token validity is configurable per App Client.

**6. Groups are flat — no nesting.**
Cognito groups cannot contain other groups. If you have `admin > manager > user` hierarchy, you cannot express it natively. Workaround: use the Pre Token Generation trigger to add a custom claim (`custom:effectiveRole`) that your app logic reads. The trigger can query your database and set the claim based on your own hierarchy rules.

**7. Admin API rate limits are low and not adjustable by default.**
`AdminGetUser`, `AdminCreateUser`, `AdminDisableUser`, and similar admin APIs default to 5–25 requests/second depending on the operation. If you're doing bulk user operations (import, sync, reports), you will hit these limits. Use the native bulk import via CSV (`AdminCreateUser` in bulk mode) for initial imports, and implement exponential backoff for admin API calls.

**8. SAML federation misconfiguration is the most common support issue.**
The SAML IdP must trust Cognito's specific ACS (Assertion Consumer Service) URL: `https://{domain}.auth.{region}.amazoncognito.com/saml2/idpresponse`. The entity ID is the User Pool ARN. Get both of these exactly right in the IdP configuration. The NameID format must match what the IdP sends. When debugging SAML failures, enable Cognito's advanced security features temporarily — the event log shows exactly what failed.

**9. The Hosted UI cannot be deeply customized.**
What you can change: logo image, CSS stylesheet (applied to the existing HTML), and the domain. What you cannot change: HTML structure, JavaScript behavior, page flow, field layout, or error message copy beyond what the CSS can hide/override. If your design requirements go beyond "looks like Cognito with your logo and colors," build a custom UI with Amplify UI components or the raw SDK.

**10. Transparent user migration requires careful trigger design.**
The Migrate User trigger fires when a user is not found in the pool. Your trigger calls the legacy system to validate credentials, and if valid, Cognito creates the user. This is transparent to the user — they never know they were migrated. Gotchas: the trigger only fires for `USER_PASSWORD_AUTH` and `USER_SRP_AUTH` flows, not for social/SAML login. The migrated user starts unconfirmed unless you set `userAttributes['email_verified'] = 'true'` in the trigger response. Build idempotency — the trigger can fire multiple times for edge cases.

**11. `preventUserExistenceErrors` must be enabled on App Clients.**
By default, Cognito returns different errors for "user not found" vs "wrong password." This leaks whether an email is registered in your system. Enable `preventUserExistenceErrors: true` on every App Client. It normalizes all auth errors to a generic message. This is not the default — you must explicitly configure it.

**12. Refresh token rotation is not built in.**
Cognito does not automatically rotate refresh tokens. Once issued, a refresh token is valid until it expires or is explicitly revoked. If you need refresh token rotation (issue a new refresh token on every use, invalidate the old one), implement it at your API layer: call Cognito to get new tokens, then call `RevokeToken` on the old refresh token.

---

## Official Documentation

- **Developer Guide (main):** https://docs.aws.amazon.com/cognito/latest/developerguide/
- **User Pools API Reference:** https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/
- **Identity Pools API Reference:** https://docs.aws.amazon.com/cognitoidentity/latest/APIReference/
- **SDK v3 — CognitoIdentityProvider client:** https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/cognito-identity-provider/
- **SDK v3 — CognitoIdentity client:** https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/cognito-identity/
- **CDK API — aws-cognito module:** https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cognito-readme.html
- **aws-jwt-verify library (AWS-published):** https://github.com/awslabs/aws-jwt-verify
- **Pricing:** https://aws.amazon.com/cognito/pricing/
- **Service Quotas:** https://docs.aws.amazon.com/cognito/latest/developerguide/limits.html
- **Lambda Trigger Reference:** https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-identity-pools-working-with-aws-lambda-triggers.html
- **Token Claims Reference:** https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-with-identity-providers.html
- **SAML Federation Setup:** https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-saml-idp.html
