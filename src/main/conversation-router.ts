import type { NormalizedInboundEvent, RoutedConversationTask } from '@shared/contracts';

export class ConversationRouter {
  routeInboundEvent(event: NormalizedInboundEvent): RoutedConversationTask {
    const normalizedPrompt = event.text.trim();
    if (!normalizedPrompt) {
      throw new Error('Inbound event text must not be empty.');
    }

    const routeKey = event.threadId ?? event.externalThreadId ?? event.projectKey ?? null;

    return {
      routeKey,
      routedThreadId: event.threadId,
      prompt: normalizedPrompt,
      source: event.source,
      projectKey: event.projectKey,
      externalThreadId: event.externalThreadId
    };
  }
}
