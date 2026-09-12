(async () => {
    "use strict";

    /* ── config (Safe for users to edit) ────────────────────────── */

    const CONFIG = {
        NAME: "Orion",
        VERSION: "v4.11.1",
        THEME: "#5865F2",             // discord blurple
        SUCCESS: "#3BA55C",
        WARN: "#faa61a",
        ERR: "#f04747",
        HIDE_ACTIVITY: false,           // hide "Playing ..." while quests run (turns Discord's own
                                        // showCurrentGame off for the duration, restores it after)
        MAX_LOG_ITEMS: 60               // UI log limit
    };

    /* ── internal system limits (DO NOT EDIT) ─────────────────── */

    const SYS = Object.freeze({
        MAX_TIME: 25 * 60 * 1000,       // hard abort per task (25 min)
        HEARTBEAT_GRACE: 90 * 1000,     // GAME/STREAM: give up if Discord sends no heartbeat
        MAX_TASK_FAILURES: 5,           // consecutive network failures
        MAX_RETRIES: 3,                 // 429/5xx transient error retries
        IS_DESKTOP: typeof window.DiscordNative !== 'undefined'
    });

    // mutable runtime state lives here, CONFIG stays read-only
    const RUNTIME = {
        running: true,
        cleanups: new Set(),            // tracks active event listeners for safe shutdown
        autoEnroll: true,               // whether to auto-enroll in quests before execution
        autoClaim: false,               // whether to try auto-claiming quest rewards
        playSound: false,               // whether to play an audio cue on quest completion
        randomDelay: false              // whether to inject randomized 1-30min idle gaps between quests (anti-detection)
    };

    /* ── audio cue ───────────────────────────────────────────────── */
    const Sound = {
        _ctx: null,
        play(type) {
            if (!RUNTIME.playSound) return;
            try {
                const Ctx = window.AudioContext || window.webkitAudioContext;
                if (!Ctx) return;
                // reuse one context; Chromium caps ~6 concurrent AudioContexts and a long
                // run with sound on would otherwise hit the cap and go silently dead.
                if (!this._ctx || this._ctx.state === 'closed') this._ctx = new Ctx();
                const ctx = this._ctx;
                const o = ctx.createOscillator();
                const g = ctx.createGain();
                o.connect(g); g.connect(ctx.destination);
                o.type = 'sine';
                const t0 = ctx.currentTime;
                if (type === 'done') {
                    // C5 E5 G5 arpeggio
                    o.frequency.setValueAtTime(523.25, t0);
                    o.frequency.setValueAtTime(659.25, t0 + 0.12);
                    o.frequency.setValueAtTime(783.99, t0 + 0.24);
                    g.gain.setValueAtTime(0.55, t0);
                    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.55);
                    o.start(t0); o.stop(t0 + 0.6);
                } else {
                    o.frequency.value = 880; // A5
                    g.gain.setValueAtTime(0.45, t0);
                    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.18);
                    o.start(t0); o.stop(t0 + 0.2);
                }
            } catch (_) { }
        }
    };

    /* ── OAuth consent gate ──────────────────────────────────────
       Shown before the ACHIEVEMENT bypass OAuth-authorizes a quest's
       app on the user's account. Per-app, per-run, in-memory only and
       never persisted, so it can't silently authorize forever. Default
       decline: Cancel / Esc / backdrop / 60s idle all resolve false, so
       an AFK user never authorizes anything. CSP-safe (addEventListener,
       app name via textContent so it can't inject markup).
    ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── */
    const Consent = {
        _granted: new Set(),
        TIMEOUT: 60000,
        SCOPES: ['identify', 'applications.commands', 'applications.entitlements'],
        ask(appId, appName) {
            if (this._granted.has(appId)) return Promise.resolve(true);
            return new Promise(resolve => {
                const ov = document.createElement('div');
                ov.id = 'orion-consent';
                ov.style.cssText = 'position:fixed;inset:0;z-index:1002;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);font-family:var(--font-primary);';
                ov.innerHTML = `<div style="width:420px;max-width:92vw;background:var(--background-base-low);border:1px solid var(--border-subtle);border-radius:var(--radius-lg);box-shadow:var(--shadow-button-overlay);color:var(--text-default);overflow:hidden;">
                    <div style="padding:14px 16px;background:var(--background-mod-muted);border-bottom:1px solid var(--border-subtle);font-weight:700;color:var(--text-strong);">Authorize application?</div>
                    <div style="padding:16px;font-size:13px;line-height:1.5;">
                        <div>To complete this achievement quest, Orion needs to OAuth-authorize this app on your Discord account:</div>
                        <div id="oc-app" style="font-weight:700;color:var(--text-strong);margin:6px 0;"></div>
                        <div style="color:var(--text-muted);">Scopes requested:</div>
                        <ul id="oc-scopes" style="margin:4px 0 10px;padding-left:18px;color:var(--text-muted);"></ul>
                        <div style="color:var(--text-feedback-warning);">The app's backend receives a real authorization code. Orion revokes the grant immediately after the quest is marked complete. Discord enforcement against quest automation can affect the whole account.</div>
                        <label style="display:flex;gap:8px;align-items:center;margin-top:12px;font-size:12px;color:var(--text-muted);">
                            <input type="checkbox" id="oc-remember" class="native-cb"> Don't ask again for this app this session</label>
                    </div>
                    <div style="display:flex;gap:10px;padding:12px 16px;border-top:1px solid var(--border-subtle);">
                        <button id="oc-no" class="quest-pick-btn deselect" style="flex:1;">Cancel</button>
                        <button id="oc-yes" class="quest-pick-btn start" style="flex:1;">Authorize</button>
                    </div></div>`;
                document.body.appendChild(ov);
                ov.querySelector('#oc-app').textContent = appName ? `${appName} (${appId})` : `App ${appId}`;
                const ul = ov.querySelector('#oc-scopes');
                this.SCOPES.forEach(s => { const li = document.createElement('li'); li.textContent = s; ul.appendChild(li); });
                let done = false;
                const finish = v => {
                    if (done) return; done = true;
                    clearTimeout(timer); document.removeEventListener('keydown', onKey);
                    if (v && ov.querySelector('#oc-remember').checked) this._granted.add(appId);
                    ov.remove(); resolve(v);
                };
                const onKey = e => { if (e.key === 'Escape') finish(false); };
                ov.querySelector('#oc-yes').addEventListener('click', () => finish(true));
                ov.querySelector('#oc-no').addEventListener('click', () => finish(false));
                ov.addEventListener('mousedown', e => { if (e.target === ov) finish(false); });
                document.addEventListener('keydown', onKey);
                const timer = setTimeout(() => finish(false), this.TIMEOUT);
            });
        }
    };

    const ICONS = Object.freeze({
		OPT: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M10.56 1.1c-.46.05-.7.53-.64.98.18 1.16-.19 2.2-.98 2.53-.8.33-1.79-.15-2.49-1.1-.27-.36-.78-.52-1.14-.24-.77.59-1.45 1.27-2.04 2.04-.28.36-.12.87.24 1.14.96.7 1.43 1.7 1.1 2.49-.33.8-1.37 1.16-2.53.98-.45-.07-.93.18-.99.64a11.1 11.1 0 0 0 0 2.88c.06.46.54.7.99.64 1.16-.18 2.2.19 2.53.98.33.8-.14 1.79-1.1 2.49-.36.27-.52.78-.24 1.14.59.77 1.27 1.45 2.04 2.04.36.28.87.12 1.14-.24.7-.95 1.7-1.43 2.49-1.1.8.33 1.16 1.37.98 2.53-.07.45.18.93.64.99a11.1 11.1 0 0 0 2.88 0c.46-.06.7-.54.64-.99-.18-1.16.19-2.2.98-2.53.8-.33 1.79.14 2.49 1.1.27.36.78.52 1.14.24.77-.59 1.45-1.27 2.04-2.04.28-.36.12-.87-.24-1.14-.96-.7-1.43-1.7-1.1-2.49.33-.8 1.37-1.16 2.53-.98.45.07.93-.18.99-.64a11.1 11.1 0 0 0 0-2.88c-.06-.46-.54-.7-.99-.64-1.16.18-2.2-.19-2.53-.98-.33-.8.14-1.79 1.1-2.49.36-.27.52-.78.24-1.14a11.07 11.07 0 0 0-2.04-2.04c-.36-.28-.87-.12-1.14.24-.7.96-1.7 1.43-2.49 1.1-.8-.33-1.16-1.37-.98-2.53.07-.45-.18-.93-.64-.99a11.1 11.1 0 0 0-2.88 0ZM16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z"/></svg>`,
        BOLT: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M11 21h-1l1-7H7.5c-.58 0-.57-.32-.29-.62L14.5 3h1l-1 7h3.5c.58 0 .57.32.29.62L11 21z"/></svg>`,
        VIDEO: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M10 16.5l6-4.5-6-4.5v9zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>`,
        GAME: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M21 6H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-10 7H8v3H6v-3H3v-2h3V8h2v3h3v2zm4.5 2c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm4-3c-.83 0-1.5-.67-1.5-1.5S18.67 9 19.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>`,
        STREAM: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>`,
        ACTIVITY: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z"/></svg>`,
        CHECK: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`,
        CLOCK: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"/><path d="M12.5 7H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>`,
        STOP: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>`
    });

    const CONST = Object.freeze({
        ID: "1412491570820812933",  // blacklisted quest, known to break enrollment
        EVT: Object.freeze({
            HEARTBEAT: "QUESTS_SEND_HEARTBEAT_SUCCESS",
            // Discord dispatches this when its own heartbeat POST fails, carrying the error and
            // the quest id. Without it a failed beat is indistinguishable from silence, which is
            // how a single transient error used to end a game quest 90s later (issue #74).
            HEARTBEAT_FAIL: "QUESTS_SEND_HEARTBEAT_FAILURE",
            GAME: "RUNNING_GAMES_CHANGE",
            RPC: "LOCAL_ACTIVITY_UPDATE"
        })
    });

    // bail early if another instance is already running in this tab
    if (window.orionLock) {
        const existingUI = document.getElementById('orion-ui');
        if (existingUI) existingUI.style.display = 'flex';
        return console.warn(`[${CONFIG.NAME}] Already running.`);
    }
    window.orionLock = true;

    /* ── util ──────────────────────────────────────────────────── */

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const rnd = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

    // Escape server-controlled strings before they touch innerHTML. Quest and reward names
    // come from Discord API fields (questName, reward name) and can carry markup; a crafted
    // title like "><img src=x onerror=...> would otherwise inject into the dashboard DOM,
    // the exact inline-injection Discord's CSP exists to stop.
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // expiresAt is occasionally missing/malformed mid-rollout. new Date(undefined) is NaN and
    // `NaN > now` is always false, which would silently drop the quest with no log. Treat an
    // unparseable expiry as "not expired" so we attempt the quest instead of hiding it.
    // Discord keeps its own expiry verdict in QuestStore, refreshed on every user-status update
    // and rearmed by a timer, and its default when it has no entry is NOT expired. Ask it first
    // and only fall back to reading the timestamp ourselves.
    const notExpired = q => {
        try {
            const store = Mods.QuestStore;
            if (typeof store?.isQuestExpired === 'function') return store.isQuestExpired(q.id) !== true;
        } catch (_) { /* fall through to the timestamp */ }
        const e = new Date(q.config?.expiresAt ?? 0).getTime();
        return Number.isNaN(e) || e > Date.now();
    };

    // Orbs a quest pays out, as { orbs, premium }, or null when it pays none. Every reward entry
    // is summed. The quantity sits on the entry and a quest can list several, so reading
    // rewards[0] reports no Orbs at all for a quest that lists an in-game item first.
    // premiumOrbQuantity is Discord's own Nitro figure and is sometimes absent or equal, so it
    // falls back to the base number rather than being multiplied here.
    const orbReward = config => {
        const rewards = config?.rewardsConfig?.rewards;
        if (!Array.isArray(rewards)) return null;
        const amount = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

        let orbs = 0, premium = 0;
        for (const r of rewards) {
            const base = amount(r?.orbQuantity);
            if (!base) continue;
            orbs += base;
            premium += amount(r?.premiumOrbQuantity) || base;
        }
        return orbs > 0 ? { orbs, premium } : null;
    };

    // The Nitro figure is only named when it differs, so a non-subscriber is not told the same
    // number twice.
    const fmtOrbs = reward => {
        if (!reward) return '';
        return reward.premium > reward.orbs ? `${reward.orbs} Orbs (${reward.premium} with Nitro)` : `${reward.orbs} Orbs`;
    };

    // The Orb balance Discord reports for the account, or null for anything that is not a whole
    // non-negative number. Zero is a real balance and is kept, unlike a payout of zero.
    const orbBalance = v => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

    // Orbs on the account. VirtualCurrencyStore holds the figure Discord's own Orb pill shows
    // once the client has fetched it, so that is read first. Before then it is null and one GET
    // of the balance endpoint fills it in. Nothing polls; this runs once when the picker opens.
    const readOrbBalance = async () => {
        const stored = orbBalance(Mods.OrbStore?.balance);
        if (stored !== null) return stored;
        const res = await Mods.API.get({ url: '/users/@me/virtual-currency/balance' });
        return orbBalance(res?.body?.balance);
    };

    // The server-sealed attribution blob Discord echoes back when enrolling in or claiming a
    // quest. The server issues it per quest and ships it with the quest list; the client
    // returns it unmodified. Orion sent neither sealed field, so every enrollment and claim it
    // made lacked something present on every request the real client sends. Nothing is forged
    // here: this is the server's own value going back where it came from.
    const sealedFor = questId => {
        try { return Mods.QuestStore?.getQuest?.(questId)?.trafficMetadataSealed ?? null; }
        catch (_) { return null; }
    };

    // When Discord has blocked quest enrollment for this account, as a Date, otherwise null.
    // `QuestStore.questEnrollmentBlockedUntil` comes from the same `/quests/@me` response the
    // client already fetches, so reading it costs nothing and adds no request. A block is the
    // clearest signal Discord gives that it has taken an interest in the account, and carrying
    // on through it is both futile and the worst available response to it.
    // Console task keys. Discord groups them as CONSOLE and no desktop client can drive them.
    const CONSOLE_ONLY_KEYS = new Set(['PLAY_ON_XBOX', 'PLAY_ON_PLAYSTATION']);

    // The task table comes out of Discord's own store, which hands some payloads back as a Map.
    // Indexing one of those with [] reads undefined and looks like a quest with no tasks, so
    // every read of it goes through these two.
    const taskKeys = (tasks) => (tasks instanceof Map ? [...tasks.keys()] : Object.keys(tasks ?? {}));
    const taskAt = (tasks, key) => (tasks instanceof Map ? tasks.get(key) : tasks?.[key]);

    // Discord's current taskConfigV2 is authoritative when it carries tasks. Some payloads keep
    // the legacy taskConfig beside it, and nullish-coalescing legacy first routes the quest
    // through stale task/app metadata, which is how this script and the plugin could reach
    // different answers about the same quest. Same rule as selectQuestTaskConfig in
    // questConfig.ts, which has regression tests for it.
    const selectTaskConfig = (config) => {
        const current = config?.taskConfigV2;
        if (taskKeys(current?.tasks).length > 0) return current;
        const legacy = config?.taskConfig;
        if (taskKeys(legacy?.tasks).length > 0) return legacy;
        return current ?? legacy ?? null;
    };

    // Task keys Discord validates somewhere this script cannot reach, mapped to why.
    // ACHIEVEMENT_IN_GAME is not ACHIEVEMENT_IN_ACTIVITY: no embedded activity, no discordsays
    // backend to report progress to, so the bypass has nothing to authorize against. The quest
    // wants an achievement inside the retail game with the game linked to the account.
    const UNAUTOMATABLE_KEYS = new Map([
        ['ACHIEVEMENT_IN_GAME', 'That needs the game linked to your account and an achievement earned inside the game itself, which nothing running in Discord can do for you.']
    ]);

    /*
     * Why this client cannot drive a quest, as the sentence to log, or null when it can drive it.
     *
     * The loop used to answer this with five separate guards, four of which logged and returned
     * without adding the quest to `Tasks.skipped`. The active filter reads that set, so those four
     * handed the same quest back on the next cycle and the run looped on it until the user
     * stopped it (issue #78). Answering in one place keeps the decision and the marking together,
     * so a new reason cannot be added without the caller skipping the quest.
     *
     * Every reason is permanent for the life of a run: the task config, the desktop-ness of the
     * client and the target do not change while Orion runs, and a fresh start re-reads all three.
     */
    const questBlocker = ({ name, hasTaskConfig, keys, typeData, isDesktop }) => {
        if (!hasTaskConfig) return `"${name}" has no usable task config, so there is nothing to drive.`;

        if (!typeData) {
            if (!keys.length) return `"${name}" lists no tasks at all, so there is nothing to drive.`;
            if (keys.every(k => CONSOLE_ONLY_KEYS.has(k))) return `"${name}" is console-only (${keys.join(', ')}), so no desktop client can run it.`;

            // The reason belongs to one key, so a quest carrying several says which one it
            // explains rather than attaching the sentence to the whole list.
            const named = keys.find(k => UNAUTOMATABLE_KEYS.has(k));
            if (named) {
                return keys.length === 1
                    ? `"${name}" offers only ${named}. ${UNAUTOMATABLE_KEYS.get(named)}`
                    : `"${name}" offers ${keys.join(', ')}, and none of them run here. The one we know about is ${named}. ${UNAUTOMATABLE_KEYS.get(named)}`;
            }

            return `"${name}" uses an unsupported task type (${keys.join(', ')}).`;
        }

        const { type, target, appId } = typeData;

        if (!isDesktop && (type === 'GAME' || type === 'STREAM')) return `"${name}" needs the desktop app for its ${type} task.`;
        if (target <= 0) return `"${name}" has an invalid target (${target}).`;
        // GAME/STREAM impersonate a specific application. Without a real id the fake process is
        // unidentifiable and Discord silently never counts it, so skip rather than run a task
        // that cannot finish (issue #43).
        if ((type === 'GAME' || type === 'STREAM') && !appId) return `"${name}" has no application id in its config, so the game cannot be spoofed.`;

        return null;
    };

    /*
     * What happened to a quest, recorded where the run decides it. Completed wins over an earlier
     * blocked or failed: a quest this client could not drive and the user then finished by hand is
     * finished, and must not be counted in both columns.
     */
    const recordOutcome = (outcomes, id, outcome) => {
        if (outcomes.get(id) === 'completed') return;
        outcomes.set(id, outcome);
    };

    /*
     * The wrap-up for a run with nothing left to do. failTask puts a quest in the skipped set as
     * surely as questBlocker does, so a run whose only quest died in a handler used to empty the
     * active list and announce that every quest was completed, with the done sound.
     */
    const summarizeRun = (outcomes) => {
        let finished = 0, blocked = 0, failed = 0;
        for (const outcome of outcomes.values()) {
            if (outcome === 'completed') finished++;
            else if (outcome === 'blocked') blocked++;
            else failed++;
        }

        if (!blocked && !failed) return { finished, blocked, failed, line: 'All available quests are completed!', playDone: true };

        const parts = [];
        if (finished) parts.push(`${finished} quest(s) finished`);
        if (blocked) parts.push(`${blocked} skipped because this client cannot drive them`);
        if (failed) parts.push(`${failed} failed`);
        return { finished, blocked, failed, line: `Nothing left to run. ${parts.join(', ')}.`, playDone: finished > 0 };
    };

    const futureDate = (raw) => {
        try {
            if (!raw) return null;
            const when = raw instanceof Date ? raw : new Date(raw);
            return Number.isNaN(when.getTime()) || when.getTime() <= Date.now() ? null : when;
        } catch (_) { return null; }
    };

    const enrollmentBlockedUntil = () => futureDate(Mods.QuestStore?.questEnrollmentBlockedUntil);

    // Discord returns this beside questEnrollmentBlockedUntil on the quest list fetch and its own
    // client refuses to start any unfinished quest while it is set. Enrollment being blocked stops
    // new quests; access being suspended stops everything.
    const questAccessSuspendedUntil = () => {
        const store = Mods.QuestStore;
        if (!store) return null;
        const explicit = futureDate(store.questAccessSuspendedUntil);
        if (explicit) return explicit;
        return store.isQuestAccessSuspended === true ? new Date(0) : null;
    };

    // Discord joins stream key parts with a colon and the trailing component is the stream
    // owner: `call:<channelId>:<ownerId>` for a DM, `guild:<guildId>:<channelId>:<ownerId>`
    // for a guild voice channel, and its decoder reads them back in that order. This used to
    // build `call:<channelId>:<rnd(1000,9999)>`, which put a four digit number where a user
    // snowflake belongs and used the DM prefix even for a guild channel.
    const buildStreamKey = () => {
        try {
            const ownerId = Mods.UserStore?.getCurrentUser?.()?.id;
            if (!ownerId) return null;

            const dm = Mods.ChanStore?.getSortedPrivateChannels()?.[0]?.id;
            if (dm) return `call:${dm}:${ownerId}`;

            for (const g of Object.values(Mods.GuildChanStore?.getAllGuilds() ?? {})) {
                const vc = g?.VOCAL?.[0]?.channel;
                const guildId = vc?.guild_id ?? g?.id;
                if (vc?.id && guildId) return `guild:${guildId}:${vc.id}:${ownerId}`;
            }
            return null;
        } catch (e) {
            Logger.log(`[Task] Stream key lookup error: ${e.message}`, 'debug');
            return null;
        }
    };

    /* ── error classification ─────────────────────────────────── */
    // Traffic uses this to decide: retry, skip, or propagate.
    // 429/5xx = transient → backoff & retry.  4xx = permanent → skip quest.

    const ErrorHandler = {
        RETRYABLE: new Set([429, 500, 502, 503, 504, 408]),
        CLIENT_ERRORS: new Set([400, 403, 404, 409, 410]),

        classify(error) {
            const status = error?.status ?? error?.statusCode;
            return {
                isRetryable: this.RETRYABLE.has(status),
                isClientError: this.CLIENT_ERRORS.has(status),
                status,
                message: error?.message ?? error?.body?.message ?? `HTTP ${status ?? 'UNKNOWN'}`
            };
        },

        // 404 = quest removed server-side, 403 = region/permission, 410 = gone
        isSkippableQuest(error) {
            const status = error?.status;
            return status === 404 || status === 403 || status === 410;
        }
    };

    /* ── UI + logger ────────────────────────────────────────────
       Injects a draggable dashboard into Discord's DOM.
       Doubles as task-state store. render() rebuilds on every update.
    ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── */

    const Logger = {
        root: null, tasks: new Map(), tickerId: null, _hotkey: null,

        init() {
            const oldUI = document.getElementById('orion-ui'); if (oldUI) oldUI.remove();
            const oldStyle = document.getElementById('orion-styles'); if (oldStyle) oldStyle.remove();

            const style = document.createElement('style');
            style.id = 'orion-styles';
            style.innerHTML = `
                @keyframes slideIn { from { transform: translateY(-20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
                @keyframes fadeOut { from { opacity: 1; transform: scale(1); } to { opacity: 0; transform: scale(0.95); margin: 0; padding: 0; height: 0; border: none; } }

                #orion-ui {
                    position: fixed; top: 32px; left: auto; right: 20px; width: 380px;
                    max-height: 53vh;
                    background: var(--background-base-low); color: var(--text-default);
                    border: 1px solid var(--border-subtle); border-radius: var(--radius-lg);
                    box-shadow: var(--shadow-button-overlay); z-index: 1001;
                    font-family: var(--font-primary);
                    overflow: hidden; animation: slideIn 0.3s ease; 
                    display: flex; flex-direction: column; box-sizing: border-box;
                    user-select: none;-webkit-app-region: no-drag;
                }

                #orion-head { padding: 12px 16px; background: var(--background-mod-muted); flex: 0 0 auto; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-subtle); cursor: grab; }
                #orion-head.dragging { cursor: grabbing; background: var(--control-secondary-background-default); }
                #orion-title { font-weight: 700; font-size: 15px; color: var(--text-strong); display: flex; align-items: center; gap: 8px; }
                #orion-title svg { color: var(--text-brand); }
                .dev-credit { font-size: 12px; margin-left: -4px; padding-top: 2px; font-weight: 500; color: var(--text-muted); }

                #orion-controls { display: flex; gap: 10px; align-items: center; }
                .ctrl-btn { cursor: pointer; transition: 0.2s; display: flex; align-items: center; }
                .ctrl-hide, .ctrl-opts { font-size: 11px; font-weight: 600; color: var(--text-muted); }
                .ctrl-hide:hover, .ctrl-opts:hover { color: var(--text-default); }
                .ctrl-stop { font-size: 11px; font-weight: 700; gap: 4px; padding: 3px 8px 3px 6px; border-radius: var(--radius-sm); background: transparent; border: 1px solid var(--control-critical-primary-background-default); color: var(--control-critical-primary-background-default); }
                .ctrl-stop:hover { background: var(--control-critical-primary-background-default); color: #fff; }

                #orion-logs { padding: 10px 14px; background: var(--background-base-lower); flex: 0 0 auto; font-family: 'Consolas', 'Monaco', monospace; font-size: 11px; height: 110px; overflow-y: auto; border-top: 1px solid var(--border-subtle); scroll-behavior: smooth; }
                .log-item { margin-bottom: 6px; display: flex; gap: 8px; line-height: 1.4; padding-bottom: 4px; }
                .log-ts { opacity: 0.5; min-width: 50px; font-size: 10px; }
                .c-info { color: var(--text-feedback-info); opacity: .8; } .c-success { color: var(--text-feedback-positive); } .c-err { color: var(--text-feedback-critical); } .c-warn { color: var(--text-feedback-warning); } .c-debug { color: #949ba4; }

                #orion-body { flex: 1 1 auto; padding: 12px; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }

                #orion-picker-form { display: flex; flex-direction: column; min-height: 0; }

                #orion-ui ::-webkit-scrollbar { width: 4px; height: 4px; }
                #orion-ui ::-webkit-scrollbar-track { background: transparent; }
                #orion-ui ::-webkit-scrollbar-thumb { background: var(--scrollbar-auto-scrollbar-color-thumb); border-radius: 4px; }

                .task-card { 
                    --state-color: var(--ansi-bright-blue);
                    --icon-bg-opacity: 15%;
                    --icon-color: var(--state-color);

                    display: flex; gap: 12px; padding: 10px 12px; margin-bottom: 8px; align-items: center;
                    background: var(--control-secondary-background-default); 
                    border-radius: var(--radius-sm); border: 1px solid var(--border-muted); 
                    border-left: 4px solid var(--state-color);
                    box-shadow: var(--shadow-low); transition: 0.3s; flex-shrink: 0;
                }
                .task-card.removing { animation: fadeOut 0.4s forwards; }
                .task-card.done { --state-color: var(--ansi-green); --icon-bg-opacity: 100%; --icon-color: #fff; }
                .task-card.failed { --state-color: var(--ansi-red); }
                .task-card.pending { --state-color: var(--ansi-bright-yellow); }

                .task-icon { position: relative; width: 40px; height: 40px; border-radius: 50%; flex: 0 0 auto; background-color: color-mix(in srgb, var(--state-color) var(--icon-bg-opacity), transparent); display: flex; align-items: center; justify-content: center; }

                .task-card.running .task-icon::before { content: ''; position: absolute; inset: 0; border-radius: 50%; z-index: 1; background: conic-gradient(lch(71 59 139) 0% var(--p, 0%), var(--border-subtle) var(--p, 0%) 100%); -webkit-mask-image: radial-gradient(circle at center, transparent 16px, black 17px); mask-image: radial-gradient(circle at center, transparent 16px, black 17px); }

                .task-icon-inner { z-index: 2; color: var(--icon-color); display: flex; transition: filter 0.2s, opacity 0.2s; }
                .task-card.running:hover .task-icon-inner { filter: blur(2px); opacity: 0.3; }

                .task-icon-overlay { position: absolute; inset: 0; z-index: 3; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 800; color: var(--text-default); opacity: 0; transition: opacity 0.2s; pointer-events: none; }
                .task-card.running:hover .task-icon-overlay { opacity: 1; }

                .task-info { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; justify-content: center; }
                .task-status { font-size: 10px; font-weight: 800; color: var(--state-color); text-transform: uppercase; letter-spacing: 0.5px; }
                .task-name { font-size: 13px; font-weight: 700; color: var(--text-strong); letter-spacing: 0.2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.2; }
                .task-meta { font-size: 11px; font-weight: 700; color: var(--text-muted); display: flex; justify-content: space-between; }
                .task-actions { flex: 0 0 auto; display: flex; align-items: center; margin-left: 4px; }

                .claim-btn, .goto-btn { padding: 6px 10px; border: none; border-radius: var(--radius-sm); font-size: 11px; font-weight: 700; cursor: pointer; transition: 0.2s; text-transform: uppercase; letter-spacing: 0.2px; white-space: nowrap; font-family: inherit; color: #fff; }
                .claim-btn { background: var(--control-connected-background-default); }
                .claim-btn:hover:not(:disabled) { background: var(--control-connected-background-hover); }
                .claim-btn:disabled { opacity: 0.5; cursor: not-allowed; }
                .claim-btn.failed { background: var(--control-secondary-background-active); color: var(--text-default); }
                .goto-btn { background: var(--control-primary-background-default); }
                .goto-btn:hover:not(:disabled) { background: var(--control-primary-background-hover); }

                .picker-section-title { font-size: 11px; font-weight: 700; color: var(--text-muted); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; flex-shrink: 0; }
                .reward-filters { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; flex-shrink: 0; }

                .reward-filter, .type-filter { background-color: transparent; border: 2px solid; padding: 4px 10px; border-radius: 24px; font-size: 10px; font-weight: 600; cursor: pointer; transition: 0.2s; color: var(--text-subtle); font-family: inherit; }
                .reward-filter:hover, .type-filter:hover { background-color: color-mix(in srgb, currentColor 25%, transparent); }
                .reward-filter.off, .type-filter.off { background: transparent; color: var(--text-muted); opacity: 0.4; }

                .picker-quest-list { display: flex; flex-direction: column; gap: 8px; flex: 1 1 auto; min-height: 50px; overflow-y: auto; padding-right: 4px; }

                .quest-pick { display: flex; gap: 12px; padding: 10px; background: var(--control-secondary-background-default); border-radius: var(--radius-sm); border: 1px solid var(--border-muted); border-left-width: 4px; cursor: pointer; transition: 0.2s; align-items: center; user-select: none; flex-shrink: 0; }
                .quest-pick:hover { filter: brightness(1.15); }
                .quest-pick.hidden { display: none !important; }

                .native-cb { appearance: none; width: 20px; height: 20px; margin: 0; flex-shrink: 0; border: 1px solid var(--checkbox-border-default); border-radius: var(--radius-xs); background: transparent; cursor: pointer; transition: 0.15s; display: grid; place-content: center; }
                .native-cb::before {
                    content: ''; width: 12px; height: 12px; opacity: 0; transition: 0.1s;
                    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='20 6 9 17 4 12'%3E%3C/polyline%3E%3C/svg%3E");
                    background-size: contain; background-repeat: no-repeat; background-position: center;
                }
                .native-cb:checked { background: var(--checkbox-background-selected-default); border-color: var(--checkbox-border-selected-default); }
                .native-cb:checked::before { opacity: 1; }

                .picker-options { display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
                .orion-option { display: flex; justify-content: space-between; align-items: center; background: var(--control-secondary-background-default); padding: 8px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-muted); }
                .orion-option-label { font-size: 13px; font-weight: 500; color: var(--text-default); }

                .native-toggle { appearance: none; width: 40px; height: 20px; margin: 0; flex-shrink: 0; background: var(--control-secondary-background-default); border-radius: 12px; cursor: pointer; position: relative; transition: 0.2s; border: 1px solid var(--border-muted); }
                .native-toggle::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; background: white; border-radius: 50%; box-shadow: var(--shadow-low); transition: 0.2s; }
                .native-toggle:checked { background: var(--control-primary-background-default); }
                .native-toggle:checked::after { transform: translateX(20px); }

                .orb-total { display: none; padding-top: 12px; font-size: 11px; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; color: #5865F2; text-align: center; flex-shrink: 0; }
                .picker-actions { display: flex; gap: 10px; padding-top: 12px; flex-shrink: 0; }
                .quest-pick-btn { flex: 1; padding: 10px; border: 1px solid; border-radius: var(--radius-sm, 8px); font-size: 13px; font-weight: 700; cursor: pointer; transition: 0.2s; display: flex; align-items: center; justify-content: center; gap: 6px; font-family: inherit; color: #fff;}
                .quest-pick-btn.start { background-color: var(--control-connected-background-default); border-color: var(--control-connected-border-default); }
                .quest-pick-btn.start:hover:not(:disabled) { background: var(--control-connected-background-hover); border-color: var(--control-connected-border-hover); }
                .quest-pick-btn.deselect { background-color: var(--control-secondary-background-default); border-color: var(--control-secondary-border-default); color: var(--text-default); }
                .quest-pick-btn.deselect:hover:not(:disabled) { background: var(--control-secondary-background-hover); }
                .quest-pick-btn:disabled { opacity: 0.5; cursor: not-allowed; }
            `;
            document.head.appendChild(style);

            this.root = document.createElement('div');
            this.root.id = 'orion-ui';
            this.root.innerHTML = `
                <div id="orion-head">
                    <span id="orion-title">${ICONS.BOLT} ${CONFIG.NAME}
                        <span class="dev-credit">by syntt_</span>
                        <span style="opacity:0.6; font-size:10px; margin-left:4px; padding-top: 3px; font-weight:500;">${CONFIG.VERSION}</span>
                    </span>
                    <div id="orion-controls">
                        <span class="ctrl-btn ctrl-stop" id="orion-stop" title="Stop script">${ICONS.STOP} STOP</span>
                        <span class="ctrl-btn ctrl-hide" id="orion-close" title="Shift + .">HIDE</span>
                        <span class="ctrl-btn ctrl-opts" id="orion-opts" title="Options">${ICONS.OPT}</span>
                    </div>
                </div>
                <div id="orion-body"><div style="text-align:center; padding:30px; color:var(--text-muted); font-size:12px; font-weight:500;">Initializing System...</div></div>
                <div id="orion-logs"></div>
            `;
            document.body.appendChild(this.root);

            const head = document.getElementById('orion-head');

            let collapsed = false;
            head.addEventListener('dblclick', e => {
                if (e.target.closest('.ctrl-btn')) return;
                collapsed = !collapsed;
                this.root.style.height = collapsed ? '50px' : '';
            });

            head.addEventListener('mousedown', e => {
                if (e.target.closest('.ctrl-btn')) return;

                head.classList.add('dragging');

                const startX = e.clientX, startY = e.clientY;
                const rect = this.root.getBoundingClientRect();
                const initialLeft = rect.left, initialTop = rect.top;

                this.root.style.left = `${initialLeft}px`;
                this.root.style.top = `${initialTop}px`;
                this.root.style.right = 'auto';
                e.preventDefault();

                const onMouseMove = ev => {
                    this.root.style.left = `${Math.max(0, Math.min(initialLeft + (ev.clientX - startX), window.innerWidth - this.root.offsetWidth))}px`;
                    this.root.style.top = `${Math.max(0, Math.min(initialTop + (ev.clientY - startY), window.innerHeight - 50))}px`;
                };

                const onMouseUp = () => {
                    head.classList.remove('dragging');
                    document.removeEventListener('mousemove', onMouseMove);
                    document.removeEventListener('mouseup', onMouseUp);
                };

                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            });

            document.getElementById('orion-body').addEventListener('click', async (e) => {
                if (e.target.classList.contains('goto-btn')) {
                    if (Mods.Router) Mods.Router.transitionTo('/quest-home');
                    return;
                }

                if (e.target.classList.contains('claim-btn')) {
                    const btn = e.target;
                    if (btn.disabled) return;

                    const questId = btn.getAttribute('data-id');
                    const taskData = this.tasks.get(questId);
                    if (!taskData) return;

                    btn.innerText = "WAITING...";
                    btn.disabled = true;
                    btn.style.opacity = "0.5";

                    // save state so render() respects it
                    this.updateTask(questId, { ...taskData, claimState: 'WAITING' });

                    try {
                        const claimRes = await Tasks.claimReward(questId);

                        if (claimRes?.body?.claimed_at) {
                            btn.innerText = "CLAIMED!";
                            this.log(`[Claim] Reward for "${taskData.name}" claimed successfully!`, 'success');

                            this.updateTask(questId, { ...taskData, status: "CLAIMED", claimable: false, claimState: null });
                            setTimeout(() => this.removeTask(questId), 2000);
                        } else {
                            // 2xx without claimed_at. The reward isn't claimed, and without this
                            // branch claimState stayed WAITING forever, so the button was dead for
                            // the rest of the session with no way back.
                            this.log(`[Claim] Reward for "${taskData.name}" wasn't confirmed. Claim it from Discord's Quests page.`, 'warn');
                            this.updateTask(questId, { ...taskData, claimState: 'FAILED' });
                        }
                    } catch (err) {
                        this.log(`[Claim] Action required for "${taskData.name}". Check Discord UI for captcha.`, 'warn');
                        // formally update state to FAILED so render() locks it permanently
                        this.updateTask(questId, { ...taskData, claimState: 'FAILED' });
                    }
                }
            });

            document.getElementById('orion-close').onclick = () => this.toggle();
            document.getElementById('orion-stop').onclick = () => this.shutdown();

            // Keep the reference so shutdown() can detach it. An anonymous listener here
            // survived STOP and stacked one more copy per paste, each closing over a dead
            // dashboard, the same stacking the gear handler below is careful to avoid.
            this._hotkey = e => (e.key === '>' || (e.shiftKey && e.key === '.')) && this.toggle();
            document.addEventListener('keydown', this._hotkey);

            // gear toggles the picker options panel. Those nodes only exist during the picker
            // phase, so look them up at click time and no-op otherwise. Registered once here
            // (not in showQuestPicker) so a fresh listener doesn't stack every time it opens.
            document.getElementById('orion-opts').addEventListener('click', () => {
                const panel = document.getElementById('orion-options-panel');
                if (!panel) return;
                const open = panel.style.display === 'none';
                panel.style.display = open ? '' : 'none';
                const list = document.getElementById('orion-quest-list');
                if (list) list.style.display = open ? 'none' : '';
                const actions = document.querySelector('#orion-picker-form .picker-actions');
                if (actions) actions.style.display = open ? 'none' : '';
            });

            this.startTicker();
        },

        toggle() {
            if (!this.root?.parentElement) return;  // dashboard already torn down
            this.root.style.display = this.root.style.display === 'none' ? 'flex' : 'none';
        },

        shutdown() {
            if (!RUNTIME.running) return;
            RUNTIME.running = false;
            this.log("[System] Stopping script & cleaning up...", "warn");

            if (this.tickerId) clearInterval(this.tickerId);
            if (this._hotkey) { document.removeEventListener('keydown', this._hotkey); this._hotkey = null; }

            for (const cleanupFn of RUNTIME.cleanups) {
                try { cleanupFn(); } catch (e) { this.log(`[Cleanup] ${e.message}`, 'debug'); }
            }
            RUNTIME.cleanups.clear();

            Patcher.clean();

            // Free the re-entry guard now, not in a second. Holding it for the grace period
            // meant a paste inside that window was refused with "Already running.", and the
            // UI that guard had just re-shown was then removed by this very timer, leaving
            // nothing on screen and no hint that pasting again would work.
            window.orionLock = false;

            // Capture the nodes to drop instead of looking them up by id when the timer fires:
            // a new instance reuses the same ids, so a late getElementById('orion-styles')
            // would delete the *new* dashboard's stylesheet.
            const styles = document.getElementById('orion-styles');
            const root = this.root;
            setTimeout(() => {
                if (styles?.parentElement) styles.remove();
                if (root?.parentElement) root.remove();
            }, 1000);
        },

        _getPct(t) {
            if (t.done) return 100;
            if (t.pending || t.failed || !t.max) return 0;
            return Math.min(100, (t.cur / t.max) * 100);
        },

        // Cosmetic smoothing between real progress updates. VIDEO and ACTIVITY compute their
        // own progress locally, so free-running +1/s matches reality closely enough.
        // GAME/STREAM don't: their only source of truth is Discord's heartbeat reply, which
        // lands every ~30s. Free-running there invented a moving bar even when Discord was
        // reporting nothing at all. It reached 100% while the quest sat at 0% in Discord's
        // own UI (issue #43). So they extrapolate strictly from the last heartbeat: the bar
        // is smooth while beats arrive, and frozen at the last known value when they stop.
        // ACHIEVEMENT is a milestone count, not seconds, so it is never ticked.
        SERVER_DRIVEN: ["GAME", "STREAM"],

        startTicker() {
            if (this.tickerId) clearInterval(this.tickerId);
            this.tickerId = setInterval(() => {
                if (!RUNTIME.running) return clearInterval(this.tickerId);
                for (const [id, task] of this.tasks.entries()) {
                    if (task.status !== "RUNNING" || task.type === "ACHIEVEMENT") continue;

                    let cur;
                    if (this.SERVER_DRIVEN.includes(task.type)) {
                        if (task.serverAt == null) continue;  // no heartbeat yet, show nothing
                        cur = Math.min(task.serverCur + (Date.now() - task.serverAt) / 1000, task.max);
                    } else {
                        cur = Math.min(task.cur + 1, task.max);
                    }
                    this.updateTask(id, { cur });
                }
            }, 1000);
        },

        updateTask(id, data) {
            const oldData = this.tasks.get(id);
            const isPending = data.status === "PENDING" || data.status === "QUEUE";
            const isDone = data.status === "COMPLETED" || data.status === "CLAIMED";
            const isFailed = data.status === "FAILED";

            const newData = { ...oldData, ...data, done: isDone, pending: isPending, failed: isFailed };
            this.tasks.set(id, newData);

            if (oldData && oldData.status === newData.status && oldData.removing === newData.removing &&
                oldData.claimable === newData.claimable && oldData.claimState === newData.claimState &&
                oldData.actionRequired === newData.actionRequired) {
                // must match the escaped id render() writes, or the in-place update misses
                const card = document.getElementById(`orion-task-${esc(id)}`);
                if (card) {
                    const pct = this._getPct(newData);

                    const iconContainer = card.querySelector('.task-icon');
                    if (iconContainer) iconContainer.style.setProperty('--p', `${pct}%`);

                    const overlay = card.querySelector('.task-icon-overlay');
                    if (overlay) overlay.textContent = `${Math.floor(pct)}%`;

                    const progressText = card.querySelector('.progress-text');
                    if (progressText) {
                        const unit = newData.type === 'ACHIEVEMENT' ? '' : 's';
                        progressText.textContent = `${Math.min(Math.floor(newData.cur), newData.max)} / ${newData.max}${unit}`;
                    }
                    return;
                }
            }
            this.render();
        },

        removeTask(id) {
            if (this.tasks.has(id)) {
                this.tasks.get(id).removing = true;
                this.render();
                setTimeout(() => { this.tasks.delete(id); this.render(); }, 500);
            }
        },

        log(msg, type = 'info') {
            const colors = { info: "#5865F2", success: "#3BA55C", warn: "#faa61a", err: "#f04747", debug: "#999" };
            console.log(`%c[ORION] %c${msg}`, `color: ${CONFIG.THEME}; font-weight: bold;`, `color: ${colors[type] || colors.info}`);
            try {
                const box = document.getElementById('orion-logs');
                if (box && type !== 'debug') {
                    const el = document.createElement('div'); el.className = `log-item c-${type}`;
                    el.innerHTML = `<span class="log-ts">${new Date().toLocaleTimeString().split(' ')[0]}</span> <span>${esc(msg)}</span>`;
                    box.appendChild(el); box.scrollTop = box.scrollHeight;
                    while (box.children.length > CONFIG.MAX_LOG_ITEMS) box.firstChild.remove();
                }
            } catch (e) { console.debug('[Logger] DOM error:', e.message); }
        },

        render() {
            if (document.getElementById('orion-picker-form')) return;
            const body = document.getElementById('orion-body');
            if (!body) return;
            if (!this.tasks.size) return body.innerHTML = `<div style="text-align:center; padding:30px; color:var(--text-muted); font-size:13px;">Waiting for tasks...</div>`;

            const sorted = [...this.tasks.entries()].sort((a, b) => {
                const ta = a[1], tb = b[1];
                if (ta.done !== tb.done) return ta.done ? 1 : -1;
                if (ta.failed !== tb.failed) return ta.failed ? 1 : -1;
                if (ta.pending !== tb.pending) return ta.pending ? 1 : -1;
                // among active tasks, highest progress first
                if (!ta.done && !ta.pending && !tb.done && !tb.pending) {
                    const pctA = ta.max ? ta.cur / ta.max : 0;
                    const pctB = tb.max ? tb.cur / tb.max : 0;
                    return pctB - pctA;
                }
                return 0;
            });

            body.innerHTML = sorted.map(([id, t]) => {
                const pct = t.pending || t.failed ? 0 : Math.min(100, (t.cur / t.max) * 100).toFixed(1);
                // state-based icons (done/failed/pending) win over type-based icons.
                const icon =
                    t.done ? ICONS.CHECK :
                    t.failed ? ICONS.STOP :
                    t.pending ? ICONS.CLOCK :
                    t.type === 'VIDEO' ? ICONS.VIDEO :
                    t.type === 'ACHIEVEMENT' ? ICONS.ACTIVITY :
                    t.type?.includes('GAME') ? ICONS.GAME :
                    t.type?.includes('STREAM') ? ICONS.STREAM :
                    ICONS.BOLT;

                let statusText = t.status === 'CLAIMED' ? 'CLAIMED' : t.done ? 'COMPLETED' : t.status;
                let progressLabel = t.pending ? 'In Queue' : t.failed ? 'Aborted' : 'Progress';
                const unit = t.type === 'ACHIEVEMENT' ? '' : 's';

                let actionBtn = '';

                if (t.claimable) {
                    if (t.claimState === 'WAITING') actionBtn = `<button class="claim-btn" disabled>WAITING...</button>`;
                    else if (t.claimState === 'FAILED') actionBtn = `<button class="claim-btn failed" disabled>ACTION REQUIRED</button>`;
                    else actionBtn = `<button class="claim-btn" data-id="${esc(id)}">CLAIM REWARD</button>`;
                } else if (t.actionRequired === 'ENROLL') {
                    statusText = 'ACTION REQUIRED'; progressLabel = 'Accept quest in Discord';
                    actionBtn = `<button class="goto-btn">GO TO QUESTS</button>`;
                } else if (t.type === 'ACHIEVEMENT' && t.status === 'RUNNING') {
                    statusText = 'ACTION REQUIRED'; progressLabel = 'Please, complete manually';
                    actionBtn = `<button class="goto-btn">GO TO QUESTS</button>`;
                }

                const stateClass = t.done ? 'done' : t.failed ? 'failed' : t.pending ? 'pending' : 'running';
                const removingClass = t.removing ? 'removing' : '';

                let taskMetaHtml = '';
                if (!t.done) {
                    taskMetaHtml = `
                    <div class="task-meta">
                        <span>${progressLabel}</span>
                        ${actionBtn ? '' : `<span class="progress-text">${Math.min(Math.floor(t.cur), t.max)} / ${t.max}${unit}</span>`}
                    </div>`;
                }

                return `
                <div id="orion-task-${esc(id)}" class="task-card ${stateClass} ${removingClass}">
                    <div class="task-icon" style="--p: ${pct}%">
                        <div class="task-icon-inner">${icon}</div>
                        ${stateClass === 'running' ? `<div class="task-icon-overlay">${Math.floor(pct)}%</div>` : ''}
                    </div>
                    <div class="task-info">
                        <div class="task-status">${statusText}</div>
                        <div class="task-name" title="${esc(t.name)}">${esc(t.name)}</div>
                        ${taskMetaHtml}
                    </div>
                    ${actionBtn ? `<div class="task-actions">${actionBtn}</div>` : ''}
                </div>`;
            }).join('');
        },

        showQuestPicker(quests) {
            return new Promise((resolve) => {
                const body = document.getElementById('orion-body');
                const logs = document.getElementById('orion-logs');

                const closePicker = (data) => {
                    if (logs) logs.style.display = 'block';
                    if (body) { body.classList.remove('picker-mode'); body.innerHTML = ''; }
                    resolve(data);
                };

                if (!body) return closePicker({ selectedQuests: new Set(), autoEnroll: false, autoClaim: false, playSound: false });
                if (logs) logs.style.display = 'none';

                const items = [];
                const rewardTypes = new Map();
                const questTypes = new Set();

                const REWARD_META = { 1: { label: "IN-GAME", color: "#e67e22" }, 3: { label: "AVATAR DECORATION", color: "#a358f2" }, 4: { label: "ORBS", color: "#5865F2" } };
                const REWARD_FALLBACK = { label: "OTHER", color: "#949ba4" };

                quests.forEach(q => {
                    const cfg = selectTaskConfig(q.config);
                    if (!cfg?.tasks) return;

                    const typeData = Tasks.detectType(cfg, q.config?.application?.id);
                    if (!typeData) return;
                    // exclude desktop-only quests (play/stream) on any non-desktop clients
                    if (!SYS.IS_DESKTOP && (typeData.type === 'GAME' || typeData.type === 'STREAM')) return;

                    const rw = q.config?.rewardsConfig?.rewards?.[0];
                    const rewardType = rw?.type ?? 0;
                    const rewardText = rw?.messages?.name ?? "Unknown Reward";

                    const meta = REWARD_META[rewardType] ?? REWARD_FALLBACK;

                    const displayType = typeData.type === 'WATCH_VIDEO' ? 'VIDEO' : typeData.type;
                    questTypes.add(displayType);

                    if (!rewardTypes.has(rewardType)) {
                        rewardTypes.set(rewardType, { label: meta.label, count: 0, type: rewardType, color: meta.color });
                    }
                    rewardTypes.get(rewardType).count++;

                    const orbs = orbReward(q.config);

                    items.push({
                        id: q.id,
                        name: q.config?.messages?.questName ?? "Unknown Quest",
                        type: displayType,
                        rewardType,
                        rewardText,
                        orbs: orbs?.orbs ?? 0,
                        premiumOrbs: orbs?.premium ?? 0,
                        orbText: fmtOrbs(orbs),
                        color: meta.color
                    });
                });

                if (!items.length) return closePicker({ selectedQuests: new Set(), autoEnroll: false, autoClaim: false, playSound: false });

                const buildCard = (q) => `
                    <label class="quest-pick" data-rt="${q.rewardType}" data-qt="${q.type}" data-orbs="${q.orbs}" data-premium-orbs="${q.premiumOrbs}" style="border-left-color: ${q.color};">
                        <input type="checkbox" name="quests" value="${q.id}" class="native-cb" checked>
                        <div class="task-info">
                            <div class="task-name" title="${esc(q.name)}">${esc(q.name)}</div>
                            <div class="task-meta" style="justify-content: flex-start; gap: 8px;">
                                <span style="text-transform: uppercase; color: var(--text-subtle);">${esc(q.type)}</span>
                                <span style="color: ${q.color};">${esc(q.orbText || q.rewardText)}</span>
                            </div>
                        </div>
                    </label>`;

                const buildToggle = (name, label, isChecked) => `
                    <div class="orion-option">
                        <span class="orion-option-label">${label}</span>
                        <input type="checkbox" name="${name}" class="native-toggle" ${isChecked ? 'checked' : ''}>
                    </div>`;

                body.innerHTML = `
                    <form id="orion-picker-form">
                        <div id="orion-options-panel" style="display:none;">
                            ${rewardTypes.size > 1 ? `
                                <div class="picker-section-title">Filter By Reward</div>
                                <div class="reward-filters">
                                    ${[...rewardTypes.values()].map(rt => `<button type="button" class="reward-filter" data-rt="${rt.type}" style="color: ${rt.color}; border-color: ${rt.color};">${rt.label} (${rt.count})</button>`).join('')}
                                </div>
                            ` : ''}
                            ${questTypes.size > 1 ? `
                                <div class="picker-section-title">Filter By Type</div>
                                <div class="reward-filters">
                                    ${[...questTypes].map(t => `<button type="button" class="type-filter" data-qt="${t}">${t}</button>`).join('')}
                                </div>
                            ` : ''}
                            <div class="picker-section-title">Options</div>
                            <div class="picker-options">
                                ${buildToggle('autoEnroll', 'Auto-enroll in quests', RUNTIME.autoEnroll)}
                                ${buildToggle('autoClaim', 'Auto-claim rewards', RUNTIME.autoClaim)}
                                ${buildToggle('playSound', 'Sound on completion', RUNTIME.playSound)}
                                ${buildToggle('randomDelay', 'Random 1-30min delay between cycles', RUNTIME.randomDelay)}
                            </div>
                        </div>

                        <div id="orion-quest-list" class="picker-quest-list">${items.map(buildCard).join('')}
                            <div id="orion-no-quests" style="display: none; margin: auto; text-align: center; color: var(--text-muted); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">
                                No quests available
                            </div>
                        </div>

                        <div id="orion-orb-total" class="orb-total"></div>

                        <div class="picker-actions">
                            <button type="button" class="quest-pick-btn deselect" id="select-all-btn">DESELECT ALL</button>
                            <button type="submit" class="quest-pick-btn start" id="start-btn">${ICONS.BOLT} <span id="start-btn-text">START (${items.length})</span></button>
                        </div>
                    </form>`;

                const form = document.getElementById('orion-picker-form');
                const selectAllBtn = document.getElementById('select-all-btn');
                const startBtn = document.getElementById('start-btn');

                const getVisibleCheckboxes = () => Array.from(form.querySelectorAll('.quest-pick input[type="checkbox"]'))
                    .filter(cb => !cb.closest('.quest-pick').classList.contains('hidden'));

                // Filled in once the balance read below settles; empty until then and on failure.
                let balanceText = '';

                const syncUI = () => {
                    const visibleCbs = getVisibleCheckboxes();
                    const totalChecked = visibleCbs.filter(cb => cb.checked).length;

                    // Counts the selected quests only, so a reward filter or a deselect moves the
                    // number. A list-wide total would stay put while the selection changed under it.
                    const orbTotal = document.getElementById('orion-orb-total');
                    if (orbTotal) {
                        const picked = visibleCbs.filter(cb => cb.checked).map(cb => cb.closest('.quest-pick'));
                        const sum = attr => picked.reduce((total, el) => total + (Number(el?.getAttribute(attr)) || 0), 0);
                        const orbs = sum('data-orbs');
                        const selectedText = orbs > 0 ? `${fmtOrbs({ orbs, premium: sum('data-premium-orbs') })} selected` : '';
                        const text = [selectedText, balanceText].filter(Boolean).join(' · ');
                        orbTotal.textContent = text;
                        orbTotal.style.display = text ? 'block' : 'none';
                    }

                    const startBtnText = document.getElementById('start-btn-text');
                    if (startBtnText) startBtnText.textContent = `START (${totalChecked})`;
                    startBtn.disabled = totalChecked === 0;

                    if (visibleCbs.length === 0) {
                        selectAllBtn.disabled = true;
                        selectAllBtn.textContent = 'SELECT ALL';
                    } else {
                        selectAllBtn.disabled = false;
                        selectAllBtn.textContent = visibleCbs.every(cb => cb.checked) ? 'DESELECT ALL' : 'SELECT ALL';
                    }

                    const noQuestsMsg = document.getElementById('orion-no-quests');
                    if (noQuestsMsg) {
                        noQuestsMsg.style.display = visibleCbs.length === 0 ? 'block' : 'none';
                    }
                };

                form.addEventListener('change', (e) => { if (e.target.name === 'quests') syncUI(); });

                const activeRewards = new Set([...rewardTypes.keys()].map(String));
                const activeTypes = new Set([...questTypes]);

                const applyFilters = () => {
                    form.querySelectorAll('.quest-pick').forEach(el => {
                        const rt = el.getAttribute('data-rt');
                        const qt = el.getAttribute('data-qt');
                        el.classList.toggle('hidden', !(activeRewards.has(rt) && activeTypes.has(qt)));
                    });
                    syncUI();
                };

                const FILTER_KINDS = [
                    { cls: 'reward-filter', attr: 'data-rt', set: activeRewards },
                    { cls: 'type-filter', attr: 'data-qt', set: activeTypes }
                ];

                form.addEventListener('click', (e) => {
                    const kind = FILTER_KINDS.find(k => e.target.classList.contains(k.cls));
                    if (kind) {
                        e.preventDefault();
                        const value = e.target.getAttribute(kind.attr);
                        e.target.classList.toggle('off');
                        if (e.target.classList.contains('off')) kind.set.delete(value);
                        else kind.set.add(value);
                        applyFilters();
                        return;
                    }

                    if (e.target.id === 'select-all-btn') {
                        e.preventDefault();
                        const visibleCbs = getVisibleCheckboxes();
                        if (visibleCbs.length === 0) return;

                        const shouldCheck = !visibleCbs.every(cb => cb.checked);
                        visibleCbs.forEach(cb => { cb.checked = shouldCheck; });
                        syncUI();
                    }
                });

                form.addEventListener('submit', (e) => {
                    e.preventDefault();

                    const selected = getVisibleCheckboxes().filter(cb => cb.checked);
                    if (selected.length === 0) return;

                    const data = new FormData(form);

                    closePicker({
                        selectedQuests: new Set(selected.map(cb => cb.value)),
                        autoEnroll: data.has('autoEnroll'),
                        autoClaim: data.has('autoClaim'),
                        playSound: data.has('playSound'),
                        randomDelay: data.has('randomDelay')
                    });
                });

                // apply layout lock and sync initial button states
                body.classList.add('picker-mode');
                syncUI();

                readOrbBalance()
                    .then(balance => {
                        if (balance === null) {
                            Logger.log('[System] Discord sent no Orb balance, so the picker shows none.', 'warn');
                            return;
                        }
                        balanceText = `${balance} Orbs on the account`;
                        syncUI();
                    })
                    .catch(e => Logger.log(`[System] Could not read the Orb balance: ${e?.message ?? e}`, 'warn'));
            });
        }
    };

    /* ── request queue ────────────────────────────────────────────
       FIFO queue processed one-at-a-time to respect rate limits.
       Retryable errors (429, 5xx) re-queue with exponential backoff.
       Client errors (4xx) reject immediately. The caller decides what to do.
    ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── */

    const Traffic = {
        queue: [], processing: false,

        async enqueue(url, body) {
            if (!RUNTIME.running) return Promise.reject(new Error("Stopped"));
            return new Promise((resolve, reject) => {
                this.queue.push({ url, body, resolve, reject, attempts: 0 });
                this.process();
            });
        },

        async process() {
            if (this.processing || this.queue.length === 0) return;
            this.processing = true;

            while (this.queue.length > 0) {
                if (!RUNTIME.running) {
                    this.queue.forEach(req => req.reject(new Error("Shutdown")));
                    this.queue = [];
                    this.processing = false;
                    return;
                }

                const req = this.queue.shift();
                try {
                    const res = await Mods.API.post({ url: req.url, body: req.body });
                    req.resolve(res);
                } catch (e) {
                    const err = ErrorHandler.classify(e);

                    if (err.isRetryable && req.attempts < SYS.MAX_RETRIES) {
                        req.attempts++;
                        const delay = (e.body?.retry_after ?? Math.pow(2, req.attempts)) * 1000;
                        const isGlobal = e.body?.global === true;

                        Logger.log(`[Network] Retry ${req.attempts}/${SYS.MAX_RETRIES} in ${(delay / 1000).toFixed(1)}s (HTTP ${err.status})`, 'warn');

                        const retryJitter = rnd(200, 800);

                        if (isGlobal) {
                            // Freeze queue on global rate limits to prevent API abuse
                            this.queue.unshift(req);
                            await sleep(delay + retryJitter);
                        } else {
                            // Non-blocking retry for endpoint-specific limits
                            setTimeout(() => {
                                if (RUNTIME.running) {
                                    this.queue.push(req);
                                    this.process();
                                } else {
                                    // settle on shutdown so an awaiter doesn't hang until the task timeout
                                    req.reject(new Error('Shutdown'));
                                }
                            }, delay + retryJitter);
                        }
                    } else if (err.isClientError) {
                        Logger.log(`[Network] HTTP ${err.status}: ${req.url}`, 'debug');
                        req.reject(e);
                    } else {
                        Logger.log(`[Network] Request to ${req.url} failed: ${err.message}`, 'err');
                        req.reject(e);
                    }
                }

                await sleep(rnd(1200, 1800)); // delay between API calls
            }
            this.processing = false;
        }
    };

    /* ── store patching ───────────────────────────────────────────
       Monkey-patches Discord's RunStore/StreamStore so the client
       believes a game process is running. Fake PIDs, exePaths, and
       RPC payloads are injected and cleaned up on task completion.
    ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── */

    let Mods = {};  // populated by loadModules(), holds Discord webpack internals

    /* HIDE_ACTIVITY note: skipping our own LOCAL_ACTIVITY_UPDATE dispatch is not enough
       to hide the status. Discord builds the "Playing X" presence from the store itself:
       LocalActivityStore/ActivityTrackingStore read getVisibleRunningGames()/getVisibleGame(),
       which we patch below for quest eligibility (issue #43). So the only way to stay
       invisible while keeping the spoof is to turn Discord's own status.showCurrentGame off
       for the duration and restore it on cleanup. Same setting Vencord's
       GameActivityToggle drives. */

    const Patcher = {
        games: [], real: {}, active: false,
        savedShowCurrentGame: null,  // value before we forced it off; null = not suppressed
        _unhide: null,               // pagehide listener, detached once the setting is restored

        // Overriding getRunningGames alone is no longer enough. Canary derives quest
        // eligibility from the "visible"/"candidate" views, and a game absent from those
        // never gets a heartbeat scheduled, so the quest sits at 0% forever (issue #43).
        // Older builds don't expose all of these, so each is patched only if present.
        PATCHED: ['getRunningGames', 'getGameForPID', 'getVisibleGame', 'getVisibleRunningGames',
                  'getRunningDiscordApplicationIds', 'getCandidateGames'],

        // stash originals so we can restore them on cleanup
        init(Store) {
            if (!Store) return;
            this.real = {};
            for (const name of this.PATCHED) {
                if (typeof Store[name] === 'function') this.real[name] = Store[name];
            }
            const absent = this.PATCHED.filter(n => !this.real[n]);
            if (absent.length) Logger.log(`[Patcher] Store lacks ${absent.join(', ')}, not patching those.`, 'debug');
        },

        // swap between real and patched store methods
        toggle(on) {
            const S = Mods.RunStore;
            const real = this.real;

            if (on && !this.active) {
                S.getRunningGames = () => [...real.getRunningGames.call(S), ...this.games];
                S.getGameForPID = (pid) => this.games.find(g => g.pid === pid) || real.getGameForPID.call(S, pid);

                // our game wins as "the" visible one, which is the whole point of the spoof
                if (real.getVisibleGame) S.getVisibleGame = () => this.games[0] ?? real.getVisibleGame.call(S);
                if (real.getVisibleRunningGames) S.getVisibleRunningGames = () => [...real.getVisibleRunningGames.call(S), ...this.games];
                if (real.getCandidateGames) S.getCandidateGames = () => [...real.getCandidateGames.call(S), ...this.games];
                if (real.getRunningDiscordApplicationIds) {
                    S.getRunningDiscordApplicationIds = () => {
                        const ids = real.getRunningDiscordApplicationIds.call(S);
                        const ours = this.games.map(g => String(g.id));
                        // shape varies by build, so preserve whichever collection came back
                        return ids instanceof Set ? new Set([...ids, ...ours]) : [...(ids ?? []), ...ours];
                    };
                }
                this.active = true;
            } else if (!on && this.active) {
                for (const [name, fn] of Object.entries(real)) S[name] = fn;
                this.active = false;
            }
        },

        // Force showCurrentGame off while a fake game is up and HIDE_ACTIVITY is on,
        // restore it once the last one goes away.
        syncPresenceSuppression() {
            const setting = Mods.ShowCurrentGame;
            const shouldSuppress = CONFIG.HIDE_ACTIVITY && this.games.length > 0;

            if (!setting) {
                if (shouldSuppress) Logger.log('[Patcher] status.showCurrentGame not found, cannot hide activity.', 'warn');
                return;
            }

            if (shouldSuppress && this.savedShowCurrentGame === null) {
                try {
                    // undefined = couldn't read it; assume it was on (Discord's default) so
                    // cleanup restores rather than silently leaving the user's status off
                    this.savedShowCurrentGame = setting.getSetting() !== false;
                    if (this.savedShowCurrentGame) {
                        Promise.resolve(setting.updateSetting(false)).catch(e =>
                            Logger.log(`[Patcher] Could not turn showCurrentGame off, activity stays visible: ${e.message}`, 'warn'));
                        // Reload skips shutdown entirely, and reloading is the first thing most
                        // people try when something looks stuck. Attempt the restore on the way
                        // out, and say plainly what to do if it doesn't land, because the write
                        // is async and a page teardown gives it no guarantee of completing.
                        this._unhide = () => { try { setting.updateSetting(true); } catch (_) { } };
                        window.addEventListener('pagehide', this._unhide);
                        Logger.log('[Patcher] Your "Display current activity as a status message" setting is off while quests run. STOP puts it back. If Discord is closed or reloaded before then, re-enable it in Discord settings.', 'warn');
                    }
                } catch (e) {
                    this.savedShowCurrentGame = null;
                    Logger.log(`[Patcher] showCurrentGame read failed, cannot hide activity: ${e.message}`, 'warn');
                }
            } else if (!shouldSuppress && this.savedShowCurrentGame !== null) {
                const restore = this.savedShowCurrentGame;
                this.savedShowCurrentGame = null;
                if (this._unhide) { window.removeEventListener('pagehide', this._unhide); this._unhide = null; }
                if (restore) {
                    try {
                        Promise.resolve(setting.updateSetting(true)).catch(e =>
                            Logger.log(`[Patcher] Failed to restore showCurrentGame. Re-enable "Display current activity as a status message" in Discord settings: ${e.message}`, 'err'));
                    } catch (e) {
                        Logger.log(`[Patcher] Failed to restore showCurrentGame. Re-enable "Display current activity as a status message" in Discord settings: ${e.message}`, 'err');
                    }
                }
            }
        },

        add(g) {
            if (this.games.some(x => x.pid === g.pid)) return;
            this.games.push(g);
            this.toggle(true);
            this.syncPresenceSuppression();
            this.dispatch([g], []);
            this.rpc(g);
        },

        remove(g) {
            const before = this.games.length;
            this.games = this.games.filter(x => x.pid !== g.pid);
            if (this.games.length === before) return;

            this.dispatch([], [g]);
            this.syncPresenceSuppression();
            if (!this.games.length) {
                this.toggle(false);
                this.rpc(null);
            } else {
                this.rpc(this.games[0]);
            }
        },

        // callers pass arrays; don't re-wrap (a re-wrap turned [] into [[]] and emitted
        // malformed added/removed shapes to any Flux consumer). Matches the Vencord port.
        dispatch(added, removed) {
            Mods.Dispatcher?.dispatch({
                type: CONST.EVT.GAME,
                added,
                removed,
                games: Mods.RunStore.getRunningGames()
            });
        },

        rpc(g) {
            if (CONFIG.HIDE_ACTIVITY && g) return;
            try {
                Mods.Dispatcher?.dispatch({
                    type: CONST.EVT.RPC,
                    socketId: null,
                    // use a fake PID (9999) and null activity to clear the playing status
                    pid: g ? g.pid : 9999,
                    activity: g ? {
                        application_id: g.id,
                        name: g.name,
                        type: 0,
                        details: null,
                        state: null,
                        timestamps: { start: g.start },
                        icon: g.icon,
                        assets: null
                    } : null
                });
            } catch (e) {
                Logger.log(`[RPC Cleanup] ${e.message}`, 'debug');
            }
        },

        clean() {
            this.games = [];
            this.toggle(false);
            // games emptied first, so this always restores showCurrentGame
            this.syncPresenceSuppression();
            this.rpc(null);
        }
    };

    // Pull something a user can act on out of a QUESTS_SEND_HEARTBEAT_FAILURE payload. Discord
    // wraps the failure in its own error type, so the useful parts sit at different depths
    // depending on whether the request got a response at all.
    const describeHeartbeatError = payload => {
        const e = payload?.error ?? payload;
        const parts = [];
        const status = e?.status ?? e?.httpStatus;
        if (status) parts.push(`HTTP ${status}`);
        const code = e?.body?.code ?? e?.code;
        if (code != null && code !== status) parts.push(`code ${code}`);
        const message = e?.body?.message ?? e?.message;
        if (message) parts.push(String(message));
        if (!parts.length) {
            try { parts.push(JSON.stringify(e).slice(0, 160)); } catch { parts.push(String(e)); }
        }
        return parts.join(', ') || 'no detail';
    };

    /* ── task handlers ────────────────────────────────────────────
       Each quest type (VIDEO, GAME, STREAM, ACTIVITY) has its own
       handler. GAME/STREAM share a generic() path that patches stores
       and listens for heartbeat events. VIDEO and ACTIVITY poll in a
       loop instead. Failed quest IDs go into `skipped` so we don't
       re-attempt them on the next cycle.
    ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── */

    const Tasks = {
        skipped: new Set(),  // quest IDs that returned 4xx, no point retrying
        // What happened to each quest this run. The closing line counts these rather than
        // quests that gained completedAt while the run was alive, which cannot tell this
        // script's work from the user finishing the same quest by hand.
        outcomes: new Map(),
        _streamReal: undefined,  // untouched StreamStore method, captured before the first spoof
        _streamSpoofs: 0,        // active STREAM tasks holding the spoof

        // userStatus.progress is a plain object over REST, but dispatched payloads go through
        // the client's own transform first, so the shape isn't ours to assume. Defensive: if
        // it ever arrives as a Map, indexing with [] would read undefined and silently look
        // like "no progress".
        readProgress(userStatus, key) {
            const p = userStatus?.progress;
            const entry = p instanceof Map ? p.get(key) : p?.[key];
            return entry?.value ?? userStatus?.streamProgressSeconds ?? 0;
        },

        sanitize(name) { return name.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/\s+/g, " "); },

        // Newer quest configs (taskConfigV2) carry the app per task as
        // tasks[key].applications[]; older ones had a single config.application.id.
        // A GAME quest built with the wrong id produces a fake process Discord can't
        // match to the quest, so it never schedules a heartbeat (issue #43).
        appIdFor(cfg, keyName, legacyAppId) {
            return taskAt(cfg?.tasks, keyName)?.applications?.[0]?.id ?? legacyAppId ?? null;
        },

        // Match task keys from the quest config to our handler types.
        //
        // The exact keys come first and the loose prefixes last, and that order is the whole
        // point. This used to test `k.includes("PLAY")` before anything else, and
        // "PLAY_ACTIVITY".includes("PLAY") is true, so every activity quest was routed to the
        // GAME handler: it injected a fake process and then waited for heartbeats Discord does
        // not send for an activity task, so the quest never finished and the ACTIVITY handler
        // was unreachable for its own quest type. Verified against a live client.
        //
        // The prefix entries still catch platform variants (PLAY_ON_XBOX, WATCH_VIDEO_ON_MOBILE)
        // and anything new Discord adds under the same families.
        /*
         * Task keys this client can actually drive. Most quests offer several: 38 of the 66 on a live
         * account carry two or three, always a desktop key beside console or mobile variants. Matching
         * by prefix and taking whichever the server happened to list first works only while the server
         * keeps listing the desktop one first. If that order ever changes, Orion picks PLAY_ON_XBOX,
         * injects a desktop process for it, reads progress under a key Discord never credits, and looks
         * healthy for 25 minutes before timing out. Prefer the exact key, and refuse the console-only
         * quests outright instead of pretending to run them.
         */
        detectType(cfg, applicationId) {
            const keys = taskKeys(cfg.tasks);
            // STREAM sits last of the desktop families on purpose. Discord will not open a
            // heartbeat for STREAM_ON_DESKTOP unless you are really Going Live with someone else
            // in the channel, and the engine only fakes the third of those checks, so that task
            // can only time out. A quest carrying STREAM_ON_DESKTOP beside PLAY_ON_DESKTOP or
            // WATCH_VIDEO used to be routed to the one path that cannot finish. See issue #75.
            const typeMap = [
                { match: k => k === "ACHIEVEMENT_IN_ACTIVITY", type: "ACHIEVEMENT" },
                { match: k => k === "PLAY_ACTIVITY", type: "ACTIVITY" },
                { match: k => k.includes("VIDEO"), type: "WATCH_VIDEO", prefer: ["WATCH_VIDEO"] },
                { match: k => k.startsWith("PLAY"), type: "GAME", prefer: ["PLAY_ON_DESKTOP"] },
                { match: k => k.startsWith("STREAM"), type: "STREAM", prefer: ["STREAM_ON_DESKTOP"] },
                { match: k => k.includes("ACTIVITY"), type: "ACTIVITY" }
            ];

            for (const { match, type, prefer } of typeMap) {
                const keyName = (prefer && keys.find(k => prefer.includes(k)))
                    || keys.find(k => match(k) && !CONSOLE_ONLY_KEYS.has(k));
                if (keyName) {
                    return {
                        type, keyName,
                        target: taskAt(cfg.tasks, keyName)?.target ?? 0,
                        appId: this.appIdFor(cfg, keyName, applicationId)
                    };
                }
            }

            // Every key was a console one, so there is nothing this client can do with the quest.
            if (keys.length > 0 && keys.every(k => CONSOLE_ONLY_KEYS.has(k))) return null;

            if (applicationId) {
                return {
                    type: "GAME", keyName: "PLAY_ON_DESKTOP",
                    target: taskAt(cfg.tasks, keys[0])?.target ?? 0,
                    appId: applicationId
                };
            }

            return null;
        },

        // pull real exe metadata from Discord's app registry; falls back to synthetic paths
        async fetchGameData(appId, appName) {
            try {
                const res = await Mods.API.get({ url: `/applications/public?application_ids=${appId}` });
                const appData = res?.body?.[0];
                const exeEntry = appData?.executables?.find(x => x.os === "win32");
                const rawExe = exeEntry ? exeEntry.name.replace(">", "") : `${this.sanitize(appName)}.exe`;
                const cleanName = this.sanitize(appData?.name || appName);

                return {
                    name: appData?.name || appName,
                    icon: appData?.icon,
                    exeName: rawExe,
                    cmdLine: `C:\\Program Files\\${cleanName}\\${rawExe}`,
                    exePath: `c:/program files/${cleanName.toLowerCase()}/${rawExe}`,
                    id: appId
                };
            } catch (e) {
                Logger.log(`[FetchGame] Fallback for ${appName}: ${e?.message ?? e}`, 'debug');
                const cleanName = this.sanitize(appName);
                const safeExe = `${cleanName.replace(/\s+/g, "")}.exe`;
                return {
                    name: appName, exeName: safeExe,
                    cmdLine: `C:\\Program Files\\${cleanName}\\${safeExe}`,
                    exePath: `c:/program files/${cleanName.toLowerCase()}/${safeExe}`,
                    id: appId
                };
            }
        },

        async claimReward(questId) {
            return await Mods.API.post({
                url: `/quests/${questId}/claim-reward`,
                // Shaped after Discord's own claim action, which sends platform, location,
                // is_targeted and the two sealed fields, and nothing else. Orion used to add
                // metadata_raw and traffic_metadata_raw, which Discord never sends, while
                // nulling the sealed value that is sitting on the quest record.
                body: { platform: 0, location: 11, is_targeted: false, metadata_sealed: null, traffic_metadata_sealed: sealedFor(questId) }
            });
        },

        // safely aborts a broken or timed-out task, marks it as FAILED in the UI,
        // and adds it to the skip list to prevent infinite retry loops
        failTask(q, t, reason) {
            const currentProgress = Logger.tasks.get(q.id)?.cur ?? 0;
            Logger.updateTask(q.id, { name: t.name, type: t.type, cur: currentProgress, max: t.target, status: "FAILED" });
            Logger.log(`[Task] Aborted "${t.name}": ${reason}`, 'err');
            Tasks.skipped.add(q.id);
            // The active filter reads the skipped set and nothing else, so a quest that died
            // here leaves the rotation exactly like one this client never could drive.
            recordOutcome(Tasks.outcomes, q.id, 'failed');
            setTimeout(() => Logger.removeTask(q.id), 2000); 
        },

        // sends fake video-progress timestamps until Discord marks the quest done
        async VIDEO(q, t, s) {
            // read progress from actual task key, fall back to type name
            let cur = s?.progress?.[t.keyName]?.value ?? s?.progress?.[t.type]?.value ?? 0;
            let failCount = 0;

            Logger.updateTask(q.id, { name: t.name, type: "VIDEO", cur, max: t.target, status: "RUNNING" });

            const startTime = Date.now();
            let calls = 0;

            // No synthetic first ping. It used to fire 200-350ms in with a timestamp of
            // 0.200-0.250, which meant every video quest from every user opened with a value
            // inside the same 50ms window. A real player reports its first tick on its own
            // cadence, so the loop below is left to send it.

            while (cur < t.target && RUNTIME.running) {
                // Match Discord's native player cadence. A shorter interval buys nothing:
                // `cur` advances by real elapsed time below, so the quest still takes `target`
                // seconds of wall clock either way, and halving the delay only doubles the
                // number of requests. Measured: 68s target finished in 73s at 18 requests.
                const delayMs = rnd(7000, 9500);
                await sleep(delayMs);

                // calculate elapsed time with execution jitter
                const elapsedSec = (delayMs / 1000) + (Math.random() * 0.02 - 0.01);
                cur += elapsedSec;

                // match Discord's 6-decimal float format
                const payloadTs = Number(Math.min(t.target, cur).toFixed(6));

                try {
                    const r = await Traffic.enqueue(`/quests/${q.id}/video-progress`, { timestamp: payloadTs });
                    calls++;
                    // sync with server if it reports higher progress
                    const serverVal = r?.body?.progress?.[t.keyName]?.value ?? r?.body?.progress?.WATCH_VIDEO?.value;
                    if (serverVal > cur) cur = Math.min(t.target, serverVal);
                    if (r?.body?.completed_at) break;
                    failCount = 0;
                } catch (e) {
                    failCount++;
                    const err = ErrorHandler.classify(e);
                    if (err.isClientError) {
                        Logger.log(`[Task] Video quest unavailable (HTTP ${err.status}). Skipping.`, 'warn');
                        return Tasks.failTask(q, t, `Client Error ${err.status}`);
                    }
                    if (failCount >= SYS.MAX_TASK_FAILURES) {
                        return Tasks.failTask(q, t, 'Too many network failures');
                    }
                    Logger.log(`[Task] VIDEO progress failed (${failCount}/${SYS.MAX_TASK_FAILURES}): ${err.message}`, 'debug');
                }

                Logger.updateTask(q.id, { name: t.name, type: "VIDEO", cur, max: t.target, status: "RUNNING" });

                if (Date.now() - startTime > SYS.MAX_TIME) {
                    return Tasks.failTask(q, t, 'Timeout exceeded');
                }
            }
            if (RUNTIME.running) {
                Logger.log(`[Task] VIDEO "${t.name}" done in ${calls} API calls`, 'debug');
                Tasks.finish(q, t);
            }
        },

        GAME(q, t, s) { return Tasks.generic(q, t, "GAME", "PLAY_ON_DESKTOP", s); },
        STREAM(q, t, s) { return Tasks.generic(q, t, "STREAM", "STREAM_ON_DESKTOP", s); },

        // shared path for GAME/STREAM. Injects a fake process and subscribes to heartbeat events.
        async generic(q, t, type, fallbackKey, s) {
            if (!RUNTIME.running) return;
            // Prefer the key detected from the quest config. detectType matches task keys by
            // substring, so a renamed variant (a PLAY_ON_DESKTOP_V2, say) still resolves,
            // but reading progress under a hardcoded legacy name would return undefined and
            // pin the task at 0 until the safety timer kills it.
            const key = t.keyName || fallbackKey;
            const gameData = await this.fetchGameData(t.appId, t.name);

            // Re-check after the await, not only before it. Fetching the app metadata is a
            // network round trip, and STOP landing inside it used to let this continuation
            // wake up afterwards and patch the store for a run that had already torn down.
            if (!RUNTIME.running) return;

            return new Promise(resolve => {
                const pid = rnd(2500, 12500) * 4;
                const game = {
                    id: gameData.id, name: gameData.name, icon: gameData.icon,
                    pid, pidPath: [pid], processName: gameData.name, start: Date.now(),
                    exeName: gameData.exeName, exePath: gameData.exePath, cmdLine: gameData.cmdLine,
                    executables: [{ os: 'win32', name: gameData.exeName, is_launcher: false }],
                    windowHandle: 0, fullscreenType: 0, overlay: true, sandboxed: false,
                    hidden: false, isLauncher: false
                };

                let cleanupHook;
                let cleaned = false;
                let safetyTimer;
                let watchdogTimer;
                let beats = 0;
                let failedBeats = 0;          // failures over the whole task, for the message
                let consecutiveFailures = 0;  // reset by any successful beat, this one gives up
                let lastFailure = null;

                if (type === "STREAM") {
                    if (Mods.StreamStore) {
                        // Capture the untouched method once and refcount the spoof. Stashing it
                        // per-task meant a second concurrent STREAM task stashed the first task's
                        // spoof and later "restored" that, leaving the store patched for good.
                        if (Tasks._streamSpoofs === 0) Tasks._streamReal = Mods.StreamStore.getStreamerActiveStreamMetadata;
                        Tasks._streamSpoofs++;
                        Mods.StreamStore.getStreamerActiveStreamMetadata = () => ({ id: gameData.id, pid, sourceName: gameData.name });
                    }
                    // restore unconditionally when the store exists. Assigning back an
                    // undefined original is the correct revert. Guarding on it being truthy
                    // would leave our fake installed when the method was undefined at patch time.
                    cleanupHook = () => {
                        if (Mods.StreamStore && Tasks._streamSpoofs > 0 && --Tasks._streamSpoofs === 0) {
                            Mods.StreamStore.getStreamerActiveStreamMetadata = Tasks._streamReal;
                        }
                    };
                } else {
                    Patcher.add(game);
                    cleanupHook = () => Patcher.remove(game);
                }

                // Seed from progress the server already holds. Painting 0 here made a resumed
                // quest look like it had restarted from scratch until the next heartbeat
                // (~30s later) corrected it.
                const seeded = Tasks.readProgress(s, key);
                Logger.updateTask(q.id, { name: t.name, type, cur: seeded, max: t.target, status: "RUNNING" });
                Logger.log(`[Task] Started ${type}: ${gameData.name}`, 'info');

                const finish = () => {
                    if (cleaned) return;
                    cleaned = true;
                    clearTimeout(safetyTimer);
                    clearTimeout(watchdogTimer);
                    try { cleanupHook(); } catch (e) { Logger.log(`[Task] Cleanup: ${e.message}`, 'debug'); }
                    try { Mods.Dispatcher?.unsubscribe(CONST.EVT.HEARTBEAT, check); } catch (e) {
                        Logger.log(`[Dispatcher] Unsubscribe failed: ${e.message}`, 'debug');
                    }
                    try { Mods.Dispatcher?.unsubscribe(CONST.EVT.HEARTBEAT_FAIL, onFail); } catch (e) {
                        Logger.log(`[Dispatcher] Unsubscribe failed: ${e.message}`, 'debug');
                    }
                    RUNTIME.cleanups.delete(abort);
                };

                // What shutdown runs. finish() alone clears the timers that would otherwise have
                // resolved this promise, so registering it bare left the task pending forever.
                // Separate from finish() so the completion path can still await onComplete
                // (auto-claim) before resolving.
                const abort = () => { finish(); resolve(); };

                safetyTimer = setTimeout(() => {
                    if (RUNTIME.running) Tasks.failTask(q, t, 'Timeout exceeded (25m)');
                    finish();
                    resolve();
                }, SYS.MAX_TIME);

                // Discord drives these quests: it sends /quests/{id}/heartbeat itself while it
                // believes the game runs, and we only read the replies. If it never accepts the
                // injected process, no heartbeat ever arrives and the task would sit "RUNNING"
                // for the full 25 minutes with nothing happening. Give up after 90s of silence
                // and say why.
                // Re-armed on every beat rather than checked once, so it also catches a quest that
                // beats a few times and then goes silent. A one-shot `beats > 0` test would let that
                // sit RUNNING for the full 25 minutes while the ticker extrapolated the bar to 100%,
                // which is the same misleading display issue #43 was about.
                const armWatchdog = () => {
                    clearTimeout(watchdogTimer);
                    watchdogTimer = setTimeout(() => {
                        if (cleaned || !RUNTIME.running) return;
                        const failureTail = failedBeats > 0
                            ? ` and ${failedBeats} failed beat(s), the last one ${lastFailure}`
                            : '';
                        Logger.log(beats === 0
                            ? (failedBeats > 0
                                ? `[Task] Discord never reported progress for "${t.name}". All ${failedBeats} heartbeat(s) it tried failed, the last one ${lastFailure}.`
                                : `[Task] Discord never reported progress for "${t.name}". It is not accepting the injected process on this client, so there is nothing to wait for.`)
                            : `[Task] Discord stopped reporting progress for "${t.name}" after ${beats} update(s)${failureTail}. Giving up instead of idling.`, 'err');
                        Tasks.failTask(q, t, failedBeats > 0
                            ? `No heartbeat from Discord (${failedBeats} failed beat(s))`
                            : 'No heartbeat from Discord');
                        finish();
                        resolve();
                    }, SYS.HEARTBEAT_GRACE);
                };
                armWatchdog();

                const check = (d) => {
                    if (!RUNTIME.running) { finish(); resolve(); return; }
                    if (d?.questId !== q.id) return;

                    beats++;
                    consecutiveFailures = 0;
                    armWatchdog();
                    const prog = Tasks.readProgress(d.userStatus, key);
                    // anchor for the ticker: it extrapolates from here until the next beat
                    Logger.updateTask(q.id, {
                        name: t.name, type, cur: prog, max: t.target, status: "RUNNING",
                        serverCur: prog, serverAt: Date.now()
                    });

                    if (prog >= t.target) {
                        finish();
                        Tasks.finish(q, t);
                        resolve();
                    }
                };

                // Discord does not retry a failed beat: the sender dispatches the failure and the
                // next attempt is the tick it already scheduled 60s out. So a failure is proof
                // Discord is still driving the quest, and the watchdog is rearmed for it rather
                // than counting it as silence. Consecutive failures are what give up, which also
                // makes Discord's own status code reachable instead of a guess (issue #74).
                // The exception is a failure before any credited beat: that keeps the original
                // deadline, because "not accepting the injected process" is the issue #43 answer
                // and is worth a beat and a half rather than five minutes of retries.
                const onFail = (d) => {
                    if (!RUNTIME.running) { finish(); resolve(); return; }
                    if (d?.questId !== q.id) return;

                    failedBeats++;
                    consecutiveFailures++;
                    lastFailure = describeHeartbeatError(d);

                    if (consecutiveFailures >= SYS.MAX_TASK_FAILURES) {
                        Logger.log(`[Task] Discord's heartbeat for "${t.name}" failed ${consecutiveFailures} times in a row: ${lastFailure}. Giving up rather than waiting out the watchdog.`, 'err');
                        Tasks.failTask(q, t, `Discord could not report progress (${lastFailure})`);
                        finish();
                        resolve();
                        return;
                    }

                    Logger.log(`[Task] Discord's heartbeat for "${t.name}" failed (${consecutiveFailures}/${SYS.MAX_TASK_FAILURES}): ${lastFailure}`, 'debug');
                    if (beats > 0) armWatchdog();
                };

                Mods.Dispatcher?.subscribe(CONST.EVT.HEARTBEAT, check);
                Mods.Dispatcher?.subscribe(CONST.EVT.HEARTBEAT_FAIL, onFail);
                RUNTIME.cleanups.add(abort);
            });
        },

        // OAuth2 → discordsays.com bypass for ACHIEVEMENT_IN_ACTIVITY.
        // Discord trusts the activity backend to validate progress, so a forged
        // POST from an authorized session is accepted. Flow:
        //   1) /oauth2/authorize the quest's app (returns code in location URL)
        //   2) /applications/{appId}/proxy-tickets (returns proxy ticket)
        //   3) POST {appId}.discordsays.com/.proxy/acf/authorize {code} → DS token
        //   4) POST {appId}.discordsays.com/.proxy/acf/quest/progress {progress: target}
        //   5) /oauth2/tokens + DELETE to clean up the grant
        //
        // Steps 3-4 are blocked by Discord's renderer CSP (connect-src doesn't
        // include *.discordsays.com). _bypassPost picks the best available
        // transport that escapes CSP: VencordNative if our plugin is installed,
        // DiscordNative if it exposes anything, else direct fetch.
        // POST to a CSP-restricted URL via the best available transport.
        // Returns { ok, status, body } on success, throws { status, body } on HTTP error
        // and TypeError on CSP/network. Probes in order: localhost relay (no mod needed
        // see tools/orion-relay/), VencordNative plugin (CSP-free via IPC to main
        // process), DiscordNative HTTP candidates (if any exist), raw fetch.
        _relayUrl: 'http://127.0.0.1:43210',
        _relayProbe: null,
        _relayProbeAt: 0,
        RELAY_PROBE_TTL: 60000,   // re-probe after a minute instead of trusting one answer forever

        // Cache the in-flight probe promise so concurrent callers (video runs at
        // concurrency 2) all await the same result, instead of a second caller seeing
        // a half-set flag and getting undefined (falsy) back. Cached for a TTL rather than
        // for the whole run: a permanent cache meant a relay started mid-run was never
        // picked up, and a relay that died was still treated as available.
        _probeRelay() {
            if (this._relayProbe && Date.now() - this._relayProbeAt < this.RELAY_PROBE_TTL) return this._relayProbe;
            this._relayProbeAt = Date.now();
            return this._relayProbe = (async () => {
                try {
                    const r = await Promise.race([
                        fetch(`${this._relayUrl}/health`, { method: 'GET', redirect: 'error' }),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('probe timeout')), 800))
                    ]);
                    if (!RUNTIME.running) return false;
                    if (r.ok) Logger.log('[Bypass] Orion Relay detected on 127.0.0.1:43210.', 'info');
                    return r.ok;
                } catch (_) {
                    return false;
                }
            })();
        },

        async _bypassPost(url, headers, jsonBody) {
            // 1) Localhost relay (tools/orion-relay/). CSP allows http://127.0.0.1:*,
            //    the relay forwards to discordsays.com from outside the browser sandbox.
            //    This is the no-mod path: standalone userscript + tiny helper.
            const relayAvailable = await this._probeRelay();
            if (!RUNTIME.running) throw new Error('Shutdown');
            if (relayAvailable) {
                let r;
                try {
                    r = await fetch(`${this._relayUrl}/proxy`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ url, headers, body: jsonBody }),
                        redirect: 'error'
                    });
                    if (!RUNTIME.running) throw new Error('Shutdown');
                } catch (e) {
                    if (!RUNTIME.running) throw e;
                    // relay went away between probe and POST, so drop the cached answer and let
                    // the next transport try, instead of failing the whole bypass on a dead port
                    this._relayProbe = null;
                    Logger.log(`[Bypass] Relay stopped responding, trying other transports: ${e?.message ?? e}`, 'debug');
                }
                if (r) {
                    if (!r.ok) {
                        const body = await r.text();
                        if (!RUNTIME.running) throw new Error('Shutdown');
                        throw { status: r.status, body };
                    }
                    const result = await r.json();
                    if (!RUNTIME.running) throw new Error('Shutdown');
                    if (!result.ok) throw { status: result.status, body: result.body };
                    return result;
                }
            }

            // 2) Vencord plugin native module. Works if the user has the OrionQuests Vencord plugin
            //    installed (`native.ts` at the repo root). Routes through Electron main process.
            try {
                const helper = window.VencordNative?.pluginHelpers?.OrionQuests;
                if (helper) {
                    const u = new URL(url);
                    const appId = u.hostname.split('.')[0];
                    const questId = headers['X-Discord-Quest-ID'];
                    const referrer = headers['Referer'];
                    if (u.pathname.endsWith('/acf/authorize')) {
                        const { code } = JSON.parse(jsonBody);
                        const r = await helper.discordsaysAuthorize({ appId, questId, authCode: code, referrer });
                        if (!RUNTIME.running) throw new Error('Shutdown');
                        if (!r.ok) throw { status: r.status, body: r.body };
                        return { ok: true, status: r.status, body: r.body };
                    }
                    if (u.pathname.endsWith('/acf/quest/progress')) {
                        const { progress } = JSON.parse(jsonBody);
                        const token = headers['X-Auth-Token'];
                        const r = await helper.discordsaysProgress({ appId, questId, token, target: progress, referrer });
                        if (!RUNTIME.running) throw new Error('Shutdown');
                        if (!r.ok) throw { status: r.status, body: r.body };
                        return { ok: true, status: r.status, body: r.body };
                    }
                }
            } catch (e) {
                if (!RUNTIME.running) throw e;
                if (e?.status) throw e;
                Logger.log(`[Bypass] VencordNative path errored: ${e?.message ?? e}`, 'debug');
            }

            // 3) DiscordNative HTTP probe. Best-effort, since no documented method exists,
            //    but new Discord builds occasionally expose one. We probe several
            //    plausible paths and use the first that's a callable function.
            const dn = window.DiscordNative;
            if (dn) {
                // Only members that plausibly *are* an HTTP client. fileManager.fetchURL and
                // processUtils.fetch were in this list, and neither is one: the first retrieves
                // a URL into the file layer (a write or a save dialog, not a POST) and the second
                // belongs to process management. Calling privileged IPC speculatively with a
                // POST-shaped argument risks a side effect the status-shape check can't even see.
                const probes = [
                    () => dn.http?.makeRequest,
                    () => dn.app?.makeRequest,
                ];
                for (const probe of probes) {
                    if (!RUNTIME.running) throw new Error('Shutdown');
                    try {
                        const fn = probe();
                        if (typeof fn === 'function') {
                            const r = await fn.call(dn, { method: 'POST', url, headers, body: jsonBody });
                            if (!RUNTIME.running) throw new Error('Shutdown');
                            if (r && (r.status || r.statusCode)) {
                                const status = r.status ?? r.statusCode;
                                return { ok: status >= 200 && status < 300, status, body: r.body ?? r.responseText ?? '' };
                            }
                        }
                    } catch (e) {
                        if (!RUNTIME.running) throw e;
                    }
                }
            }

            // 4) Direct fetch. Works on web Discord (no CSP) or relaxed clients.
            //    CSP-blocked on Discord Desktop: throws TypeError "Failed to fetch".
            //    redirect:'error' so a 3xx from discordsays can't bounce our auth token
            //    and proxy-ticket Referer to an arbitrary host.
            if (!RUNTIME.running) throw new Error('Shutdown');
            const res = await fetch(url, { method: 'POST', headers, body: jsonBody, redirect: 'error' });
            if (!RUNTIME.running) throw new Error('Shutdown');
            const body = await res.text();
            if (!RUNTIME.running) throw new Error('Shutdown');
            if (!res.ok) throw { status: res.status, body };
            return { ok: true, status: res.status, body };
        },

        async bypassAchievement(q, t) {
            // taskConfigV2 moved the app off config.application and onto the task, so reading
            // the legacy field alone resolves null on every current quest and this bailed out
            // before it ever tried. t.appId already carries whatever Tasks.appIdFor resolved,
            // so prefer it and keep the legacy read as the last fallback (issue #43).
            const appId = t.appId || q.config?.application?.id;
            let reason = null;
            if (!appId) {
                reason = 'this quest carries no application id, so there is nothing to authorize against';
                return { ok: false, reason };
            }
            // appId is interpolated straight into discordsays URLs. Refuse anything
            // non-numeric so a malformed/hostile id can't redirect the request elsewhere.
            if (!/^\d+$/.test(String(appId))) {
                reason = `the quest's application id ("${appId}") is not numeric, so it was refused before any request went out`;
                Logger.log(`[Bypass] Refusing non-numeric appId "${appId}".`, 'warn');
                return { ok: false, reason };
            }

            // Snapshot the grants this app already has BEFORE we authorize, so cleanup
            // revokes only the grant we create and never one the user made themselves.
            // The snapshot is a PRECONDITION: if it fails we abort before authorizing, so we
            // never create a grant we can't later identify and revoke.
            let preGrantIds;
            try {
                const before = await Mods.API.get({ url: '/oauth2/tokens' });
                if (!RUNTIME.running) return { ok: false, reason };
                preGrantIds = new Set((before?.body || []).filter(tk => tk.application?.id === appId).map(tk => tk.id));
            } catch (e) {
                if (!RUNTIME.running) return { ok: false, reason };
                Logger.log(`[Bypass] Couldn't snapshot existing grants; aborting so we never leave an un-revocable authorization: ${e?.message}`, 'warn');
                return { ok: false, reason };
            }

            try {
                // Consent gate: never OAuth-authorize a third-party app without the user's
                // explicit, informed OK. Resolve the app's display name for the prompt; a
                // decline aborts before the irreversible authorize. preGrantIds is already a
                // Set here (snapshot failure returned above), so no grant leaks on decline.
                let appName = null;
                try {
                    const a = await Mods.API.get({ url: `/applications/public?application_ids=${appId}` });
                    if (!RUNTIME.running) return { ok: false, reason };
                    appName = a?.body?.[0]?.name ?? null;
                } catch (_) {
                    if (!RUNTIME.running) return { ok: false, reason };
                }
                const consented = await Consent.ask(appId, appName);
                if (!RUNTIME.running) return { ok: false, reason };
                if (!consented) {
                    Logger.log(`[Bypass] Consent declined for "${t.name}". Not authorizing the app.`, 'warn');
                    return { ok: false, reason };
                }

                Logger.log(`[Bypass] Trying Discord Says auth flow for "${t.name}"...`, 'info');

                const authRes = await Mods.API.post({
                    url: '/oauth2/authorize',
                    query: {
                        response_type: 'code',
                        client_id: appId,
                        scope: 'identify applications.commands applications.entitlements'
                    },
                    body: {
                        permissions: '0',
                        authorize: true,
                        integration_type: 1,
                        location_context: { guild_id: '10000', channel_id: '10000', channel_type: 10000 }
                    }
                });
                if (!RUNTIME.running) return { ok: false, reason };
                const location = authRes?.body?.location;
                if (!location) throw new Error('no location in /oauth2/authorize response');
                const authCode = new URL(location).searchParams.get('code');
                if (!authCode) throw new Error('no code in authorize location');

                const ticketRes = await Mods.API.post({ url: `/applications/${appId}/proxy-tickets`, body: {} });
                if (!RUNTIME.running) return { ok: false, reason };
                const proxyTicket = ticketRes?.body?.ticket;
                if (!proxyTicket) throw new Error('no proxy ticket');

                const referrer = `https://${appId}.discordsays.com/?instance_id=example-cl-instance&platform=desktop&discord_proxy_ticket=${encodeURIComponent(proxyTicket)}`;

                const dsAuthRes = await Tasks._bypassPost(
                    `https://${appId}.discordsays.com/.proxy/acf/authorize`,
                    { 'Content-Type': 'application/json', 'X-Auth-Token': '', 'X-Discord-Quest-ID': q.id, 'Referer': referrer },
                    JSON.stringify({ code: authCode })
                );
                if (!RUNTIME.running) return { ok: false, reason };
                let dsToken;
                try { dsToken = JSON.parse(dsAuthRes.body)?.token; }
                catch { throw new Error('discordsays returned non-JSON: ' + String(dsAuthRes.body).slice(0, 120)); }
                if (!dsToken) throw new Error('no discordsays token');

                await Tasks._bypassPost(
                    `https://${appId}.discordsays.com/.proxy/acf/quest/progress`,
                    { 'Content-Type': 'application/json', 'X-Auth-Token': dsToken, 'X-Discord-Quest-ID': q.id, 'Referer': referrer },
                    JSON.stringify({ progress: t.target })
                );
                if (!RUNTIME.running) return { ok: false, reason };

                Logger.log(`[Bypass] Success. "${t.name}" completed via Discord Says.`, 'success');
                return { ok: true, reason: null };
            } catch (e) {
                if (!RUNTIME.running) return { ok: false, reason };
                // Discord renderer CSP blocks connect-src to *.discordsays.com. fetch() throws
                // TypeError "Failed to fetch" without a status. There's no userscript workaround
                // for this: the bypass needs a main-process HTTP client (Vencord plugin native module).
                if (e instanceof TypeError && /failed to fetch|networkerror/i.test(e.message)) {
                    Logger.log(`[Bypass] Discord's CSP blocks the script from reaching discordsays.com. Use the Vencord plugin port for the auto-bypass, since a userscript cannot bypass CSP. Skipping "${t.name}".`, 'warn');
                    return { ok: false, reason };
                }
                // Discord's API client rejects with {status, body:{code,message}}, not Error, so stringify properly
                const code = e?.body?.code;
                // 50165 = Cannot launch Age-Gated Activity: age-gated or delisted
                if (code === 50165) {
                    reason = 'the activity is age-gated or delisted, so Discord refuses the proxy ticket on this account';
                    Logger.log(`[Bypass] "${t.name}" can't be launched (age-gated or delisted). Discord blocks the proxy ticket, so there is nothing we can do.`, 'warn');
                    return { ok: false, reason };
                }
                const parts = [];
                if (e?.status) parts.push(`HTTP ${e.status}`);
                if (code) parts.push(`code ${code}`);
                if (e?.body?.message) parts.push(e.body.message);
                else if (e?.message) parts.push(e.message);
                else if (typeof e === 'string') parts.push(e);
                else if (e) { try { parts.push(JSON.stringify(e).slice(0, 200)); } catch { parts.push(String(e)); } }
                reason = `the Discord Says bypass failed (${parts.join(', ') || 'unknown error'})`;
                Logger.log(`[Bypass] Failed: ${parts.join(', ') || 'unknown'}`, 'warn');
                return { ok: false, reason };
            } finally {
                // Revoke ONLY the grant we created, diffed against the pre-flow snapshot.
                // Deliberately not gated on RUNTIME.running: a request sent before STOP may
                // already have created a grant that still needs compensating cleanup.
                if (preGrantIds) {
                    try {
                        const after = await Mods.API.get({ url: '/oauth2/tokens' });
                        const ours = (after?.body || []).filter(tk => tk.application?.id === appId && !preGrantIds.has(tk.id));
                        for (const g of ours) await Mods.API.del({ url: `/oauth2/tokens/${g.id}` });
                    } catch (e) {
                        Logger.log(`[Bypass] Deauthorize cleanup non-fatal: ${e?.message}`, 'debug');
                    }
                }
            }
        },

        // ACHIEVEMENT_IN_ACTIVITY. Target is usually 1 (a milestone, not seconds).
        // 1) heartbeat spoof (works for some quests)
        // 2) discordsays OAuth bypass (silver bullet)
        // 3) skip on failure, with no 25-minute passive wait
        async ACHIEVEMENT(q, t) {
            Logger.updateTask(q.id, { name: t.name, type: "ACHIEVEMENT", cur: 0, max: t.target, status: "RUNNING" });

            // attempt active heartbeat spoofing
            const key = buildStreamKey();

            if (key) {
                Logger.log(`[Task] Attempting heartbeat spoofing for "${t.name}"...`, 'info');
                // Discord's own heartbeat always carries application_id. Sending only
                // stream_key and terminal made every Orion beat structurally different.
                const beat = { stream_key: key, application_id: String(t.appId || ''), terminal: false };
                let cur = 0;
                let failCount = 0;

                while (cur < t.target && RUNTIME.running) {
                    try {
                        const r = await Traffic.enqueue(`/quests/${q.id}/heartbeat`, beat);
                        if (!RUNTIME.running) return;
                        cur = r?.body?.progress?.[t.keyName]?.value ?? r?.body?.progress?.ACHIEVEMENT_IN_ACTIVITY?.value ?? cur;
                        Logger.updateTask(q.id, { name: t.name, type: "ACHIEVEMENT", cur, max: t.target, status: "RUNNING" });
                        failCount = 0;

                        if (cur >= t.target) {
                            try { await Traffic.enqueue(`/quests/${q.id}/heartbeat`, { ...beat, terminal: true }); }
                            catch (_) { }
                            break;
                        }
                    } catch (e) {
                        if (!RUNTIME.running) return;
                        failCount++;
                        const err = ErrorHandler.classify(e);
                        if (err.isClientError) {
                            Logger.log(`[Achievement] Heartbeat rejected (HTTP ${err.status}). Falling back to passive mode.`, 'warn');
                            break;
                        }
                        if (failCount >= SYS.MAX_TASK_FAILURES) {
                            Logger.log(`[Achievement] Too many failures. Falling back to passive mode.`, 'warn');
                            break;
                        }
                    }
                    await sleep(rnd(19000, 22000));
                }

                if (cur >= t.target && RUNTIME.running) return Tasks.finish(q, t);
            }

            // heartbeat path failed or skipped, so try the Discord Says auth bypass
            if (!RUNTIME.running) return;
            const bypass = await Tasks.bypassAchievement(q, t);
            if (!RUNTIME.running) return;
            if (bypass.ok) return Tasks.finish(q, t);

            // both auto-paths failed: skip the quest. no more 25-min passive wait.
            Logger.log(`[Task] Skipping "${t.name}". No auto-completion path worked (heartbeat rejected, bypass blocked). Likely age-gated/delisted on your account.`, 'warn');
            // The bypass records why it gave up, so pass that on rather than a bare
            // "Cannot auto-complete", which left nothing to act on.
            return Tasks.failTask(q, t, bypass.reason ?? 'no auto-completion path worked');
        },

        // heartbeat loop against a voice channel to simulate activity participation
        async ACTIVITY(q, t) {
            const key = buildStreamKey();
            if (!key) {
                return Tasks.failTask(q, t, 'No voice channel found');
            }

            // Discord's own heartbeat always carries application_id. Sending only stream_key
            // and terminal made every Orion beat structurally different from a real one.
            const beat = { stream_key: key, application_id: String(t.appId || ''), terminal: false };
            let cur = 0;
            let failCount = 0;
            let stalledBeats = 0;
            Logger.updateTask(q.id, { name: t.name, type: "ACTIVITY", cur, max: t.target, status: "RUNNING" });

            const startTime = Date.now();

            while (cur < t.target && RUNTIME.running) {
                try {
                    const r = await Traffic.enqueue(`/quests/${q.id}/heartbeat`, beat);
                    const reported = r?.body?.progress?.[t.keyName]?.value ?? r?.body?.progress?.PLAY_ACTIVITY?.value;
                    // Never invent progress. This used to fall back to `cur + 20`, so a server
                    // that credited nothing still walked the counter to target and the quest
                    // was reported complete on the strength of numbers Orion made up. Count
                    // the silent beats and give up instead.
                    if (typeof reported === 'number') { cur = reported; stalledBeats = 0; }
                    else if (++stalledBeats >= SYS.MAX_TASK_FAILURES) return Tasks.failTask(q, t, 'Discord credited no progress');
                    Logger.updateTask(q.id, { name: t.name, type: "ACTIVITY", cur, max: t.target, status: "RUNNING" });
                    failCount = 0;
                    if (cur >= t.target) {
                        try { await Traffic.enqueue(`/quests/${q.id}/heartbeat`, { ...beat, terminal: true }); }
                        catch (e) { Logger.log(`[ACTIVITY] Final heartbeat failed: ${e?.message}`, 'debug'); }
                        break;
                    }
                } catch (e) {
                    failCount++;
                    const err = ErrorHandler.classify(e);
                    if (err.isClientError) {
                        Logger.log(`[Task] Activity quest unavailable (HTTP ${err.status}). Skipping.`, 'warn');
                        return Tasks.failTask(q, t, `Client Error ${err.status}`);
                    }
                    if (failCount >= SYS.MAX_TASK_FAILURES) {
                        return Tasks.failTask(q, t, 'Too many network failures');
                    }
                    Logger.log(`[Task] ACTIVITY heartbeat failed (${failCount}/${SYS.MAX_TASK_FAILURES}): ${err.message}`, 'debug');
                }

                if (Date.now() - startTime > SYS.MAX_TIME) {
                    return Tasks.failTask(q, t, 'Timeout exceeded');
                }
                await sleep(rnd(19000, 22000));
            }
            if (RUNTIME.running && cur >= t.target) Tasks.finish(q, t);
        },

        async finish(q, t) {
            Logger.updateTask(q.id, { name: t.name, type: t.type, cur: t.target, max: t.target, status: "COMPLETED" });
            // The one place the run knows a quest finished because of its own work.
            recordOutcome(Tasks.outcomes, q.id, 'completed');
            Logger.log(`[Task] Completed "${t.name}"!`, 'success');
            Sound.play('tick');

            try {
                if (typeof Notification !== 'undefined') {
                    // ask lazily on the first completion, not on paste (a permission prompt
                    // before the user has even picked a quest is intrusive).
                    if (Notification.permission === 'default') { try { await Notification.requestPermission(); } catch (_) { } }
                    if (Notification.permission === 'granted') {
                        new Notification("Orion: Quest Completed", { body: t.name, icon: "https://cdn.discordapp.com/emojis/1120042457007792168.webp", tag: `orion-${q.id}` });
                    }
                }
            } catch (e) { Logger.log(`[Notification] ${e.message}`, 'debug'); }

            if (RUNTIME.autoClaim) {
                try {
                    await sleep(rnd(2500, 6000));
                    if (!RUNTIME.running) return;
                    // optimistic claim. Try without captcha, show the button if challenged.
                    const claimRes = await this.claimReward(q.id);

                    if (claimRes?.body?.claimed_at) {
                        Logger.log(`[Claim] Reward for "${t.name}" claimed automatically!`, 'success');
                        Logger.updateTask(q.id, { name: t.name, type: t.type, cur: t.target, max: t.target, status: "CLAIMED" });
                        setTimeout(() => Logger.removeTask(q.id), 2000);  // ms before clearing finished tasks
                        return;
                    }
                } catch (e) {
                    // captcha required or other error, so fall through to the claim button
                    const needsCaptcha = e?.body?.captcha_key || e?.body?.captcha_sitekey;
                    if (needsCaptcha) {
                        Logger.log(`[Claim] Captcha required for "${t.name}". Use UI button.`, 'warn');
                    } else {
                        Logger.log(`[Claim] Auto-claim failed for "${t.name}": ${e?.body?.message ?? e?.message}`, 'err');
                    }
                }
            }

            // show claim button instead of auto-removing
            Logger.updateTask(q.id, { name: t.name, type: t.type, cur: t.target, max: t.target, status: "COMPLETED", claimable: true, questId: q.id });
        }
    };

    /* ── webpack module extraction ───────────────────────────────
       Uses getName() as a stable discriminator for Flux stores.
       Real stores return their name (e.g. "QuestStore"), fakes
       return "[object Object]". No hardcoded property paths needed.
       Dispatcher and API use structural checks instead.
    ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── */

    /* Adapter over Discord's protobuf user settings, used to flip status.showCurrentGame
       for HIDE_ACTIVITY. Deliberately not going through Vencord's UserSettingsAPI: that
       one throws unless the *calling plugin* declared it as a dependency, and a console
       script has no plugin manifest. The proto action creators are identified by
       ProtoClass.typeName (Vencord's own discriminator) or the updateAsync+type===1 pair
       (BetterDiscord's), and the BoolValue wrapper by its proto typeName. The setting
       fields are wrapper messages, not raw booleans. */
    function findShowCurrentGameSetting(moduleCache) {
        if (!moduleCache) return undefined;

        let actions, delay, BoolValue;
        for (const m of Object.values(moduleCache)) {
            try {
                const exp = m?.exports;
                if (!exp || typeof exp !== 'object') continue;

                for (const key of Object.keys(exp)) {
                    const p = exp[key];
                    if (!p) continue;

                    // Match by proto typeName over any export, not by an export named BoolValue:
                    // the key is minified on some builds, and then a name-only lookup misses and
                    // the write below throws. This is BetterDiscord's discriminator.
                    if (!BoolValue && typeof p.create === 'function'
                        && String(p.typeName ?? '').includes('Bool')) BoolValue = p;

                    if (!actions && typeof p.updateAsync === 'function'
                        && (p.ProtoClass?.typeName?.endsWith('.PreloadedUserSettings') || p.type === 1)) {
                        actions = p;
                        // enum member name varies; 0 is the "act now" delay every build accepts
                        delay = exp.UserSettingsDelay?.INFREQUENT_USER_ACTION ?? 0;
                    }
                }
                if (actions && BoolValue) break;  // module cache is large, so stop once both are in hand
            } catch { }
        }
        if (!actions) return undefined;
        if (!BoolValue) Logger.log('[Patcher] BoolValue proto type not found. Hiding activity will only work if the setting already exists.', 'debug');

        return {
            // undefined when the shape moved. Callers treat that as "unknown, assume on".
            getSetting: () => actions.getCurrentValue?.()?.status?.showCurrentGame?.value,
            updateSetting: value => actions.updateAsync('status', settings => {
                if (settings.showCurrentGame && typeof settings.showCurrentGame.value === 'boolean') {
                    settings.showCurrentGame.value = value;
                } else if (BoolValue) {
                    settings.showCurrentGame = BoolValue.create({ value });
                } else {
                    throw new Error('BoolValue proto type not found');
                }
            }, delay)
        };
    }

    function loadModules() {
        try {
            // === VENCORD USAGE ===
            if (typeof window.Vencord !== 'undefined' && window.Vencord.Webpack) {
                Logger.log('[System] Vencord detected. Using Vencord Webpack API...', 'info');
                const W = window.Vencord.Webpack;

                let routerModule;
                try {
                    const m = W.findByCode('transitionTo -');
                    if (m) {
                        for (const prop of [m, m.default, ...Object.values(m)]) {
                            if (typeof prop === 'function' && prop.toString().includes('transitionTo -')) {
                                routerModule = { transitionTo: prop };
                                break;
                            }
                        }
                    }
                } catch (e) { }

                Mods = {
                    QuestStore: W.findStore('QuestStore') || W.findStore('QuestsStore'),
                    RunStore: W.findStore('RunningGameStore'),
                    StreamStore: W.findStore('ApplicationStreamingStore'),
                    ChanStore: W.findStore('ChannelStore'),
                    GuildChanStore: W.findStore('GuildChannelStore'),
                    UserStore: W.findStore('UserStore'),
                    OrbStore: W.findStore('VirtualCurrencyStore'),
                    Dispatcher: W.Common?.FluxDispatcher || W.findByProps('dispatch', 'subscribe', 'flushWaitQueue'),
                    API: W.Common?.RestAPI || W.findByProps('get', 'post', 'del'),
                    Router: routerModule,
                    // Vencord exposes the raw webpack require, so the same cache scan works here
                    ShowCurrentGame: findShowCurrentGameSetting(W.cache || W.wreq?.c)
                };

                const required = ['QuestStore', 'API', 'Dispatcher', 'RunStore'];
                const missing = required.filter(k => !Mods[k]);

                if (missing.length === 0) {
                    const optional =['StreamStore', 'ChanStore', 'GuildChanStore', 'Router'];
                    optional.forEach(k => { if (!Mods[k]) Logger.log(`[System] Optional module '${k}' not found. Features may be limited.`, 'warn'); });

                    Patcher.init(Mods.RunStore);
                    return true;
                }
                Logger.log(`[System] Vencord extraction missed: ${missing.join(', ')}. Falling back to native...`, 'warn');
            }

            // === NATIVE FALLBACK (Canary / PTB without mods) ===
            if (typeof webpackChunkdiscord_app === 'undefined') {
                throw new Error("Webpack chunk not found - is this running inside Discord?");
            }

            // The push callback fires once per registered webpack runtime. Discord ships
            // Sentry's stripped runtime alongside the real one, and Sentry's `req.c` is tiny.
            // Pick the require with the largest cache so we ignore the Sentry instance.
            let req;
            webpackChunkdiscord_app.push([[Symbol()], {}, (r) => {
                const cur = Object.keys(req?.c || {}).length;
                const incoming = Object.keys(r?.c || {}).length;
                if (incoming > cur) req = r;
            }]);
            webpackChunkdiscord_app.pop();

            if (!req?.c) throw new Error("Module registry not available - Discord build incompatible (see issue #20)");

            const modules = Object.values(req.c);

            // real Flux stores have constructor.displayName set to their class name
            // fakes have displayName "Object". This check never triggers Proxy traps.
            function findStore(storeName) {
                for (const m of modules) {
                    try {
                        const exp = m?.exports;
                        if (!exp || typeof exp !== 'object') continue;
                        for (const key of Object.keys(exp)) {
                            const prop = exp[key];
                            if (prop && typeof prop === 'object'
                                && prop.__proto__?.constructor?.displayName === storeName) {
                                return prop;
                            }
                        }
                    } catch { }
                }
                return undefined;
            }

            // Dispatcher has _subscriptions + subscribe on proto, no valid getName
            function findDispatcher() {
                for (const m of modules) {
                    try {
                        const exp = m?.exports;
                        if (!exp || typeof exp !== 'object') continue;
                        for (const key of Object.keys(exp)) {
                            const prop = exp[key];
                            if (prop && prop._subscriptions
                                && typeof prop.subscribe === 'function'
                                && typeof prop.dispatch === 'function'
                                && typeof prop.__proto__?.flushWaitQueue === 'function') {
                                return prop;
                            }
                        }
                    } catch { }
                }
                return undefined;
            }

            // Discord's API client has .del (not .delete), which distinguishes it
            // from generic HTTP wrappers. Also has get/post/put/patch as own props.
            function findAPI() {
                for (const m of modules) {
                    try {
                        const exp = m?.exports;
                        if (!exp || typeof exp !== 'object') continue;
                        for (const key of Object.keys(exp)) {
                            const prop = exp[key];
                            if (prop && typeof prop.get === 'function'
                                && typeof prop.post === 'function'
                                && typeof prop.del === 'function'
                                && !prop._dispatcher) {
                                return prop;
                            }
                        }
                    } catch { }
                }
                return undefined;
            }

            // Navigation functions are exported standalone and minified.
            // transitionTo is identified by searching its source code for the "transitionTo -" signature.
            function findRouter() {
                for (const m of modules) {
                    try {
                        const exp = m?.exports;
                        if (!exp) continue;

                        for (const prop of [exp, exp.default, ...Object.values(exp)]) {
                            if (typeof prop === 'function' && prop.toString().includes('transitionTo -')) {
                                return { transitionTo: prop };
                            }
                        }
                    } catch { }
                }
                return undefined;
            }

            Mods = {
                QuestStore: findStore('QuestStore'),
                RunStore: findStore('RunningGameStore'),
                StreamStore: findStore('ApplicationStreamingStore'),
                ChanStore: findStore('ChannelStore'),
                GuildChanStore: findStore('GuildChannelStore'),
                UserStore: findStore('UserStore'),
                OrbStore: findStore('VirtualCurrencyStore'),
                Dispatcher: findDispatcher(),
                API: findAPI(),
                Router: findRouter(),
                ShowCurrentGame: findShowCurrentGameSetting(req.c)
            };

            const required = ['QuestStore', 'API', 'Dispatcher', 'RunStore'];
            const missing = required.filter(k => !Mods[k]);
            if (missing.length > 0) throw new Error(`Core modules not found: ${missing.join(', ')}`);

            const optional = ['StreamStore', 'ChanStore', 'GuildChanStore', 'Router'];
            optional.forEach(k => { if (!Mods[k]) Logger.log(`[System] Optional module '${k}' not found. Features may be limited.`, 'warn'); });
            Patcher.init(Mods.RunStore);
            return true;
        } catch (e) {
            Logger.log(`[System] Module loading error: ${e.message ?? e}`, 'err');
            console.error(e);
            return false;
        }
    }

    /* ── main loop ─────────────────────────────────────────────── */

    // run async tasks concurrently up to a specified limit
    async function runConcurrent(tasks, limit) {
        const executing = new Set();

        for (const task of tasks) {
            if (!RUNTIME.running) break;

            const p = task().finally(() => executing.delete(p));
            executing.add(p);

            await sleep(rnd(1500, 4000)); // stagger initialization to avoid API bursts

            if (executing.size >= limit) {
                await Promise.race(executing);
            }
        }

        // use allSettled to prevent a single rejection from crashing the batch
        return Promise.allSettled(executing);
    }

    async function main() {
        Logger.init();
        if (!loadModules()) return Logger.log('[System] Failed to load Discord modules. Aborting.', 'err');

        // show quest picker and wait for user selection
        const getQuests = () => {
            const q = Mods.QuestStore.quests;
            return q instanceof Map ? [...q.values()] : Object.values(q);
        };

        // Discord fetches its quest list a few seconds after the client boots, so a paste into a
        // console that was opened immediately can land on an empty store. Wait for it rather than
        // reporting "all completed" for a list that has not arrived yet (issue #74).
        if (!getQuests().length) {
            Logger.log('[System] Waiting for Discord to send its quest list...', 'info');
            for (let waited = 0; waited < 15000 && !getQuests().length && RUNTIME.running; waited += 250) {
                await new Promise(r => setTimeout(r, 250));
            }
        }
        if (!RUNTIME.running) return;

        const allQuests = getQuests();
        let quests = allQuests.filter(q =>
            !q.userStatus?.completedAt
            && notExpired(q)
            && q.id !== CONST.ID
            && !Tasks.skipped.has(q.id)
        );

        if (!quests.length) {
            // An empty store and a store full of finished quests read identically to the user
            // otherwise, and only one of them means "come back later".
            if (!allQuests.length) {
                Logger.log('[System] Discord has not given this client a quest list. Reload Discord (Ctrl+R) and paste again.', 'err');
            } else {
                Logger.log('[System] All available quests are completed!', 'success');
            }
            return Logger.shutdown();
        }

        const pickerResult = await Logger.showQuestPicker(quests);
        if (!RUNTIME.running) return;

        // Propagate UI options to global runtime state
        RUNTIME.autoEnroll = pickerResult.autoEnroll;
        RUNTIME.autoClaim = pickerResult.autoClaim;
        RUNTIME.playSound = pickerResult.playSound;
        RUNTIME.randomDelay = pickerResult.randomDelay;

        if (pickerResult.selectedQuests.size === 0) {
            Logger.log('[System] No quests selected. Shutting down.', 'info');
            return Logger.shutdown();
        }

        let loopCount = 1;

        while (RUNTIME.running) {
            try {
                Logger.log(`[Cycle] Starting loop #${loopCount}...`, 'info');

                // Discord tells the client when the account may not enroll in anything, and
                // the quest list carries the timestamp. Checked every cycle rather than once
                // at start, because the block can land mid-run, and running past it means
                // hammering an endpoint that is already refusing us.
                const suspendedUntil = questAccessSuspendedUntil();
                if (suspendedUntil) {
                    const when = suspendedUntil.getTime() === 0 ? 'for now' : `until ${suspendedUntil.toLocaleString()}`;
                    Logger.log(`[System] Discord has suspended quest access on this account ${when}. Its own client refuses to start a quest in this state, so Orion stops too.`, 'err');
                    break;
                }

                const blockedUntil = enrollmentBlockedUntil();
                if (blockedUntil) {
                    Logger.log(`[System] Discord has blocked quest enrollment on this account until ${blockedUntil.toLocaleString()}. Stopping instead of retrying.`, 'err');
                    break;
                }

                quests = getQuests();

                // Filter out completed, expired, blacklisted, skipped, AND unselected quests
                const active = quests.filter(q =>
                    pickerResult.selectedQuests.has(q.id)
                    && !q.userStatus?.completedAt
                    && notExpired(q)
                    && q.id !== CONST.ID
                    && !Tasks.skipped.has(q.id)
                );

                if (!active.length) {
                    // Saying "all completed" here is how a quest this client skipped, or one that
                    // died in a handler, used to read as a finished one. The counts come from what
                    // the run recorded as it went, not from which quests gained completedAt while
                    // it was alive, which cannot tell this script's work from the user's.
                    const summary = summarizeRun(Tasks.outcomes);
                    Logger.log(`[System] ${summary.line}`, summary.blocked || summary.failed ? 'warn' : 'success');
                    if (summary.playDone) Sound.play('done');
                    break;
                }

                const queues = { video: [], game: [] };

                active.forEach(q => {
                    try {
                        const cfg = selectTaskConfig(q.config);
                        const questName = q.config?.messages?.questName ?? q.id;
                        const hasTaskConfig = !!cfg?.tasks && typeof cfg.tasks === 'object';
                        const typeData = hasTaskConfig ? Tasks.detectType(cfg, q.config?.application?.id) : null;
                        const blocker = questBlocker({
                            name: questName,
                            hasTaskConfig,
                            keys: hasTaskConfig ? taskKeys(cfg.tasks) : [],
                            typeData,
                            isDesktop: SYS.IS_DESKTOP
                        });
                        if (blocker) {
                            Logger.log(`[Quest] ${blocker} Skipping it for the rest of this run.`, 'warn');
                            // Marking the quest skipped is the point: the active filter reads this
                            // set, and without it the same quest comes back every cycle (issue #78).
                            Tasks.skipped.add(q.id);
                            recordOutcome(Tasks.outcomes, q.id, 'blocked');
                            return;
                        }

                        const { type, keyName, target, appId } = typeData;

                        const tInfo = {
                            id: q.id,
                            appId: appId ?? 0,
                            name: q.config?.messages?.questName ?? "Unknown Quest",
                            target,
                            type,
                            keyName  // actual task key from config (e.g. WATCH_VIDEO_ON_MOBILE)
                        };

                        // handle disabled auto-enroll (wait for user)
                        if (!q.userStatus?.enrolledAt && !RUNTIME.autoEnroll) {
                            Logger.updateTask(tInfo.id, {
                                name: tInfo.name, type: tInfo.type, cur: 0, max: tInfo.target,
                                status: "PENDING", actionRequired: 'ENROLL'
                            });
                            return; // skip execution queue, wait for next cycle
                        }

                        if (Logger.tasks.has(q.id) && Logger.tasks.get(q.id).status === "RUNNING") return;

                        // clear the action button if user enrolled manually
                        Logger.updateTask(tInfo.id, {
                            name: tInfo.name, type: tInfo.type, cur: 0, max: tInfo.target,
                            status: "QUEUE", actionRequired: null
                        });

                        const taskFunc = async () => {
                            // JIT enrollment (only if autoEnroll is true or user already enrolled)
                            if (!q.userStatus?.enrolledAt) {
                                Logger.log(`[Enroll] Accepting quest: ${tInfo.name}`, 'info');
                                try {
                                    await Traffic.enqueue(`/quests/${q.id}/enroll`, {
                                        location: 11,
                                        is_targeted: false,
                                        metadata_sealed: null,
                                        traffic_metadata_sealed: sealedFor(q.id)
                                    });
                                    await sleep(rnd(800, 1500));
                                } catch (e) {
                                    const err = ErrorHandler.classify(e);
                                    if (ErrorHandler.isSkippableQuest(e)) {
                                        Tasks.skipped.add(q.id);
                                        Logger.log(`[Enroll] ${tInfo.name} unavailable (${err.status}). Skipping.`, 'warn');
                                    } else {
                                        Logger.log(`[Enroll] Failed for ${tInfo.name}: ${err.message}`, 'err');
                                    }
                                    return Tasks.failTask(q, tInfo, `Enrollment failed`);
                                }
                            }

                            if (type === "WATCH_VIDEO") return Tasks.VIDEO(q, tInfo, q.userStatus);
                            if (type === "ACHIEVEMENT") return Tasks.ACHIEVEMENT(q, tInfo);
                            const runner = type === "STREAM" ? Tasks.STREAM : (type === "ACTIVITY" ? Tasks.ACTIVITY : Tasks.GAME);
                            return runner(q, tInfo, q.userStatus);
                        };

                        if (type === "WATCH_VIDEO") queues.video.push(taskFunc);
                        else queues.game.push(taskFunc);
                    } catch (e) {
                        Logger.log(`[Quest] Error processing ${q.id}: ${e.message}`, 'err');
                    }
                });

                const totalTasks = queues.video.length + queues.game.length;

                if (totalTasks > 0) {
                    Logger.log(`[Cycle] Processing: ${queues.video.length} videos, ${queues.game.length} games.`, 'info');
                    const pGames = runConcurrent(queues.game, 1);
                    const pVideos = runConcurrent(queues.video, 2);
                    await Promise.all([pGames, pVideos]);
                } else {
                    if (active.length === 0) { Logger.log('[System] All available quests are completed!', 'success'); break; }
                    else await sleep(rnd(4000, 6000));  // idle loop wait
                }

                if (!RUNTIME.running) break;

                // anti-detection: opt-in randomized idle gap between cycles. each cycle
                // typically completes 1+ quests, so this throttles overall quest velocity.
                if (RUNTIME.randomDelay) {
                    const delayMs = rnd(60000, 1800000); // 1-30 minutes
                    Logger.log(`[Cycle] Loop #${loopCount} complete. Random delay: ${Math.round(delayMs / 60000)}m before rescan.`, 'info');
                    await sleep(delayMs);
                } else {
                    Logger.log(`[Cycle] Loop #${loopCount} complete. Waiting before rescan...`, 'info');
                    await sleep(rnd(2500, 4500));
                }
                loopCount++;

            } catch (cycleError) {
                Logger.log(`[Cycle] Error in loop #${loopCount}: ${cycleError?.message ?? cycleError}`, 'err');
                console.error(cycleError);
                await sleep(3000);
                loopCount++;
            }
        }

        // Keep the UI alive if there are unclaimed rewards waiting. Losing the
        // dashboard the moment the queue finishes means users miss the CLAIM
        // buttons (especially when auto-claim is off). User can click STOP manually.
        const hasUnclaimed = [...Logger.tasks.values()].some(t => t.claimable && !t.removing);
        if (hasUnclaimed) {
            Logger.log('[System] Quest cycle finished. Claim your rewards above, then click STOP.', 'info');
            return; // skip shutdown; the STOP button still works
        }

        Logger.shutdown();
    }

    main().catch(e => {
        const msg = e?.message ?? e?.toString?.() ?? "Unknown fatal error";
        console.error('[Orion Fatal]', e);
        try { Logger.log(`[System] FATAL: ${msg}`, 'err'); } catch (_) { }
        Logger.shutdown();

        // Failsafe: release lock unconditionally so user can retry without reloading tab
        setTimeout(() => { window.orionLock = false; }, 1500);
    });
})();
