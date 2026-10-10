import {
  LlmChatCompletionInput,
  LlmChatCompletionResult,
  LlmClient,
} from "../llm/llm-client.interface";

export type ScriptedTurn = {
  content?: string;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
};

/**
 * Deterministic LLM double behind the existing LLM_CLIENT port. Used by
 * the regression specs and as the default engine of the validation
 * runner. A real provider (GroqLlmClient) is drop-in interchangeable:
 * the harness and evaluator never know which one produced a run.
 *
 * The tool calls it names are executed FOR REAL by
 * AiInvestigationService against real data — only the model turns are
 * scripted.
 */
export class ScriptedLlmClient implements LlmClient {
  private queue: ScriptedTurn[] = [];
  private throwMessage: string | null = null;
  calls = 0;

  setScript(turns: ScriptedTurn[]) {
    this.queue = [...turns];
    this.calls = 0;
    this.throwMessage = null;
  }

  /** Next createChatCompletion call throws (provider transport failure). */
  setThrowOnce(message: string) {
    this.queue = [];
    this.throwMessage = message;
  }

  async createChatCompletion(
    _input: LlmChatCompletionInput,
  ): Promise<LlmChatCompletionResult> {
    if (this.throwMessage) {
      const message = this.throwMessage;
      this.throwMessage = null;
      throw new Error(message);
    }

    this.calls += 1;
    const turn = this.queue.shift();

    if (!turn) {
      throw new Error("ScriptedLlmClient: no scripted turn left");
    }

    return {
      message: {
        role: "assistant",
        content: turn.content ?? null,
        toolCalls: turn.toolCalls.map((call, index) => ({
          id: `call-${this.calls}-${index}`,
          name: call.name,
          arguments: call.arguments,
        })),
      },
      tokensUsed: 10,
    };
  }
}
