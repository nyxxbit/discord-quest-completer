/*
 * OrionQuests, a Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 *
 * Pure helpers for account-safe compensating OAuth cleanup.
 */

export interface OAuthGrantLike {
    id: string;
    application?: { id?: string; };
}

export type OAuthCleanupOutcome =
    | { status: "cleaned"; deleted: number; }
    | { status: "account-changed"; deleted: number; };

/**
 * Revoke only grants created after this task's snapshot, and never continue cleanup after the
 * active Discord account changes. Already-issued requests cannot be unsent, so account identity
 * is checked before the list request, after it settles, and before every DELETE boundary.
 */
export async function cleanupCreatedOAuthGrants(options: {
    accountId: string;
    appId: string;
    preGrantIds: Set<string>;
    getCurrentAccountId: () => string | null;
    listGrants: () => Promise<OAuthGrantLike[]>;
    deleteGrant: (id: string) => Promise<void>;
}): Promise<OAuthCleanupOutcome> {
    const {
        accountId,
        appId,
        preGrantIds,
        getCurrentAccountId,
        listGrants,
        deleteGrant,
    } = options;

    let deleted = 0;
    const sameAccount = () => getCurrentAccountId() === accountId;

    if (!sameAccount()) return { status: "account-changed", deleted };
    const after = await listGrants();
    if (!sameAccount()) return { status: "account-changed", deleted };

    const created = after.filter(grant =>
        grant.application?.id === appId && !preGrantIds.has(grant.id)
    );

    for (const grant of created) {
        if (!sameAccount()) return { status: "account-changed", deleted };
        await deleteGrant(grant.id);
        deleted++;
    }

    return { status: "cleaned", deleted };
}
