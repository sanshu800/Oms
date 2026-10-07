import { Inject, Injectable, InternalServerErrorException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Groq from "groq-sdk";

import {
  LlmChatCompletionInput,
  LlmChatCompletionResult,
  LlmClient,
  LlmMessage,
  LlmToolCallRequest,
} from "./llm-client.interface";

@Injectable()
export class GroqLlmClient implements LlmClient {
  private client: Groq | null = null;

  constructor(private readonly config: ConfigService) {}

  private getClient(): Groq {
    if (this.client) {
      return this.client;
    }

    const apiKey = this.config.get<string>("GROQ_API_KEY");

    if (!apiKey) {
      throw new InternalServerErrorException(
        "GROQ_API_KEY is not configured",
      );
    }

    this.client = new Groq({ apiKey });

    return this.client;
  }

  async createChatCompletion(
    input: LlmChatCompletionInput,
  ): Promise<LlmChatCompletionResult> {
    const model =
      this.config.get<string>("GROQ_MODEL") ?? "openai/gpt-oss-120b";

    const completion = await this.getClient().chat.completions.create({
      model,
      messages: input.messages.map(toGroqMessage),
      tools:
        input.tools.length > 0
          ? input.tools.map((tool) => ({
              type: "function" as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            }))
          : undefined,
      tool_choice: input.tools.length > 0 ? "auto" : undefined,
    });

    const choice = completion.choices[0];

    if (!choice) {
      throw new InternalServerErrorException(
        "Groq returned no completion choices",
      );
    }

    return {
      message: fromGroqMessage(choice.message),
      tokensUsed: completion.usage?.total_tokens ?? null,
    };
  }
}

function toGroqMessage(message: LlmMessage): Groq.Chat.ChatCompletionMessageParam {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId ?? "",
      content: message.content ?? "",
    };
  }

  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.toolCalls?.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        },
      })),
    };
  }

  return {
    role: message.role,
    content: message.content ?? "",
  };
}

function fromGroqMessage(
  message: Groq.Chat.Completions.ChatCompletionMessage,
): LlmMessage {
  const toolCalls: LlmToolCallRequest[] | undefined = message.tool_calls
    ?.filter((call) => call.type === "function")
    .map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: safeParseJsonObject(call.function.arguments),
    }));

  return {
    role: "assistant",
    content: message.content ?? null,
    toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
  };
}

function safeParseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }

    return {};
  } catch {
    return {};
  }
}
