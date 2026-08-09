# Required Credentials and Environment Variables

The table below outlines all credentials, secrets, endpoints, and environment variables required for running and testing the AI Agent Workflow Builder application.

| Credential / Value | Why It Is Required | Where to Obtain It | Environment Variable Name | Required Now / Later | Client Safe / Server Only |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Nhost Subdomain / Region** | Nhost authentication backend URL & JWT issuer | Nhost Dashboard (`nhost.io`) | `NEXT_PUBLIC_NHOST_SUBDOMAIN` / `NEXT_PUBLIC_NHOST_REGION` | **REQUIRED NOW** | CLIENT SAFE |
| **Hasura GraphQL Endpoint** | Endpoint for GraphQL queries, mutations, subscriptions | Nhost / Hasura Console / Supabase Hasura deployment | `NEXT_PUBLIC_HASURA_GRAPHQL_URL` | **REQUIRED NOW** | CLIENT SAFE |
| **Supabase PostgreSQL URL** | Connection string for database migrations & server executor connection | Supabase Dashboard (`supabase.com`) Project Settings -> Database | `DATABASE_URL` / `SUPABASE_DB_URL` | **REQUIRED NOW** | **SERVER ONLY** |
| **Hasura Admin Secret** | Executing admin operations, applying migrations, metadata track | Hasura Console / Nhost Settings | `HASURA_GRAPHQL_ADMIN_SECRET` | **REQUIRED NOW** | **SERVER ONLY** |
| **Action Secret / Internal Secret** | Securing HTTP requests sent from Hasura Actions to server handlers | Configured in Hasura Action Header & `.env` | `ACTION_SECRET` | **REQUIRED LATER** (Phase 11) | **SERVER ONLY** |
| **Groq API Key** | Primary real LLM execution provider (`llm_call` step) | Groq Console (`console.groq.com`) | `GROQ_API_KEY` | **REQUIRED LATER** (Phase 9) | **SERVER ONLY** |
| **Gemini API Key** *(Fallback)* | Backup LLM API provider if Groq unavailable | Google AI Studio (`aistudio.google.com`) | `GEMINI_API_KEY` | **OPTIONAL** | **SERVER ONLY** |
| **Slack Webhook URL** | Testing `notify` step via Hasura Event Trigger | Slack API / App Incoming Webhooks | `SLACK_WEBHOOK_URL` | **OPTIONAL / PHASE 12** | **SERVER ONLY** |
