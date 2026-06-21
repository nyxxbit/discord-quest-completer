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

// This is the real trust boundary: the renderer could be compromised and these handlers run
// in the privileged, CSP-free main process. Validate every renderer-supplied value that shapes
// the request, not just appId — appId and questId must be numeric, and the referrer must be
// https pointing exactly at this app's discordsays host.
const NUMERIC_ID = /^\d+$/;

function validParams(appId: string, questId: string, referrer: string): boolean {
    if (!NUMERIC_ID.test(String(appId)) || !NUMERIC_ID.test(String(questId))) return false;
    try {
        const u = new URL(referrer);
        return u.protocol === "https:" && u.hostname === `${appId}.discordsays.com`;
    } catch {
        return false;
    }
}

const rejected = (): DiscordSaysResponse => ({ ok: false, status: 0, body: JSON.stringify({ error: "invalid request params" }) });

export interface DiscordSaysResponse {
    ok: boolean;
    status: number;
    body: string;
}

async function discordsaysFetch(url: string, headers: Record<string, string>, body: string): Promise<DiscordSaysResponse> {
    try {
        // redirect:"error" so a 3xx can't bounce the X-Auth-Token / proxy-ticket Referer to
        // another host from the CSP-free main process. The acf endpoints answer 200/4xx directly.
        const res = await fetch(url, { method: "POST", headers, body, redirect: "error" });
        return { ok: res.ok, status: res.status, body: await res.text() };
    } catch (e: any) {
        return { ok: false, status: 0, body: JSON.stringify({ error: e?.message ?? String(e) }) };
    }
}

export async function discordsaysAuthorize(_: IpcMainInvokeEvent, opts: { appId: string; questId: string; authCode: string; referrer: string; }): Promise<DiscordSaysResponse> {
    if (!validParams(opts.appId, opts.questId, opts.referrer)) return rejected();
    return discordsaysFetch(
        `https://${opts.appId}.discordsays.com/.proxy/acf/authorize`,
        { "Content-Type": "application/json", "X-Auth-Token": "", "X-Discord-Quest-ID": opts.questId, Referer: opts.referrer },
        JSON.stringify({ code: opts.authCode })
    );
}

export async function discordsaysProgress(_: IpcMainInvokeEvent, opts: { appId: string; questId: string; token: string; target: number; referrer: string; }): Promise<DiscordSaysResponse> {
    if (!validParams(opts.appId, opts.questId, opts.referrer)) return rejected();
    return discordsaysFetch(
        `https://${opts.appId}.discordsays.com/.proxy/acf/quest/progress`,
        { "Content-Type": "application/json", "X-Auth-Token": opts.token, "X-Discord-Quest-ID": opts.questId, Referer: opts.referrer },
        JSON.stringify({ progress: opts.target })
    );
}
