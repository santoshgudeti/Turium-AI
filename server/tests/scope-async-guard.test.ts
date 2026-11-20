import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Unit test suite verifying the scope transition and async request identity
 * guard algorithm implemented in AskAI.tsx.
 *
 * This mathematically models the exact state machine and race-condition guards:
 * 1. Monotonically increasing requestIdRef
 * 2. Target scope ID checking (targetScopeId === currentScopeId)
 * 3. AbortController signal handling
 * 4. State resets on scope transition (even with identical item titles)
 */
describe('Ask AI Scope Transition & Async Guard Architecture Test Suite', () => {
  interface State {
    question: string;
    loading: boolean;
    error: string | null;
    result: { answer: string; scopeId: string | null } | null;
    lastSubmittedQuestion: string | null;
  }

  class AskAIStateMachine {
    state: State;
    activeScopedItem: { id: string; title: string } | null = null;
    prevScopedItemId: string | null = null;
    prevInitialQuestion: string = '';
    requestId = 0;
    abortController: AbortController | null = null;

    constructor() {
      this.state = {
        question: '',
        loading: false,
        error: null,
        result: null,
        lastSubmittedQuestion: null,
      };
    }

    // Models scope change effect in AskAI.tsx
    onScopeChange(newScope: { id: string; title: string } | null) {
      this.activeScopedItem = newScope;
      const currentScopedId = newScope ? newScope.id : null;
      if (this.prevScopedItemId !== currentScopedId) {
        this.prevScopedItemId = currentScopedId;

        // Abort in-flight request and invalidate generation counter
        this.abortController?.abort();
        this.abortController = null;
        this.requestId++;

        // Reset state completely
        this.state.result = null;
        this.state.error = null;
        this.state.loading = false;
        this.state.lastSubmittedQuestion = null;
      }
    }

    // Models initialQuestion effect in AskAI.tsx
    onInitialQuestionChange(newQuestion: string) {
      if (newQuestion !== this.prevInitialQuestion) {
        this.prevInitialQuestion = newQuestion;
        if (newQuestion) {
          this.state.question = newQuestion;
          this.abortController?.abort();
          this.abortController = null;
          this.requestId++;
          this.state.result = null;
          this.state.error = null;
          this.state.loading = false;
          this.state.lastSubmittedQuestion = null;
        }
      }
    }

    // Models async submit with generation & scope guards
    async submit(queryText: string, delayMs: number, answerText: string) {
      this.abortController?.abort();
      const controller = new AbortController();
      this.abortController = controller;

      const thisRequestId = ++this.requestId;
      const targetScopeId = this.activeScopedItem ? this.activeScopedItem.id : null;

      this.state.loading = true;
      this.state.error = null;
      this.state.lastSubmittedQuestion = queryText;

      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (controller.signal.aborted) {
              reject(new Error('AbortError'));
            } else {
              resolve();
            }
          }, delayMs);

          controller.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('AbortError'));
          });
        });

        // Async guard: Discard response if request was aborted, newer request was dispatched,
        // or scope changed while request was in flight.
        if (
          controller.signal.aborted ||
          thisRequestId !== this.requestId ||
          (this.activeScopedItem ? this.activeScopedItem.id : null) !== targetScopeId
        ) {
          return;
        }

        this.state.result = { answer: answerText, scopeId: targetScopeId };
      } catch {
        if (
          controller.signal.aborted ||
          thisRequestId !== this.requestId ||
          (this.activeScopedItem ? this.activeScopedItem.id : null) !== targetScopeId
        ) {
          return;
        }
        this.state.result = null;
      } finally {
        if (
          !controller.signal.aborted &&
          thisRequestId === this.requestId &&
          (this.activeScopedItem ? this.activeScopedItem.id : null) === targetScopeId
        ) {
          this.state.loading = false;
        }
      }
    }
  }

  test('1. Switching between two items with IDENTICAL titles resets previous results, errors, and submitted question', async () => {
    const machine = new AskAIStateMachine();

    // 1. User scopes to Item A (title: "Architecture Guide")
    machine.onScopeChange({ id: 'item-uuid-a', title: 'Architecture Guide' });
    machine.onInitialQuestionChange('What are the key points in "Architecture Guide"?');

    await machine.submit('What are the key points in "Architecture Guide"?', 10, 'Answer for Item A');
    assert.equal(machine.state.result?.answer, 'Answer for Item A');
    assert.equal(machine.state.result?.scopeId, 'item-uuid-a');

    // 2. User switches to Item B (has the EXACT SAME title, but different ID)
    machine.onScopeChange({ id: 'item-uuid-b', title: 'Architecture Guide' });
    // initialQuestion is identical string:
    machine.onInitialQuestionChange('What are the key points in "Architecture Guide"?');

    // State MUST be completely cleared despite identical title and initial question
    assert.equal(machine.state.result, null, 'Previous result must be reset on scope switch');
    assert.equal(machine.state.lastSubmittedQuestion, null, 'Submitted question must be reset');
    assert.equal(machine.state.loading, false, 'Loading must be false');
    assert.equal(machine.state.error, null);
  });

  test('2. Clearing scope to "Search All" resets previous results, errors, and loading state', async () => {
    const machine = new AskAIStateMachine();

    machine.onScopeChange({ id: 'item-uuid-1', title: 'Single Item' });
    await machine.submit('Question about single item', 10, 'Single item answer');
    assert.ok(machine.state.result !== null);

    // User clicks "Search All" -> scope cleared to null
    machine.onScopeChange(null);

    assert.equal(machine.state.result, null, 'Clearing scope must reset result');
    assert.equal(machine.state.lastSubmittedQuestion, null);
    assert.equal(machine.state.loading, false);
  });

  test('3. Slower in-flight request from older scope CANNOT overwrite state after switching to a new scope', async () => {
    const machine = new AskAIStateMachine();

    // 1. Query initiated for Item A with long delay (100ms)
    machine.onScopeChange({ id: 'item-a', title: 'Item A' });
    const slowQueryA = machine.submit('Slow query for A', 100, 'Answer A (stale)');

    // 2. While Query A is in-flight (at t=10ms), user switches scope to Item B
    await new Promise((r) => setTimeout(r, 10));
    machine.onScopeChange({ id: 'item-b', title: 'Item B' });

    // 3. User immediately submits faster query for Item B (20ms)
    const fastQueryB = machine.submit('Fast query for B', 20, 'Answer B (current)');

    await Promise.all([slowQueryA, fastQueryB]);

    // Current state MUST reflect Item B, NEVER overwritten by stale Answer A
    assert.equal(machine.state.result?.answer, 'Answer B (current)');
    assert.equal(machine.state.result?.scopeId, 'item-b');
  });

  test('4. Slower in-flight request CANNOT overwrite state if user cleared scope before it resolves', async () => {
    const machine = new AskAIStateMachine();

    machine.onScopeChange({ id: 'item-a', title: 'Item A' });
    const slowQuery = machine.submit('Query for A', 80, 'Answer A');

    // At t=10ms, user clears scope to Search All
    await new Promise((r) => setTimeout(r, 10));
    machine.onScopeChange(null);

    await slowQuery;

    // Must remain null, not populated with stale Answer A
    assert.equal(machine.state.result, null);
    assert.equal(machine.state.loading, false);
  });
});
