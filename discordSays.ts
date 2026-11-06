/*
 * OrionQuests Discord Says wire helpers.
 *
 * Kept Vencord-free so the request contract and response parsing can be covered
 * by the fast unit suite used outside a Vencord checkout.
 */

export interface DiscordSaysResponse {
    ok: boolean;
    status: number;
    body: string;
}

export interface DiscordSaysResponseError extends Error {
    status: number;
    body: unknown;
}

export function discordSaysProgressBody(progress: number, questId: string): string {
    return JSON.stringify({ progress, quest_id: questId });
}

export function discordSaysResponseError(
    stage: string,
    response: Pick<DiscordSaysResponse, "status" | "body">,
): DiscordSaysResponseError {
    let body: unknown = response.body;
    if (typeof response.body === "string") {
        try { body = JSON.parse(response.body); } catch { /* keep the original text */ }
    }

    let detail: string | null = null;
    if (body && typeof body === "object") {
        const value = body as Record<string, unknown>;
        if (typeof value.message === "string" && value.message.trim()) detail = value.message.trim();
        else if (typeof value.error === "string" && value.error.trim()) detail = value.error.trim();
    } else if (typeof body === "string" && body.trim()) {
        detail = body.trim().slice(0, 200);
    }

    const error = new Error(detail ?? `${stage} ${response.status}`) as DiscordSaysResponseError;
    error.status = response.status;
    error.body = body;
    return error;
}
