import type { AppProps } from 'next/app';
import { NhostProvider } from '@nhost/react';
import { ApolloProvider } from '@apollo/client';
import { nhost } from '@/lib/nhost';
import { createApolloClient } from '@/lib/graphql-client';
import '@/styles/globals.css';

const apolloClient = createApolloClient();

export default function App({ Component, pageProps }: AppProps) {
  return (
    <NhostProvider nhost={nhost}>
      <ApolloProvider client={apolloClient}>
        <Component {...pageProps} />
      </ApolloProvider>
    </NhostProvider>
  );
}
