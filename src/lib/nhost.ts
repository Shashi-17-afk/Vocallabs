import { NhostClient } from '@nhost/nhost-js';

const subdomain = process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN || '';
const region = process.env.NEXT_PUBLIC_NHOST_REGION || '';
const graphqlUrl = process.env.NEXT_PUBLIC_HASURA_GRAPHQL_URL;
const authUrl = process.env.NEXT_PUBLIC_NHOST_AUTH_URL;

if (!subdomain && typeof window !== 'undefined') {
  console.warn('Missing NEXT_PUBLIC_NHOST_SUBDOMAIN environment variable.');
}

export const nhost = new NhostClient({
  subdomain: subdomain || 'local',
  region: region || 'local',
  ...(authUrl ? { authUrl } : {}),
  ...(graphqlUrl ? { graphqlUrl } : {}),
});
