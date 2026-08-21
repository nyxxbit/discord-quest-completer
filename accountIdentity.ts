/*
 * OrionQuests, a Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 */

/**
 * A missing identity is an observation gap, not evidence that Discord switched accounts.
 * Only a different confirmed non-null id proves that account-owned runtime state is stale.
 */
export function isConfirmedDifferentAccount(currentUserId: string | null, expectedUserId: string): boolean {
    return currentUserId != null && currentUserId !== expectedUserId;
}
