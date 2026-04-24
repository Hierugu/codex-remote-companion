import type {
  ControlPlaneDispatchReceipt,
  ControlPlaneStatus,
  NormalizedInboundEvent
} from '@shared/contracts';

import { PersistentBackendRegistry } from './backend-registry';
import { LocalCompanionRegistry } from './companion-registry';
import { CompanionTransport } from './companion-transport';
import { ConversationRouter } from './conversation-router';
import { CodexOrchestrator } from './codex-orchestrator';
import { SyncCoordinator } from './sync-coordinator';

interface ControlPlaneBackendOptions {
  registry: LocalCompanionRegistry;
  backendRegistry: PersistentBackendRegistry;
  transport: CompanionTransport;
  router?: ConversationRouter;
  orchestrator?: CodexOrchestrator;
  syncCoordinator?: SyncCoordinator;
}

export class ControlPlaneBackend {
  private readonly registry: LocalCompanionRegistry;

  private readonly transport: CompanionTransport;

  private readonly backendRegistry: PersistentBackendRegistry;

  private readonly router: ConversationRouter;

  private readonly orchestrator: CodexOrchestrator;

  private readonly syncCoordinator: SyncCoordinator;

  private lastRuntimeTaskId: string | null = null;

  constructor(options: ControlPlaneBackendOptions) {
    this.registry = options.registry;
    this.backendRegistry = options.backendRegistry;
    this.transport = options.transport;
    this.router = options.router ?? new ConversationRouter();
    this.orchestrator = options.orchestrator ?? new CodexOrchestrator();
    this.syncCoordinator = options.syncCoordinator ?? new SyncCoordinator();
  }

  async getStatus(): Promise<ControlPlaneStatus> {
    const identity = await this.registry.ensureInstallIdentity();
    await this.backendRegistry.ensureBootstrap(identity);

    return {
      installIdentity: identity,
      lastDispatch: this.syncCoordinator.getLastDispatch(),
      runtimeTaskId: this.lastRuntimeTaskId,
      backendRegistry: await this.backendRegistry.getSummary()
    };
  }

  async handleInboundEvent(
    event: NormalizedInboundEvent
  ): Promise<ControlPlaneDispatchReceipt> {
    const identity = await this.registry.ensureInstallIdentity();
    await this.backendRegistry.ensureBootstrap(identity);
    const route = this.router.routeInboundEvent(event);
    const task = this.orchestrator.buildDispatchTask({
      identity,
      event,
      route
    });
    const runtimeResult = await this.transport.dispatchTask(task);
    this.lastRuntimeTaskId = runtimeResult.taskId;
    this.syncCoordinator.recordDispatch({
      event,
      task,
      runtimeResult
    });
    await this.backendRegistry.appendSyncSnapshot({
      id: `sync:${task.taskId}`,
      machineId: identity.machineId,
      status: 'ok',
      details: `dispatched ${event.source} event ${event.id}`
    });

    return {
      accepted: runtimeResult.accepted,
      taskId: task.taskId,
      installId: identity.installId,
      machineId: identity.machineId,
      routedThreadId: task.routedThreadId,
      routeKey: task.routeKey,
      receivedAt: runtimeResult.receivedAt
    };
  }
}
