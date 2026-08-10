# Hasura Cloud JWT Configuration (Required Setup)

## Problem

The Hasura Cloud project (`enough-tetra-90.hasura.app`) requires the `HASURA_GRAPHQL_JWT_SECRET`
environment variable to be configured so that it can verify RS256 JWT tokens issued by Nhost Auth.

Without this, all authenticated GraphQL requests from the browser fail with:
```
"x-hasura-admin-secret"/"x-hasura-access-key" required, but not found
```

## Solution

### Step 1: Go to Hasura Cloud Console

Navigate to: https://cloud.hasura.io/project/enough-tetra-90/settings/env-vars

(Or: https://cloud.hasura.io/ → Select project `enough-tetra-90` → Settings → Env Vars)

### Step 2: Add Environment Variable

Add the following environment variable:

```
Name:  HASURA_GRAPHQL_JWT_SECRET
Value: {"type":"RS256","jwk_url":"https://jpcetnwktzhavpkiyepi.auth.ap-south-1.nhost.run/v1/.well-known/jwks.json","claims_format":"json"}
```

### Step 3: Save and Wait

Click **Add** / **Save**. Hasura Cloud will restart (~30 seconds).

### Step 4: Verify

After restart, run:
```bash
node scripts/check-hasura-jwt-config.js
```

Expected output:
```
✅ JWT PROPERLY CONFIGURED
```

---

## Why This Is Needed

The app uses a hybrid architecture:
- **Auth**: Nhost Auth Service issues RS256 JWTs with Hasura session claims
- **Database**: Supabase PostgreSQL 17.6 accessed via Hasura Cloud GraphQL Engine
- **Frontend**: Next.js + Apollo Client injects `Authorization: Bearer <jwt>` on every request

Hasura Cloud must be told to trust Nhost JWTs via the JWKS endpoint. This is standard
JWT configuration for cross-service auth.

---

## Nhost JWKS Details

- **JWKS URL**: `https://jpcetnwktzhavpkiyepi.auth.ap-south-1.nhost.run/v1/.well-known/jwks.json`
- **Algorithm**: RS256 (RSA)
- **Claims namespace**: `https://hasura.io/jwt/claims`
- **Claims format**: JSON

## JWT Claims Structure

```json
{
  "https://hasura.io/jwt/claims": {
    "x-hasura-user-id": "<user-uuid>",
    "x-hasura-default-role": "user",
    "x-hasura-allowed-roles": ["user", "me"],
    "x-hasura-user-is-anonymous": "false"
  }
}
```

---

## Alternative: Hasura Cloud API (if PAT is available)

If you have a Hasura Cloud Personal Access Token (PAT), you can configure this via the API:

```bash
curl -X POST https://data.hasura.io/v1/graphql \
  -H "Authorization: Bearer <PAT>" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation AddEnvVar($projectId: uuid!, $name: String!, $value: String!) { updateProjectEnv(projectId: $projectId, env: {name: $name, value: $value}) { id } }",
    "variables": {
      "projectId": "<project-uuid>",
      "name": "HASURA_GRAPHQL_JWT_SECRET",
      "value": "{\"type\":\"RS256\",\"jwk_url\":\"https://jpcetnwktzhavpkiyepi.auth.ap-south-1.nhost.run/v1/.well-known/jwks.json\",\"claims_format\":\"json\"}"
    }
  }'
```
