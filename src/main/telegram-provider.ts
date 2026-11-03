export interface TelegramBotIdentity {
  id: string;
  username: string | null;
}

export interface TelegramForumGroupInfo {
  chatId: string;
  title: string;
  type: string;
  isForum: boolean;
}

export interface TelegramBotPermissions {
  isAdministrator: boolean;
  canManageTopics: boolean;
}

export interface TelegramForumTopicInfo {
  messageThreadId: number;
  name: string;
}

export interface TelegramSendMessageInput {
  chatId: string;
  messageThreadId: number | null;
  text: string;
  format?: 'markdown';
  replyToMessageId?: number;
}

export interface TelegramSendMessageResult {
  chatId: string;
  messageThreadId: number | null;
  messageId: number;
  text: string;
}

export interface TelegramEditMessageInput {
  chatId: string;
  messageId: number;
  text: string;
  format?: 'markdown';
}

export interface TelegramUpdateMessage {
  messageId: number;
  text: string | null;
  chatId: string;
  chatType: string;
  messageThreadId: number | null;
  senderId: string | null;
  senderIsBot: boolean;
}

export interface TelegramInboundUpdate {
  updateId: number;
  message: TelegramUpdateMessage | null;
}

export interface TelegramBotProvider {
  getIdentity(botToken: string): Promise<TelegramBotIdentity>;
  getForumGroup(botToken: string, chatId: string): Promise<TelegramForumGroupInfo>;
  getBotPermissions(botToken: string, chatId: string): Promise<TelegramBotPermissions>;
  getUpdates(
    botToken: string,
    input: { offset?: number; timeoutSeconds?: number; limit?: number }
  ): Promise<TelegramInboundUpdate[]>;
  createForumTopic(
    botToken: string,
    chatId: string,
    name: string
  ): Promise<TelegramForumTopicInfo>;
  editForumTopic(
    botToken: string,
    chatId: string,
    messageThreadId: number,
    name: string
  ): Promise<void>;
  closeForumTopic(botToken: string, chatId: string, messageThreadId: number): Promise<void>;
  reopenForumTopic(botToken: string, chatId: string, messageThreadId: number): Promise<void>;
  sendMessage(botToken: string, input: TelegramSendMessageInput): Promise<TelegramSendMessageResult>;
  editMessage(botToken: string, input: TelegramEditMessageInput): Promise<TelegramSendMessageResult>;
}

async function callTelegramApi<T>(
  botToken: string,
  method: string,
  payload: Record<string, unknown>
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000)
      });
    } catch (error) {
      if (attempt === 4) {
        const detail = error instanceof Error ? error.message : 'Unknown network error';
        throw new Error(`Telegram API ${method} network error after 5 attempts: ${detail}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      continue;
    }

    const data = (await response.json()) as {
      ok: boolean;
      result?: T;
      description?: string;
      error_code?: number;
      parameters?: { retry_after?: number };
    };

    if (response.ok && data.ok && data.result != null) {
      return data.result;
    }

    const retryAfter =
      data.parameters?.retry_after ??
      Number(data.description?.match(/retry after (\d+)/i)?.[1] ?? NaN);
    if (
      attempt < 4 &&
      (response.status === 429 || data.error_code === 429) &&
      typeof retryAfter === 'number' &&
      Number.isFinite(retryAfter) &&
      retryAfter >= 0
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, (retryAfter + 1) * 1000));
      continue;
    }

    if (attempt < 4 && response.status >= 500) {
      await new Promise<void>((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      continue;
    }

    throw new Error(data.description ?? `Telegram API call ${method} failed.`);
  }

  throw new Error(`Telegram API call ${method} exceeded retry limit.`);
}

function isRichFormattingRejected(error: unknown): boolean {
  return error instanceof Error && /^(Bad Request:|Not Found: method)/i.test(error.message);
}

export class HttpTelegramBotProvider implements TelegramBotProvider {
  async getIdentity(botToken: string): Promise<TelegramBotIdentity> {
    const result = await callTelegramApi<{
      id: number;
      username?: string;
    }>(botToken, 'getMe', {});

    return {
      id: String(result.id),
      username: result.username ?? null
    };
  }

  async getForumGroup(botToken: string, chatId: string): Promise<TelegramForumGroupInfo> {
    const result = await callTelegramApi<{
      id: number;
      title?: string;
      type: string;
      is_forum?: boolean;
    }>(botToken, 'getChat', {
      chat_id: chatId
    });

    return {
      chatId: String(result.id),
      title: result.title ?? chatId,
      type: result.type,
      isForum: result.is_forum === true
    };
  }

  async getBotPermissions(botToken: string, chatId: string): Promise<TelegramBotPermissions> {
    const [identity, administrators] = await Promise.all([
      this.getIdentity(botToken),
      callTelegramApi<
        Array<{
          user: { id: number };
          status: string;
          can_manage_topics?: boolean;
        }>
      >(botToken, 'getChatAdministrators', {
        chat_id: chatId
      })
    ]);

    const botAdmin = administrators.find((entry) => String(entry.user.id) === identity.id);
    return {
      isAdministrator: Boolean(botAdmin && botAdmin.status === 'administrator'),
      canManageTopics: botAdmin?.can_manage_topics === true
    };
  }

  async getUpdates(
    botToken: string,
    input: { offset?: number; timeoutSeconds?: number; limit?: number }
  ): Promise<TelegramInboundUpdate[]> {
    const result = await callTelegramApi<
      Array<{
        update_id: number;
        message?: {
          message_id: number;
          text?: string;
          message_thread_id?: number;
          chat: { id: number; type: string };
          from?: { id: number; is_bot?: boolean };
        };
      }>
    >(botToken, 'getUpdates', {
      offset: input.offset,
      timeout: input.timeoutSeconds ?? 0,
      limit: input.limit ?? 20,
      allowed_updates: ['message']
    });

    return result.map((update) => ({
      updateId: update.update_id,
      message: update.message
        ? {
            messageId: update.message.message_id,
            text: update.message.text ?? null,
            chatId: String(update.message.chat.id),
            chatType: update.message.chat.type,
            messageThreadId: update.message.message_thread_id ?? null,
            senderId:
              typeof update.message.from?.id === 'number'
                ? String(update.message.from.id)
                : null,
            senderIsBot: update.message.from?.is_bot === true
          }
        : null
    }));
  }

  async createForumTopic(
    botToken: string,
    chatId: string,
    name: string
  ): Promise<TelegramForumTopicInfo> {
    const result = await callTelegramApi<{
      message_thread_id: number;
      name: string;
    }>(botToken, 'createForumTopic', {
      chat_id: chatId,
      name
    });

    return {
      messageThreadId: result.message_thread_id,
      name: result.name
    };
  }

  async editForumTopic(
    botToken: string,
    chatId: string,
    messageThreadId: number,
    name: string
  ): Promise<void> {
    await callTelegramApi<boolean>(botToken, 'editForumTopic', {
      chat_id: chatId,
      message_thread_id: messageThreadId,
      name
    });
  }

  async closeForumTopic(
    botToken: string,
    chatId: string,
    messageThreadId: number
  ): Promise<void> {
    await callTelegramApi<boolean>(botToken, 'closeForumTopic', {
      chat_id: chatId,
      message_thread_id: messageThreadId
    });
  }

  async reopenForumTopic(
    botToken: string,
    chatId: string,
    messageThreadId: number
  ): Promise<void> {
    await callTelegramApi<boolean>(botToken, 'reopenForumTopic', {
      chat_id: chatId,
      message_thread_id: messageThreadId
    });
  }

  async sendMessage(
    botToken: string,
    input: TelegramSendMessageInput
  ): Promise<TelegramSendMessageResult> {
    type TelegramMessage = {
      message_id: number;
      text?: string;
      message_thread_id?: number;
      chat: { id: number };
    };
    const payload = {
      chat_id: input.chatId,
      message_thread_id: input.messageThreadId ?? undefined,
      reply_parameters: input.replyToMessageId
        ? { message_id: input.replyToMessageId }
        : undefined
    };
    let result: TelegramMessage;
    if (input.format === 'markdown') {
      try {
        result = await callTelegramApi<TelegramMessage>(botToken, 'sendRichMessage', {
          ...payload,
          rich_message: { markdown: input.text }
        });
      } catch (error) {
        if (!isRichFormattingRejected(error)) throw error;
        result = await callTelegramApi<TelegramMessage>(botToken, 'sendMessage', {
          ...payload,
          text: input.text
        });
      }
    } else {
      result = await callTelegramApi<TelegramMessage>(botToken, 'sendMessage', {
        ...payload,
        text: input.text
      });
    }

    return {
      chatId: String(result.chat.id),
      messageThreadId: result.message_thread_id ?? input.messageThreadId,
      messageId: result.message_id,
      text: result.text ?? input.text
    };
  }

  async editMessage(
    botToken: string,
    input: TelegramEditMessageInput
  ): Promise<TelegramSendMessageResult> {
    type TelegramMessage = {
      message_id: number;
      text?: string;
      message_thread_id?: number;
      chat: { id: number };
    };
    const payload = { chat_id: input.chatId, message_id: input.messageId };
    const callEdit = (rich: boolean): Promise<TelegramMessage> =>
      callTelegramApi<TelegramMessage>(botToken, 'editMessageText', {
        ...payload,
        ...(rich ? { rich_message: { markdown: input.text } } : { text: input.text })
      });
    let result: TelegramMessage;
    try {
      result = await callEdit(input.format === 'markdown');
    } catch (error) {
      if (input.format === 'markdown' && isRichFormattingRejected(error)) {
        result = await callEdit(false);
      } else if (error instanceof Error && /message is not modified/i.test(error.message)) {
        result = {
          message_id: input.messageId,
          text: input.text,
          message_thread_id: undefined,
          chat: { id: Number(input.chatId) }
        };
      } else {
        throw error;
      }
    }

    return {
      chatId: String(result.chat.id),
      messageThreadId: result.message_thread_id ?? null,
      messageId: result.message_id,
      text: result.text ?? input.text
    };
  }
}
