/*
 * OrionQuests, a Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 *
 * Per-quest task lifetime tracking. A TaskControl belongs to exactly one
 * scheduler generation and never becomes active again after cancellation.
 */

export type Cleanup = () => void;

export interface CleanupResult {
    ran: number;
    failed: number;
}

export interface TaskLifecycle {
    isActive: (questId: string, generation: number) => boolean;
    signalFor: (questId: string, generation: number) => AbortSignal | null;
    addCleanup: (questId: string, generation: number, cleanup: Cleanup) => boolean;
    removeCleanup: (questId: string, generation: number, cleanup: Cleanup) => void;
    waitForDelay: (questId: string, generation: number, ms: number) => Promise<boolean>;
}

/**
 * Wait for a task-owned delay. Cancellation resolves false immediately instead of rejecting,
 * because callers use this only as a gate between pieces of forward work.
 */
export function waitForTaskDelay(ms: number, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);

    return new Promise<boolean>(resolve => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout>;

        const finish = (completed: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            resolve(completed);
        };
        const onAbort = () => finish(false);

        timer = setTimeout(() => finish(true), Math.max(0, ms));
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

export class TaskControl {
    public readonly cleanups = new Set<Cleanup>();
    public readonly cancelled: Promise<void>;
    public readonly controller = new AbortController();
    public active = true;
    public started = false;

    private resolveCancelled!: () => void;

    constructor(
        public readonly questId: string,
        public readonly generation: number,
    ) {
        this.cancelled = new Promise<void>(resolve => {
            this.resolveCancelled = resolve;
        });
    }

    /** One-way cancellation. This is the only transition that resolves `cancelled`. */
    cancel(): boolean {
        if (!this.active) return false;
        this.active = false;
        this.controller.abort();
        this.resolveCancelled();
        return true;
    }

    /**
     * Normal task settlement also retires a generation and aborts any forgotten child signal,
     * but it must not masquerade as cancellation. Resolving `cancelled` here can win a worker's
     * Promise.race before a real task rejection propagates and silently turn an exception into
     * a successful cancellation.
     */
    retire(): boolean {
        if (!this.active) return false;
        this.active = false;
        this.controller.abort();
        return true;
    }
}

export class TaskControlRegistry {
    private nextGeneration = 0;
    private readonly controls = new Map<string, TaskControl>();
    private readonly paused = new Set<string>();

    create(questId: string): TaskControl {
        // Even an inactive control can still own an in-flight direct request or compensating
        // cleanup. A replacement generation is not safe until release() proves that old work
        // has actually settled.
        if (this.controls.has(questId)) {
            throw new Error(`Quest ${questId} still has an unsettled task generation`);
        }

        const control = new TaskControl(questId, ++this.nextGeneration);
        this.controls.set(questId, control);
        return control;
    }

    get(questId: string): TaskControl | undefined {
        return this.controls.get(questId);
    }

    markStarted(questId: string, generation: number): boolean {
        const control = this.controls.get(questId);
        if (!control || control.generation !== generation || !control.active) return false;
        control.started = true;
        return true;
    }

    isActive(questId: string, generation: number): boolean {
        const current = this.controls.get(questId);
        return current?.generation === generation && current.active;
    }

    signalFor(questId: string, generation: number): AbortSignal | null {
        const current = this.controls.get(questId);
        return current?.generation === generation ? current.controller.signal : null;
    }

    isPaused(questId: string): boolean {
        return this.paused.has(questId);
    }

    pausedIds(): string[] {
        return Array.from(this.paused);
    }

    clearPaused(): string[] {
        const removed = Array.from(this.paused);
        this.paused.clear();
        return removed;
    }

    addCleanup(questId: string, generation: number, cleanup: Cleanup): boolean {
        const control = this.controls.get(questId);
        if (!control || control.generation !== generation || !control.active) return false;
        control.cleanups.add(cleanup);
        return true;
    }

    removeCleanup(questId: string, generation: number, cleanup: Cleanup): void {
        const control = this.controls.get(questId);
        if (control?.generation === generation) control.cleanups.delete(cleanup);
    }

    waitForDelay(questId: string, generation: number, ms: number): Promise<boolean> {
        const control = this.controls.get(questId);
        if (!control || control.generation !== generation || !control.active) return Promise.resolve(false);

        return waitForTaskDelay(ms, control.controller.signal).then(completed =>
            completed && this.isActive(questId, generation)
        );
    }

    /**
     * Record the user's latest pause intent even when there is no active generation to cancel.
     * This matters after Resume: an old generation may still be settling, or a queued generation
     * may already have been retired. A second Pause must still win immediately instead of forcing
     * the user to wait until the quest becomes RUNNING again.
     */
    pause(questId: string, onCleanupError?: (error: unknown) => void): CleanupResult | null {
        const control = this.controls.get(questId);
        const wasPaused = this.paused.has(questId);

        if (wasPaused && !control?.active) return null;
        this.paused.add(questId);

        // No active work is not the same as "cannot pause": the tombstone above is enough to
        // keep the scheduler from creating the next generation.
        if (!control?.active) return { ran: 0, failed: 0 };

        const result = this.cancelControl(control, onCleanupError);

        // A queue entry that no worker ever started owns no in-flight work, so there is no
        // settling generation to wait for. Retire it immediately; the paused set remains.
        if (!control.started && this.controls.get(questId) === control) {
            this.controls.delete(questId);
        }

        return result;
    }

    resume(questId: string): boolean {
        return this.paused.delete(questId);
    }

    pauseAll(
        shouldPause: (questId: string) => boolean = () => true,
        onCleanupError?: (error: unknown) => void,
    ): { quests: number; cleanups: CleanupResult; } {
        let quests = 0;
        let ran = 0;
        let failed = 0;

        for (const questId of Array.from(this.controls.keys())) {
            if (!shouldPause(questId)) continue;
            const result = this.pause(questId, onCleanupError);
            if (!result) continue;
            quests++;
            ran += result.ran;
            failed += result.failed;
        }

        return { quests, cleanups: { ran, failed } };
    }

    resumeAll(): number {
        const count = this.paused.size;
        this.paused.clear();
        return count;
    }

    /**
     * Global engine shutdown cancels every task without changing the user's paused set.
     * Started generations stay reserved until their underlying async work actually settles;
     * otherwise Stop -> Start could overlap a new quest generation with stale direct I/O or
     * compensating OAuth cleanup from the previous run.
     */
    cancelAll(onCleanupError?: (error: unknown) => void): CleanupResult {
        let ran = 0;
        let failed = 0;

        for (const [questId, control] of Array.from(this.controls.entries())) {
            if (control.active) {
                const result = this.cancelControl(control, onCleanupError);
                ran += result.ran;
                failed += result.failed;
            }

            // A never-started queue entry has no continuation that can settle later. Started
            // controls are deliberately retained and release() is their only retirement path.
            if (!control.started && this.controls.get(questId) === control) {
                this.controls.delete(questId);
            }
        }

        return { ran, failed };
    }

    /**
     * Retire a settled worker. Normal settlement deliberately does NOT resolve the cancellation
     * promise; otherwise a rejected worker can be mistaken for a successful cancellation by the
     * scheduler's Promise.race. Any forgotten cleanup is flushed defensively before deletion.
     */
    release(
        questId: string,
        generation: number,
        onCleanupError?: (error: unknown) => void,
    ): CleanupResult {
        const control = this.controls.get(questId);
        if (!control || control.generation !== generation) return { ran: 0, failed: 0 };

        control.retire();
        const result = this.runCleanups(control, onCleanupError);
        this.controls.delete(questId);
        return result;
    }

    prunePaused(validQuestIds: Set<string>): string[] {
        const removed: string[] = [];
        for (const questId of this.paused) {
            if (validQuestIds.has(questId)) continue;
            this.paused.delete(questId);
            removed.push(questId);
        }
        return removed;
    }

    private cancelControl(control: TaskControl, onCleanupError?: (error: unknown) => void): CleanupResult {
        control.cancel();
        return this.runCleanups(control, onCleanupError);
    }

    private runCleanups(control: TaskControl, onCleanupError?: (error: unknown) => void): CleanupResult {
        let ran = 0;
        let failed = 0;
        for (const cleanup of Array.from(control.cleanups)) {
            ran++;
            try {
                cleanup();
            } catch (error) {
                failed++;
                onCleanupError?.(error);
            }
        }
        control.cleanups.clear();
        return { ran, failed };
    }
}
