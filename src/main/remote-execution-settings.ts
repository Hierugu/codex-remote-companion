import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  CodexEnvironmentSnapshot,
  RemoteExecutionOption,
  RemoteExecutionPermissionMode,
  RemoteExecutionSettings,
  RemoteExecutionSettingsState
} from '@shared/contracts';

import { CodexAppServerClient } from './app-server-client';
import { getCompanionStatePath } from './companion-paths';
import { CodexLocalStore } from './codex-store';

interface RemoteExecutionSettingsFileShape {
  model: string | null;
  reasoningEffort: string | null;
  permissionMode: RemoteExecutionPermissionMode | null;
}

interface RemoteReasoningOption {
  value: string;
  description: string;
}

interface ModelCatalogEntry {
  value: string;
  label: string;
  description: string;
  reasoningOptions: RemoteReasoningOption[];
  defaultReasoningEffort: string | null;
  isDefault: boolean;
}

interface ModelCatalogSnapshot {
  models: ModelCatalogEntry[];
}

interface AppServerModelCatalogClient {
  modelList(limit?: number): Promise<{
    data?: Array<{
      model?: string;
      displayName?: string;
      description?: string;
      hidden?: boolean;
      isDefault?: boolean;
      defaultReasoningEffort?: string;
      supportedReasoningEfforts?: Array<{
        reasoningEffort?: string;
        description?: string;
      }>;
    }>;
  }>;
  dispose(): Promise<void>;
}

interface ModelCatalogCacheEntry {
  expiresAt: number;
  snapshot: ModelCatalogSnapshot;
}

interface CodexConfigSelections {
  model: string | null;
  reasoningEffort: string | null;
  permissionMode: RemoteExecutionPermissionMode | null;
}

interface StateInputs {
  snapshot: CodexEnvironmentSnapshot;
  configSelections: CodexConfigSelections;
  modelCatalog: ModelCatalogSnapshot;
}

const MODEL_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const CONFIG_MODEL_PATTERN = /^model\s*=\s*"([^"]+)"/m;
const CONFIG_REASONING_PATTERN = /^model_reasoning_effort\s*=\s*"([^"]+)"/m;
const CONFIG_APPROVAL_PATTERN = /^approval_policy\s*=\s*"([^"]+)"/m;
const CONFIG_SANDBOX_PATTERN = /^sandbox_mode\s*=\s*"([^"]+)"/m;
const DEFAULT_REASONING_OPTIONS: RemoteReasoningOption[] = [
  { value: 'none', description: 'No reasoning path' },
  { value: 'minimal', description: 'Minimal reasoning effort' },
  { value: 'low', description: 'Lower reasoning effort' },
  { value: 'medium', description: 'Balanced reasoning effort' },
  { value: 'high', description: 'High reasoning effort' },
  { value: 'xhigh', description: 'Maximum reasoning effort' }
];

function createDefaultState(): RemoteExecutionSettingsFileShape {
  return {
    model: null,
    reasoningEffort: null,
    permissionMode: null
  };
}

function buildDefaultCatalog(): ModelCatalogSnapshot {
  return {
    models: [
      {
        value: 'gpt-5.4',
        label: 'GPT-5.4',
        description: 'Latest flagship Codex model',
        reasoningOptions: DEFAULT_REASONING_OPTIONS,
        defaultReasoningEffort: 'medium',
        isDefault: true
      },
      {
        value: 'gpt-5.4-mini',
        label: 'GPT-5.4 Mini',
        description: 'Smaller fast Codex model',
        reasoningOptions: DEFAULT_REASONING_OPTIONS,
        defaultReasoningEffort: 'medium',
        isDefault: false
      },
      {
        value: 'gpt-5.3',
        label: 'GPT-5.3',
        description: 'Previous frontier Codex model',
        reasoningOptions: DEFAULT_REASONING_OPTIONS,
        defaultReasoningEffort: 'medium',
        isDefault: false
      }
    ]
  };
}

function findModelEntry(
  catalog: ModelCatalogSnapshot,
  value: string | null
): ModelCatalogEntry | null {
  if (!value) {
    return null;
  }

  return catalog.models.find((entry) => entry.value === value) ?? null;
}

function toReasoningOptionLabel(value: string): string {
  switch (value) {
    case 'none':
      return 'None';
    case 'minimal':
      return 'Minimal';
    case 'low':
      return 'Low';
    case 'medium':
      return 'Medium';
    case 'high':
      return 'High';
    case 'xhigh':
      return 'XHigh';
    default:
      return value;
  }
}

function ensureCurrentOption(
  options: RemoteExecutionOption[],
  currentValue: string | null,
  currentLabel: string | null,
  currentDescription: string
): RemoteExecutionOption[] {
  if (!currentValue || options.some((option) => option.value === currentValue)) {
    return options;
  }

  return [
    ...options,
    {
      value: currentValue,
      label: currentLabel ?? currentValue,
      description: currentDescription
    }
  ];
}

function extractQuotedTomlValue(raw: string, pattern: RegExp): string | null {
  return raw.match(pattern)?.[1] ?? null;
}

function mapConfigPermissionMode(
  approvalPolicy: string | null,
  sandboxMode: string | null
): RemoteExecutionPermissionMode | null {
  if (sandboxMode === 'danger-full-access') {
    return 'full-access';
  }

  if (sandboxMode === 'workspace-write' && approvalPolicy === 'on-request') {
    return 'default';
  }

  if (sandboxMode === 'workspace-write' && approvalPolicy === 'never') {
    return 'full-access';
  }

  return null;
}

function mapSnapshotPermissionMode(
  permissionLabel: string | null
): RemoteExecutionPermissionMode {
  return permissionLabel === 'Full access' ? 'full-access' : 'default';
}

function buildPermissionOptions(): RemoteExecutionOption[] {
  return [
    {
      value: 'default',
      label: 'Default permissions',
      description: 'Workspace-write mode with approval requests enabled in local Codex'
    },
    {
      value: 'full-access',
      label: 'Full access',
      description: 'Dangerous mode with unrestricted file-system access'
    }
  ];
}

export function getDefaultRemoteExecutionSettingsPath(): string {
  return getCompanionStatePath('execution-settings.json');
}

export class RemoteExecutionSettingsStore {
  constructor(private readonly _configPath = getDefaultRemoteExecutionSettingsPath()) {}

  async readState(): Promise<RemoteExecutionSettingsFileShape> {
    return createDefaultState();
  }

  async writeState(_nextState: RemoteExecutionSettingsFileShape): Promise<void> {
    return;
  }

  async updateState(
    patch: Partial<RemoteExecutionSettingsFileShape>
  ): Promise<RemoteExecutionSettingsFileShape> {
    return {
      ...createDefaultState(),
      ...patch
    };
  }
}

export class RemoteExecutionSettingsService {
  private modelCatalogCache: ModelCatalogCacheEntry | null = null;

  constructor(
    private readonly _store: RemoteExecutionSettingsStore,
    private readonly codexStore: CodexLocalStore,
    private readonly createClient: () => Promise<AppServerModelCatalogClient> = () =>
      CodexAppServerClient.start()
  ) {}

  async getState(): Promise<RemoteExecutionSettingsState> {
    const inputs = await this.loadStateInputs();
    return this.buildState(inputs);
  }

  async setModelSelection(selection: string): Promise<RemoteExecutionSettingsState> {
    const trimmedSelection = selection.trim();
    if (!trimmedSelection) {
      throw new Error('Model selection is required.');
    }

    throw new Error('Remote model changes are disabled. Change the model in Codex App.');
  }

  async setReasoningSelection(selection: string): Promise<RemoteExecutionSettingsState> {
    const trimmedSelection = selection.trim();
    if (!trimmedSelection) {
      throw new Error('Reasoning selection is required.');
    }

    throw new Error('Remote reasoning changes are disabled. Change reasoning in Codex App.');
  }

  async setPermissionSelection(selection: string): Promise<RemoteExecutionSettingsState> {
    const trimmedSelection = selection.trim();
    if (trimmedSelection !== 'default' && trimmedSelection !== 'full-access') {
      throw new Error(`Unsupported permissions selection: ${trimmedSelection}`);
    }

    throw new Error('Remote permission changes are disabled. Change permissions in Codex App.');
  }

  async resolveExecutionOverrides(): Promise<RemoteExecutionSettings> {
    return {
      model: null,
      reasoningEffort: null,
      permissionMode: null
    };
  }

  private async loadStateInputs(): Promise<StateInputs> {
    const [snapshot, configSelections, modelCatalog] = await Promise.all([
      this.codexStore.getEnvironmentSnapshot(),
      this.readConfigSelections(),
      this.getModelCatalog()
    ]);

    return {
      snapshot,
      configSelections,
      modelCatalog
    };
  }

  private buildState(inputs: StateInputs): RemoteExecutionSettingsState {
    const { snapshot, configSelections, modelCatalog } = inputs;
    const fallbackModel =
      snapshot.model ?? modelCatalog.models.find((entry) => entry.isDefault)?.value ?? null;
    const effectiveModel = configSelections.model ?? fallbackModel;
    const modelEntry =
      findModelEntry(modelCatalog, effectiveModel) ??
      modelCatalog.models.find((entry) => entry.isDefault) ??
      null;
    const modelOptions = ensureCurrentOption(
      modelCatalog.models.map((entry) => ({
        value: entry.value,
        label: entry.label,
        description: entry.description
      })),
      effectiveModel,
      effectiveModel,
      'Current local Codex model'
    );

    const reasoningEntries = modelEntry?.reasoningOptions ?? DEFAULT_REASONING_OPTIONS;
    const effectiveReasoningEffort =
      configSelections.reasoningEffort ??
      snapshot.reasoningEffort ??
      modelEntry?.defaultReasoningEffort ??
      reasoningEntries[0]?.value ??
      null;
    const reasoningOptions = ensureCurrentOption(
      reasoningEntries.map((entry) => ({
        value: entry.value,
        label: toReasoningOptionLabel(entry.value),
        description: entry.description
      })),
      effectiveReasoningEffort,
      effectiveReasoningEffort ? toReasoningOptionLabel(effectiveReasoningEffort) : null,
      'Current local Codex reasoning effort'
    );

    const effectivePermissionMode =
      configSelections.permissionMode ?? mapSnapshotPermissionMode(snapshot.permissionMode);
    const permissionOptions = buildPermissionOptions();
    const effectivePermissionLabel =
      permissionOptions.find((option) => option.value === effectivePermissionMode)?.label ??
      (effectivePermissionMode === 'full-access' ? 'Full access' : 'Default permissions');

    return {
      overrides: {
        model: null,
        reasoningEffort: null,
        permissionMode: null
      },
      effectiveModel,
      effectiveReasoningEffort,
      effectivePermissionMode,
      effectivePermissionLabel,
      modelSelection: effectiveModel ?? modelOptions[0]?.value ?? '',
      reasoningSelection: effectiveReasoningEffort ?? reasoningOptions[0]?.value ?? '',
      permissionSelection: effectivePermissionMode,
      modelOptions,
      reasoningOptions,
      permissionOptions
    };
  }

  private async readConfigSelections(): Promise<CodexConfigSelections> {
    const configPath = join(this.codexStore.getCodexHome(), 'config.toml');
    if (!existsSync(configPath)) {
      return {
        model: null,
        reasoningEffort: null,
        permissionMode: null
      };
    }

    const raw = await readFile(configPath, 'utf8');
    const approvalPolicy = extractQuotedTomlValue(raw, CONFIG_APPROVAL_PATTERN);
    const sandboxMode = extractQuotedTomlValue(raw, CONFIG_SANDBOX_PATTERN);

    return {
      model: extractQuotedTomlValue(raw, CONFIG_MODEL_PATTERN),
      reasoningEffort: extractQuotedTomlValue(raw, CONFIG_REASONING_PATTERN),
      permissionMode: mapConfigPermissionMode(approvalPolicy, sandboxMode)
    };
  }

  private async getModelCatalog(): Promise<ModelCatalogSnapshot> {
    const cached = this.modelCatalogCache;
    if (cached && cached.expiresAt > Date.now()) {
      return cached.snapshot;
    }

    const fallbackCatalog = buildDefaultCatalog();
    let snapshot = fallbackCatalog;

    try {
      const client = await this.createClient();
      try {
        const response = await client.modelList(100);
        const models = (response.data ?? [])
          .map((entry): ModelCatalogEntry | null => {
            const value = typeof entry.model === 'string' ? entry.model.trim() : '';
            if (!value || entry.hidden) {
              return null;
            }

            const reasoningOptions = (entry.supportedReasoningEfforts ?? [])
              .map((option): RemoteReasoningOption | null => {
                const reasoningValue =
                  typeof option.reasoningEffort === 'string'
                    ? option.reasoningEffort.trim()
                    : '';
                if (!reasoningValue) {
                  return null;
                }

                return {
                  value: reasoningValue,
                  description:
                    typeof option.description === 'string' && option.description.trim()
                      ? option.description.trim()
                      : `${toReasoningOptionLabel(reasoningValue)} reasoning effort`
                };
              })
              .filter((option): option is RemoteReasoningOption => option !== null);

            return {
              value,
              label:
                typeof entry.displayName === 'string' && entry.displayName.trim()
                  ? entry.displayName.trim()
                  : value,
              description:
                typeof entry.description === 'string' && entry.description.trim()
                  ? entry.description.trim()
                  : 'Model available in local Codex',
              reasoningOptions:
                reasoningOptions.length > 0 ? reasoningOptions : DEFAULT_REASONING_OPTIONS,
              defaultReasoningEffort:
                typeof entry.defaultReasoningEffort === 'string' &&
                entry.defaultReasoningEffort.trim()
                  ? entry.defaultReasoningEffort.trim()
                  : null,
              isDefault: entry.isDefault === true
            };
          })
          .filter((entry): entry is ModelCatalogEntry => entry !== null);

        if (models.length > 0) {
          snapshot = { models };
        }
      } finally {
        await client.dispose().catch(() => {
          // Ignore disposal errors for best-effort catalog reads.
        });
      }
    } catch {
      snapshot = fallbackCatalog;
    }

    this.modelCatalogCache = {
      expiresAt: Date.now() + MODEL_CATALOG_CACHE_TTL_MS,
      snapshot
    };

    return snapshot;
  }
}
