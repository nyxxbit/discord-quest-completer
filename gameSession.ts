/*
 * OrionQuests, a Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 *
 * One spoofed process per application, owned by the group of its accepted quests (issue #96).
 *
 * The group opens a single shared session before its members run and closes it after the last
 * one settles, so a member that pauses or finishes early never removes a process a sibling still
 * needs. The orchestration is pure so it can be exercised without a Discord to patch; the open
 * and close side effects (fetch, spoof, teardown) live in the TaskRunner and Patcher.
 */

export interface GameSession {
    open(): Promise<void>;
    close(): void;
}

/**
 * Run every member of an application's quest group against one shared session. The session is
 * opened once up front and closed once in a finally, so the one process outlives any member that
 * pauses or completes early and is torn down exactly once, after they have all settled. Members
 * run concurrently; a member that rejects is contained by allSettled and still lets the rest run.
 */
export async function runSharedGameSession(
    members: { run(): Promise<void>; }[],
    session: GameSession,
): Promise<void> {
    await session.open();
    try {
        await Promise.allSettled(members.map(m => m.run()));
    } finally {
        session.close();
    }
}
