import { ApolloClient, InMemoryCache, split } from '@apollo/client';
import { setContext } from '@apollo/client/link/context';
import { HttpLink } from '@apollo/client/link/http';
import { getMainDefinition } from '@apollo/client/utilities';
import { GraphQLWsLink } from '@apollo/client/link/subscriptions';
import { createClient } from 'graphql-ws';
import { nhost } from './nhost';

export function createApolloClient() {
  const httpUrl = process.env.NEXT_PUBLIC_HASURA_GRAPHQL_URL || 'http://localhost:8080/v1/graphql';
  const wsUrl = httpUrl.replace(/^http/, 'ws');

  // Auth link — dynamically injects the Nhost Bearer JWT on every request.
  // If the Hasura Cloud instance does not yet have HASURA_GRAPHQL_JWT_SECRET configured,
  // the server will reject this token. Configure JWT in Hasura Cloud dashboard first.
  const authLink = setContext((_, { headers }) => {
    const token = nhost.auth.getAccessToken();
    return {
      headers: {
        ...headers,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    };
  });

  const httpLink = authLink.concat(
    new HttpLink({ uri: httpUrl })
  );

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
