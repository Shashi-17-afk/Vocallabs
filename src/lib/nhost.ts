import { NhostClient } from '@nhost/nhost-js';

const subdomain = process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN || 'jpcetnwktzhavpkiyepi';
const region = process.env.NEXT_PUBLIC_NHOST_REGION || 'ap-south-1';
const graphqlUrl = process.env.NEXT_PUBLIC_HASURA_GRAPHQL_URL;
const authUrl = process.env.NEXT_PUBLIC_NHOST_AUTH_URL;

export const nhost = new NhostClient({
  subdomain,
  region,
  ...(authUrl ? { authUrl } : {}),
  ...(graphqlUrl ? { graphqlUrl } : {}),
});
