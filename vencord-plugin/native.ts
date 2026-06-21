/*
 * OrionQuests — Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 *
 * Native (main-process) IPC handlers. Discord's renderer CSP blocks
 * connect-src to *.discordsays.com — the ACHIEVEMENT bypass needs to
 * round-trip those POSTs through the main process where Node fetch
 * runs without CSP restrictions.
 */

import { IpcMainInvokeEvent } from "electron";

// appId is interpolated into the request URL. Validate it's purely numeric here,
// in the privileged main process, so compromised or malicious renderer code can't
// point these POSTs at an arbitrary host (main-process SSRF). This is the trust boundary.
const NUMERIC_ID = /^\d+$/;

export interface DiscordSaysResponse {
    ok: boolean;
    status: number;
    body: string;
}

async function discordsaysFetch(url: string, headers: Record<string, string>, body: string): Promise<DiscordSaysResponse> {
    try {
        const res = await fetch(url, { method: "POST", headers, body });
        return { ok: res.ok, status: res.status, body: await res.text() };
    } catch (e: any) {
        return { ok: false, status: 0, body: JSON.stringify({ error: e?.message ?? String(e) }) };
    }
}

export async function discordsaysAuthorize(_: IpcMainInvokeEvent, opts: { appId: string; questId: string; authCode: string; referrer: string; }): Promise<DiscordSaysResponse> {
    if (!NUMERIC_ID.test(String(opts.appId))) return { ok: false, status: 0, body: JSON.stringify({ error: "invalid appId" }) };
    return discordsaysFetch(
        `https://${opts.appId}.discordsays.com/.proxy/acf/authorize`,
        { "Content-Type": "application/json", "X-Auth-Token": "", "X-Discord-Quest-ID": opts.questId, Referer: opts.referrer },
        JSON.stringify({ code: opts.authCode })
    );
}

export async function discordsaysProgress(_: IpcMainInvokeEvent, opts: { appId: string; questId: string; token: string; target: number; referrer: string; }): Promise<DiscordSaysResponse> {
    if (!NUMERIC_ID.test(String(opts.appId))) return { ok: false, status: 0, body: JSON.stringify({ error: "invalid appId" }) };
    return discordsaysFetch(
        `https://${opts.appId}.discordsays.com/.proxy/acf/quest/progress`,
        { "Content-Type": "application/json", "X-Auth-Token": opts.token, "X-Discord-Quest-ID": opts.questId, Referer: opts.referrer },
        JSON.stringify({ progress: opts.target })
    );
}
