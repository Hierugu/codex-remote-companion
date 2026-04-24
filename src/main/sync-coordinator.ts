import type {
  CompanionDispatchTask,
  NormalizedInboundEvent,
  RuntimeTaskDispatchResult,
  SyncDispatchRecord
} from '@shared/contracts';

export class SyncCoordinator {
  private lastDispatch: SyncDispatchRecord | null = null;

  recordDispatch(input: {
    event: NormalizedInboundEvent;
    task: CompanionDispatchTask;
    runtimeResult: RuntimeTaskDispatchResult;
  }): SyncDispatchRecord {
    this.lastDispatch = {
      eventId: input.event.id,
      taskId: input.task.taskId,
      routeKey: input.task.routeKey,
      routedThreadId: input.task.routedThreadId,
      source: input.task.source,
      syncedAt: input.runtimeResult.receivedAt
    };

    return this.lastDispatch;
  }

  getLastDispatch(): SyncDispatchRecord | null {
    return this.lastDispatch;
  }
}
