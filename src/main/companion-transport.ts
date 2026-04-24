import type { CompanionDispatchTask, RuntimeTaskDispatchResult } from '@shared/contracts';

import { LocalRuntimeController } from './runtime';

export interface CompanionTransport {
  dispatchTask(task: CompanionDispatchTask): Promise<RuntimeTaskDispatchResult>;
}

export class InProcessCompanionTransport implements CompanionTransport {
  constructor(private readonly runtimeController: LocalRuntimeController) {}

  async dispatchTask(task: CompanionDispatchTask): Promise<RuntimeTaskDispatchResult> {
    return this.runtimeController.dispatchTask(task);
  }
}
