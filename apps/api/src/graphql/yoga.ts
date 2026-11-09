import { readFileSync } from 'node:fs';
import { EnvelopArmorPlugin } from '@escape.tech/graphql-armor';
import { usePersistedOperations } from '@graphql-yoga/plugin-persisted-operations';
import { YogaDriver, type YogaDriverConfig } from '@graphql-yoga/nestjs';
import type { AppConfig } from '../config';

export function loadPersistedOperations(file: string | undefined): Map<string, string> {
  if (!file) return new Map();
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
  const map = new Map<string, string>();
  for (const [hash, query] of Object.entries(raw)) {
    if (!/^[0-9a-f]{64}$/.test(hash) || typeof query !== 'string') throw new Error('invalid persisted operations file');
    map.set(hash, query);
  }
  return map;
}

export function yogaConfig(config: AppConfig, operations: Map<string, string>): YogaDriverConfig<'express'> {
  return {
    driver: YogaDriver,
    autoSchemaFile: true,
    sortSchema: true,
    path: '/graphql',
    graphiql: config.NODE_ENV === 'development',
    landingPage: false,
    maskedErrors: true,
    batching: false,
    multipart: false,
    cors: false,
    plugins: [
      usePersistedOperations({
        getPersistedOperation: (hash: string) => operations.get(hash) ?? null,
        allowArbitraryOperations: config.GRAPHQL_ALLOW_ARBITRARY,
        skipDocumentValidation: false,
      }),
      EnvelopArmorPlugin({
        maxDepth: { n: 8, ignoreIntrospection: false },
        costLimit: { maxCost: 5000, ignoreIntrospection: false },
        maxAliases: { n: 10 },
        maxDirectives: { n: 10 },
        maxTokens: { n: 2000 },
        blockFieldSuggestion: { enabled: true },
      }),
    ],
  };
}
