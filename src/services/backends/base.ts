import {
  BackendAdapter,
  BackendCapabilities,
  BackendId,
  BackendStatusResult,
  BackendSubmitResult,
  Task,
} from "../../types.js";

export abstract class BaseBackendAdapter implements BackendAdapter {
  abstract readonly id: BackendId;

  abstract getCapabilities(): BackendCapabilities;
  abstract isConfigured(): boolean;
  abstract submitTask(task: Task): Promise<BackendSubmitResult>;
  abstract getStatus(backend_task_id: string): Promise<BackendStatusResult>;
  abstract cancelTask(backend_task_id: string): Promise<boolean>;

  protected log(message: string): void {
    console.error(`[${this.id}] ${message}`);
  }

  protected async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number = 30000,
  ): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`Backend ${this.id} request timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });

    try {
      const result = await Promise.race([promise, timeoutPromise]);
      clearTimeout(timeoutId!);
      return result;
    } catch (error) {
      clearTimeout(timeoutId!);
      throw error;
    }
  }

  protected wrapError(operation: string, error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`[${this.id}] ${operation} failed: ${message}`);
  }
}
