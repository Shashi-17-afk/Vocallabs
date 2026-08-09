import { ApolloClient, InMemoryCache, createHttpLink, split } from '@apollo/client';
import { getMainDefinition } from '@apollo/client/utilities';
import { GraphQLWsLink } from '@apollo/client/link/subscriptions';
import { createClient } from 'graphql-ws';
import { nhost } from './nhost';

export function createApolloClient() {
  const httpUrl = process.env.NEXT_PUBLIC_HASURA_GRAPHQL_URL || 'http://localhost:8080/v1/graphql';
  const wsUrl = httpUrl.replace(/^http/, 'ws');

  const httpLink = createHttpLink({
    uri: httpUrl,
    headers: {
      get authorization() {
        const token = nhost.auth.getAccessToken();
        return token ? `Bearer ${token}` : '';
      },
    },
  });

  const wsLink = typeof window !== 'undefined'
    ? new GraphQLWsLink(
        createClient({
          url: wsUrl,
          connectionParams: () => {
            const token = nhost.auth.getAccessToken();
            return {
              headers: {
                Authorization: token ? `Bearer ${token}` : '',
              },
            };
          },
        })
      )
    : null;

  const splitLink = typeof window !== 'undefined' && wsLink
    ? split(
        ({ query }) => {
          const definition = getMainDefinition(query);
          return (
            definition.kind === 'OperationDefinition' &&
            definition.operation === 'subscription'
          );
        },
        wsLink,
        httpLink
      )
    : httpLink;

  return new ApolloClient({
    link: splitLink,
    cache: new InMemoryCache(),
  });
}
