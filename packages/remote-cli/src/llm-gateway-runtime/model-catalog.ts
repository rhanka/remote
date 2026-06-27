export type AccountPool = "anthropic" | "codex";
export type GatewayProtocol = "anthropic.messages";
export type RoutingPolicy = "round-robin";

export interface ModelCatalogEntry {
  id: string;
  provider: "anthropic" | "codex";
  upstreamModel: string;
  accountPool: AccountPool;
  inputProtocol: GatewayProtocol;
  outputProtocol: GatewayProtocol;
  capabilities: string[];
  defaultPolicy: RoutingPolicy;
  aliases?: string[];
}

export interface RoutingTarget {
  requestedModel?: string;
  catalogModelId?: string;
  upstreamModel?: string;
  accountPool: AccountPool;
  routingPolicy: RoutingPolicy;
  routeReason:
    | "catalog-id"
    | "catalog-alias"
    | "env-model-map"
    | "provider-request"
    | "passthrough-gpt";
}

const CODEX_CAPABILITIES = ["streaming", "tools", "reasoning_effort"] as const;

const DEFAULT_MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    id: "gpt-5.5",
    provider: "codex",
    upstreamModel: "gpt-5.5",
    accountPool: "codex",
    inputProtocol: "anthropic.messages",
    outputProtocol: "anthropic.messages",
    capabilities: [...CODEX_CAPABILITIES],
    defaultPolicy: "round-robin",
    aliases: [
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
      "claude-haiku-4-5-20251001",
    ],
  },
  {
    id: "gpt-5.3-codex-spark",
    provider: "codex",
    upstreamModel: "gpt-5.3-codex-spark",
    accountPool: "codex",
    inputProtocol: "anthropic.messages",
    outputProtocol: "anthropic.messages",
    capabilities: [...CODEX_CAPABILITIES],
    defaultPolicy: "round-robin",
  },
];

let _catalog: ModelCatalogEntry[] | null = null;
let _envModelMap: Record<string, string> | null = null;

function parseEnvModelMap(): Record<string, string> {
  if (_envModelMap) return _envModelMap;
  if (!process.env.OPENAI_MODEL_MAP) {
    _envModelMap = {};
    return _envModelMap;
  }
  _envModelMap = JSON.parse(process.env.OPENAI_MODEL_MAP) as Record<
    string,
    string
  >;
  return _envModelMap;
}

function envCatalogEntries(): ModelCatalogEntry[] {
  return Object.entries(parseEnvModelMap()).map(([id, upstreamModel]) => ({
    id,
    provider: "codex" as const,
    upstreamModel,
    accountPool: "codex" as const,
    inputProtocol: "anthropic.messages" as const,
    outputProtocol: "anthropic.messages" as const,
    capabilities: [...CODEX_CAPABILITIES],
    defaultPolicy: "round-robin" as const,
  }));
}

export function listModelCatalog(): ModelCatalogEntry[] {
  if (!_catalog) _catalog = [...DEFAULT_MODEL_CATALOG, ...envCatalogEntries()];
  return _catalog;
}

export function resetModelCatalogCache(): void {
  _catalog = null;
  _envModelMap = null;
}

export function accountPoolForProvider(
  provider: string,
): AccountPool | undefined {
  const normalized = provider.toLowerCase();
  if (normalized === "openai" || normalized === "codex") return "codex";
  if (normalized === "anthropic" || normalized === "claude-code")
    return "anthropic";
  return undefined;
}

export function routeForProvider(provider: string): RoutingTarget | undefined {
  const accountPool = accountPoolForProvider(provider);
  if (!accountPool) return undefined;
  return {
    accountPool,
    routingPolicy: "round-robin",
    routeReason: "provider-request",
  };
}

export function resolveModelRoute(model: string): RoutingTarget | undefined {
  const envMap = parseEnvModelMap();
  const envUpstream = envMap[model];
  if (envUpstream) {
    return {
      requestedModel: model,
      catalogModelId: model,
      upstreamModel: envUpstream,
      accountPool: "codex",
      routingPolicy: "round-robin",
      routeReason: "env-model-map",
    };
  }

  for (const entry of listModelCatalog()) {
    if (entry.id === model) {
      return {
        requestedModel: model,
        catalogModelId: entry.id,
        upstreamModel: entry.upstreamModel,
        accountPool: entry.accountPool,
        routingPolicy: entry.defaultPolicy,
        routeReason: "catalog-id",
      };
    }
    if (entry.aliases?.includes(model)) {
      return {
        requestedModel: model,
        catalogModelId: entry.id,
        upstreamModel: entry.upstreamModel,
        accountPool: entry.accountPool,
        routingPolicy: entry.defaultPolicy,
        routeReason: "catalog-alias",
      };
    }
  }

  if (model.startsWith("gpt-")) {
    return {
      requestedModel: model,
      catalogModelId: model,
      upstreamModel: model,
      accountPool: "codex",
      routingPolicy: "round-robin",
      routeReason: "passthrough-gpt",
    };
  }

  return undefined;
}

export function routeModelOrThrow(model: string): RoutingTarget {
  const route = resolveModelRoute(model);
  if (!route) throw new Error(`unsupported model: ${model}`);
  return route;
}

export function modelCatalogResponse(entries = listModelCatalog()): {
  object: "list";
  data: Array<ModelCatalogEntry & { object: "model"; owned_by: string }>;
} {
  return {
    object: "list",
    data: entries.map((entry) => ({
      ...entry,
      object: "model" as const,
      owned_by: entry.provider,
    })),
  };
}
