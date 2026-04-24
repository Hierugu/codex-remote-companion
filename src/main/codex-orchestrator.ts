import { randomUUID } from 'node:crypto';

import type {
  CompanionDispatchTask,
  InstallIdentityRecord,
  NormalizedInboundEvent,
  RoutedConversationTask
} from '@shared/contracts';

export class CodexOrchestrator {
  buildDispatchTask(input: {
    identity: InstallIdentityRecord;
    event: NormalizedInboundEvent;
    route: RoutedConversationTask;
  }): CompanionDispatchTask {
    return {
      taskId: randomUUID(),
      installId: input.identity.installId,
      machineId: input.identity.machineId,
      eventId: input.event.id,
      createdAt: new Date().toISOString(),
      routeKey: input.route.routeKey,
      routedThreadId: input.route.routedThreadId,
      prompt: input.route.prompt,
      source: input.route.source,
      projectKey: input.route.projectKey
    };
  }
}
