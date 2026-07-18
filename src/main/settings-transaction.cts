function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AsyncSerialQueue {
  private chain: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(task, task);
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }
}

export async function persistAndApplyWithRollback<T>(input: {
  previous: T;
  next: T;
  persist: (value: T) => Promise<T>;
  apply: (previous: T, next: T) => Promise<void>;
  restore: (failed: T, restored: T) => Promise<void>;
}): Promise<T> {
  const saved = await input.persist(input.next);
  try {
    await input.apply(input.previous, saved);
    return saved;
  } catch (error) {
    try {
      const restored = await input.persist(input.previous);
      await input.restore(saved, restored);
    } catch (rollbackError) {
      throw new Error(`설정 적용 실패: ${errorMessage(error)} 이전 설정 복구도 실패했습니다: ${errorMessage(rollbackError)}`, { cause: error });
    }
    throw new Error(`설정 적용 실패: ${errorMessage(error)} 이전 설정으로 복구했습니다.`, { cause: error });
  }
}
