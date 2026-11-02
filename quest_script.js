(async () => {
    "use strict";

    /* ── config (Safe for users to edit) ────────────────────────── */

    const CONFIG = {
        NAME: "Orion",
        VERSION: "v4.11.5",
        THEME: "#5865F2",               // discord blurple
        SUCCESS: "#23a55a",
        WARN: "#f0b232",
        ERR: "#f23f43",
        HIDE_ACTIVITY: false,           // hide "Playing ..." while quests run (turns Discord's own
                                        // showCurrentGame off for the duration, restores it after)
        PLAY_SESSION_TAIL_MIN: 2,       // minutes to keep a finished game quest's fake process
                                        // running, picked at random between 40% and 100% of this
                                        // each time. 0 drops it on the tick that crossed the
                                        // target, which makes every session exactly as long as
                                        // the quest requirement. Costs no extra requests: Discord
                                        // ends the quest heartbeat itself on completion, so this
                                        // only extends the "Playing ..." presence.
        MAX_LOG_ITEMS: 60,              // UI log limit
        GAME_CONCURRENCY: 15            // maximum game quests to run in parallel
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
        playSound: true,                // whether to play an audio cue on quest completion
        randomDelay: false,             // whether to inject randomized 1-30min idle gaps between quests (anti-detection)
        parallelGames: true             // whether to run multiple game quests in parallel
    };

    /* ── audio cue ───────────────────────────────────────────────── */
    const Sound = {
        _ctx: null,
        play(type) {
            if (!RUNTIME.playSound) return;
            try {
                const Ctx = window.AudioContext || window.webkitAudioContext;
                if (!Ctx) return;
                if (!this._ctx || this._ctx.state === 'closed') this._ctx = new Ctx();
                const ctx = this._ctx;
                const o = ctx.createOscillator();
                const g = ctx.createGain();
                o.connect(g); g.connect(ctx.destination);
                o.type = 'sine';
                const t0 = ctx.currentTime;
                if (type === 'done') {
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

    /* ── OAuth consent gate ────────────────────────────────────── */
    const Consent = {
        _granted: new Set(),
        TIMEOUT: 60000,
        SCOPES: ['identify', 'applications.commands', 'applications.entitlements'],
        ask(appId, appName) {
            if (this._granted.has(appId)) return Promise.resolve(true);
            return new Promise(resolve => {
                const ov = document.createElement('div');
                ov.id = 'orion-consent';
                ov.innerHTML = `
                    <div class="orion-modal" role="dialog" aria-modal="true">
                        <div class="orion-modal-head">
                            <div class="orion-modal-title">Authorize Application</div>
                            <div class="orion-modal-subtitle">OAuth2 Activity Bypass</div>
                        </div>
                        <div class="orion-modal-body">
                            <p class="orion-modal-desc">To complete this achievement quest, Orion needs to authorize the following application on your Discord account:</p>
                            <div id="oc-app" class="orion-modal-app"></div>
                            <div class="orion-modal-label">Requested Permissions</div>
                            <div id="oc-scopes" class="orion-scope-list"></div>
                            <div class="orion-modal-warn">
                                The application's backend receives a real authorization code. Orion revokes the grant immediately after the quest is marked complete. Discord enforcement against quest automation can affect the whole account.
                            </div>
                            <label class="orion-modal-remember">
                                <input type="checkbox" id="oc-remember" class="native-cb">
                                <span>Do not ask again for this application during this session</span>
                            </label>
                        </div>
                        <div class="orion-modal-foot">
                            <button type="button" id="oc-no" class="quest-pick-btn deselect">Cancel</button>
                            <button type="button" id="oc-yes" class="quest-pick-btn start">Authorize</button>
                        </div>
                    </div>`;
                document.body.appendChild(ov);
                ov.querySelector('#oc-app').textContent = appName ? `${appName} (${appId})` : `Application ${appId}`;
                const scopeBox = ov.querySelector('#oc-scopes');
                this.SCOPES.forEach(s => {
                    const chip = document.createElement('span');
                    chip.className = 'orion-scope-chip';
                    chip.textContent = s;
                    scopeBox.appendChild(chip);
                });
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
        VIDEO: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M10 16.5l6-4.5-6-4.5v9zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>`,
        GAME: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M21 6H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-10 7H8v3H6v-3H3v-2h3V8h2v3h3v2zm4.5 2c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm4-3c-.83 0-1.5-.67-1.5-1.5S18.67 9 19.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>`,
        STREAM: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>`,
        ACTIVITY: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z"/></svg>`,
        CHECK: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`,
        CLOCK: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"/><path d="M12.5 7H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>`,
        STOP: `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>`,
        COMPASS: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>`,
        TERM: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`,
        MINIMIZE: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>`
    });

    const CONST = Object.freeze({
        ID: "1412491570820812933",
        EVT: Object.freeze({
            HEARTBEAT: "QUESTS_SEND_HEARTBEAT_SUCCESS",
            HEARTBEAT_FAIL: "QUESTS_SEND_HEARTBEAT_FAILURE",
            GAME: "RUNNING_GAMES_CHANGE",
            RPC: "LOCAL_ACTIVITY_UPDATE"
        })
    });

    if (window.orionLock) {
        const existingUI = document.getElementById('orion-ui');
        if (existingUI) existingUI.style.display = 'flex';
        return console.warn(`[${CONFIG.NAME}] Already running.`);
    }
    window.orionLock = true;

    /* ── util ──────────────────────────────────────────────────── */

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const rnd = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    const notExpired = q => {
        try {
            const store = Mods.QuestStore;
            if (typeof store?.isQuestExpired === 'function') return store.isQuestExpired(q.id) !== true;
        } catch (_) { }
        const e = new Date(q.config?.expiresAt ?? 0).getTime();
        return Number.isNaN(e) || e > Date.now();
    };

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

    const canUseMoreQuestOrbs = () => {
        try {
            const user = Mods.UserStore?.getCurrentUser?.();
            return user != null && Mods.Premium?.canUseMoreQuestOrbs?.(user) === true;
        } catch {
            return false;
        }
    };

    const orbPayout = (reward, boosted) => (reward ? (boosted ? reward.premium : reward.orbs) : 0);
    const fmtOrbs = (reward, boosted) => (reward ? `${orbPayout(reward, boosted)} Orbs` : '');
    const orbBalance = v => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

    const readOrbBalance = async () => {
        const account = Mods.UserStore?.getCurrentUser?.()?.id ?? null;
        if (!account) throw new Error('no account is signed in');
        const store = Mods.OrbStore;
        const stored = orbBalance(store?.getCurrentBalance?.() ?? store?.balance);
        if (stored !== null) return stored;
        const res = await Mods.API.get({ url: '/users/@me/virtual-currency/balance' });
        const after = Mods.UserStore?.getCurrentUser?.()?.id ?? null;
        if (after !== account) throw new Error('the account changed during the read');
        return orbBalance(res?.body?.balance);
    };

    const sealedFor = questId => {
        try { return Mods.QuestStore?.getQuest?.(questId)?.trafficMetadataSealed ?? null; }
        catch (_) { return null; }
    };

    const CONSOLE_ONLY_KEYS = new Set(['PLAY_ON_XBOX', 'PLAY_ON_PLAYSTATION']);
    const taskKeys = (tasks) => (tasks instanceof Map ? [...tasks.keys()] : Object.keys(tasks ?? {}));
    const taskAt = (tasks, key) => (tasks instanceof Map ? tasks.get(key) : tasks?.[key]);

    const selectTaskConfig = (config) => {
        const current = config?.taskConfigV2;
        if (taskKeys(current?.tasks).length > 0) return current;
        const legacy = config?.taskConfig;
        if (taskKeys(legacy?.tasks).length > 0) return legacy;
        return current ?? legacy ?? null;
    };

    const UNAUTOMATABLE_KEYS = new Map([
        ['ACHIEVEMENT_IN_GAME', 'That needs the game linked to your account and an achievement earned inside the game itself, which nothing running in Discord can do for you.']
    ]);

    const questBlocker = ({ name, hasTaskConfig, keys, typeData, isDesktop }) => {
        if (!hasTaskConfig) return `"${name}" has no usable task config, so there is nothing to drive.`;

        if (!typeData) {
            if (!keys.length) return `"${name}" lists no tasks at all, so there is nothing to drive.`;
            if (keys.every(k => CONSOLE_ONLY_KEYS.has(k))) return `"${name}" is console-only (${keys.join(', ')}), so no desktop client can run it.`;

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
        if ((type === 'GAME' || type === 'STREAM') && !appId) return `"${name}" has no application id in its config, so the game cannot be spoofed.`;

        return null;
    };

    const recordOutcome = (outcomes, id, outcome) => {
        if (outcomes.get(id) === 'completed') return;
        outcomes.set(id, outcome);
    };

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

    const questAccessSuspendedUntil = () => {
        const store = Mods.QuestStore;
        if (!store) return null;
        const explicit = futureDate(store.questAccessSuspendedUntil);
        if (explicit) return explicit;
        return store.isQuestAccessSuspended === true ? new Date(0) : null;
    };

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

        isSkippableQuest(error) {
            const status = error?.status;
            return status === 404 || status === 403 || status === 410;
        }
    };

    /* ── UI + logger ──────────────────────────────────────────── */
    const Logger = {
        root: null, tasks: new Map(), tickerId: null, _hotkey: null, logsOpen: true,

        init() {
            const oldUI = document.getElementById('orion-ui'); if (oldUI) oldUI.remove();
            const oldStyle = document.getElementById('orion-styles'); if (oldStyle) oldStyle.remove();

            const style = document.createElement('style');
            style.id = 'orion-styles';
            style.innerHTML = `
                #orion-ui,
                #orion-consent,
                #orion-unhide-pill {
                    --orion-bg-primary: var(--background-primary, var(--background-base-low, #313338));
                    --orion-bg-secondary: var(--background-secondary, var(--background-base-lower, #2b2d31));
                    --orion-bg-secondary-alt: var(--background-secondary-alt, #232428);
                    --orion-bg-tertiary: var(--background-tertiary, var(--background-base-lowest, #1e1f22));
                    --orion-bg-floating: var(--background-floating, #111214);
                    --orion-mod-hover: var(--background-modifier-hover, rgba(78, 80, 88, 0.3));
                    --orion-mod-active: var(--background-modifier-active, rgba(78, 80, 88, 0.48));
                    --orion-mod-selected: var(--background-modifier-selected, rgba(78, 80, 88, 0.6));
                    --orion-border: var(--background-modifier-accent, var(--border-subtle, rgba(255, 255, 255, 0.08)));
                    --orion-header-primary: var(--header-primary, var(--text-strong, #f2f3f5));
                    --orion-header-secondary: var(--header-secondary, #b5bac1);
                    --orion-text-normal: var(--text-normal, var(--text-default, #dbdee1));
                    --orion-text-muted: var(--text-muted, #949ba4);
                    --orion-interactive-normal: var(--interactive-normal, #b5bac1);
                    --orion-interactive-hover: var(--interactive-hover, #dbdee1);
                    --orion-interactive-active: var(--interactive-active, #ffffff);
                    --orion-brand: var(--brand-500, var(--brand-experiment, #5865f2));
                    --orion-brand-hover: var(--brand-560, #4752c4);
                    --orion-btn-secondary: var(--button-secondary-background, #4e5058);
                    --orion-btn-secondary-hover: var(--button-secondary-background-hover, #6d6f78);
                    --orion-green: var(--status-positive, #23a55a);
                    --orion-green-hover: #1a8346;
                    --orion-yellow: var(--status-warning, #f0b232);
                    --orion-red: var(--button-danger-background, var(--status-danger, #da373c));
                    --orion-red-hover: var(--button-danger-background-hover, #a12828);
                    --orion-font: var(--font-primary, "gg sans", "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif);
                    --orion-mono: var(--font-code, "gg mono", "Source Code Pro", Consolas, Monaco, monospace);
                }

                #orion-ui {
                    position: fixed;
                    top: 32px;
                    left: 20px;
                    right: auto;
                    width: 380px;
                    max-height: 560px;
                    background: var(--orion-bg-secondary);
                    color: var(--orion-text-normal);
                    border: 1px solid var(--orion-border);
                    border-radius: 8px;
                    box-shadow: var(--elevation-high, 0 8px 16px rgba(0, 0, 0, 0.24));
                    z-index: 1001;
                    font-family: var(--orion-font);
                    font-size: 13px;
                    line-height: 1.35;
                    overflow: hidden;
                    display: flex;
                    flex-direction: column;
                    box-sizing: border-box;
                    user-select: none;
                    -webkit-app-region: no-drag;
                    font-variant-numeric: tabular-nums;
                }

                #orion-ui *,
                #orion-ui *::before,
                #orion-ui *::after,
                #orion-consent *,
                #orion-consent *::before,
                #orion-consent *::after {
                    box-sizing: border-box;
                }

                /* Header */
                #orion-head {
                    height: 44px;
                    padding: 0 12px;
                    background: var(--orion-bg-secondary-alt);
                    flex: 0 0 44px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    border-bottom: 1px solid var(--orion-border);
                    cursor: grab;
                }
                #orion-head.dragging {
                    cursor: grabbing;
                }

                #orion-brand {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    min-width: 0;
                }
                .orion-logo-badge {
                    width: 16px;
                    height: 16px;
                    color: var(--orion-interactive-normal);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    flex-shrink: 0;
                }
                #orion-title-wrap {
                    display: flex;
                    align-items: baseline;
                    gap: 6px;
                    min-width: 0;
                }
                #orion-title {
                    font-weight: 600;
                    font-size: 14px;
                    color: var(--orion-header-primary);
                }

                #orion-controls {
                    display: flex;
                    gap: 4px;
                    align-items: center;
                }
                #orion-ui .ctrl-btn {
                    cursor: pointer;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    gap: 4px;
                    height: 28px;
                    padding: 0 8px;
                    border-radius: 4px;
                    background: transparent;
                    border: none;
                    color: var(--orion-interactive-normal);
                    font-size: 12px;
                    font-weight: 500;
                    transition: background-color 0.1s ease, color 0.1s ease;
                }
                #orion-ui .ctrl-btn:hover {
                    background: var(--orion-mod-hover);
                    color: var(--orion-interactive-hover);
                }
                #orion-ui .ctrl-btn.icon-only {
                    width: 28px;
                    padding: 0;
                }
                #orion-ui .ctrl-btn.active {
                    background: var(--orion-mod-selected);
                    color: var(--orion-interactive-active);
                }
                #orion-ui .ctrl-stop {
                    height: 24px;
                    padding: 0 8px;
                    margin-left: 2px;
                    border-radius: 3px;
                    background: var(--orion-red);
                    color: #ffffff;
                    font-size: 12px;
                    font-weight: 500;
                }
                #orion-ui .ctrl-stop:hover {
                    background: var(--orion-red-hover);
                    color: #ffffff;
                }

                /* Settings Drawer */
                #orion-settings-drawer {
                    display: none;
                    padding: 10px 12px;
                    background: var(--orion-bg-primary);
                    border-bottom: 1px solid var(--orion-border);
                    font-size: 13px;
                    flex: 0 0 auto;
                }
                #orion-ui .settings-head {
                    font-weight: 600;
                    font-size: 12px;
                    color: var(--orion-header-secondary);
                    margin-bottom: 6px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                #orion-ui .settings-close {
                    cursor: pointer;
                    color: var(--orion-interactive-normal);
                    font-size: 12px;
                    font-weight: 500;
                    padding: 2px 6px;
                    border-radius: 3px;
                }
                #orion-ui .settings-close:hover {
                    background: var(--orion-mod-hover);
                    color: var(--orion-interactive-hover);
                }
                #orion-ui .settings-grid {
                    display: flex;
                    flex-direction: column;
                }
                #orion-ui .settings-row {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 7px 0;
                    border-bottom: 1px solid var(--orion-border);
                    cursor: pointer;
                }
                #orion-ui .settings-row:last-child {
                    border-bottom: none;
                }
                #orion-ui .settings-row-label {
                    font-size: 13px;
                    font-weight: 500;
                    color: var(--orion-header-primary);
                }
                #orion-ui .settings-num-input {
                    width: 56px;
                    height: 26px;
                    background: var(--orion-bg-tertiary);
                    color: var(--orion-header-primary);
                    border: 1px solid var(--orion-border);
                    border-radius: 3px;
                    padding: 0 6px;
                    text-align: center;
                    font-size: 13px;
                    font-weight: 500;
                    font-family: inherit;
                }
                #orion-ui .settings-num-input:focus {
                    outline: none;
                    border-color: var(--orion-brand);
                }
                #orion-ui .settings-hint {
                    margin-top: 6px;
                    padding-top: 8px;
                    border-top: 1px solid var(--orion-border);
                    color: var(--orion-text-muted);
                    font-size: 12px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                #orion-ui .orion-kbd {
                    background: var(--orion-bg-tertiary);
                    border: 1px solid var(--orion-border);
                    box-shadow: inset 0 -1px 0 rgba(0, 0, 0, 0.4);
                    padding: 1px 5px;
                    border-radius: 3px;
                    font-family: var(--orion-mono);
                    font-size: 11px;
                    color: var(--orion-header-primary);
                }

                /* Body & Scrollbars */
                #orion-body {
                    flex: 1 1 auto;
                    padding: 10px 12px;
                    min-height: 0;
                    overflow-y: auto;
                    display: flex;
                    flex-direction: column;
                }
                #orion-picker-form {
                    display: flex;
                    flex-direction: column;
                    min-height: 0;
                    flex: 1 1 auto;
                }

                #orion-ui ::-webkit-scrollbar {
                    width: 6px;
                    height: 6px;
                }
                #orion-ui ::-webkit-scrollbar-track {
                    background: transparent;
                }
                #orion-ui ::-webkit-scrollbar-thumb {
                    background: var(--scrollbar-thin-thumb, #1a1b1e);
                    border-radius: 3px;
                }

                /* Active Task Rows */
                #orion-ui .task-card {
                    --state-color: var(--orion-brand);
                    position: relative;
                    display: flex;
                    gap: 10px;
                    padding: 8px 10px 11px;
                    margin-bottom: 6px;
                    align-items: center;
                    background: var(--orion-bg-secondary-alt);
                    border-radius: 4px;
                    border: 1px solid var(--orion-border);
                    flex-shrink: 0;
                    overflow: hidden;
                }
                #orion-ui .task-card:last-child {
                    margin-bottom: 0;
                }
                #orion-ui .task-card.removing {
                    opacity: 0;
                    transition: opacity 0.2s ease;
                }
                #orion-ui .task-card.done {
                    --state-color: var(--orion-green);
                }
                #orion-ui .task-card.failed {
                    --state-color: var(--orion-red);
                }
                #orion-ui .task-card.pending {
                    --state-color: var(--orion-yellow);
                }

                #orion-ui .task-bar-track {
                    position: absolute;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    height: 3px;
                    background: var(--orion-bg-tertiary);
                }
                #orion-ui .task-bar-fill {
                    height: 100%;
                    width: var(--p, 0%);
                    background: var(--state-color);
                    transition: width 0.25s linear;
                }

                #orion-ui .task-icon {
                    position: relative;
                    width: 32px;
                    height: 32px;
                    border-radius: 4px;
                    flex: 0 0 32px;
                    background: var(--orion-bg-tertiary);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                #orion-ui .task-icon-inner {
                    color: var(--state-color);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                #orion-ui .task-card.running:hover .task-icon-inner {
                    opacity: 0.15;
                }
                #orion-ui .task-icon-overlay {
                    position: absolute;
                    inset: 0;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 10px;
                    font-weight: 600;
                    color: var(--orion-header-primary);
                    opacity: 0;
                    pointer-events: none;
                }
                #orion-ui .task-card.running:hover .task-icon-overlay {
                    opacity: 1;
                }

                #orion-ui .task-info {
                    flex: 1 1 auto;
                    min-width: 0;
                    display: flex;
                    flex-direction: column;
                    gap: 2px;
                    justify-content: center;
                }
                #orion-ui .task-top-line {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                }
                #orion-ui .task-status {
                    font-size: 11px;
                    font-weight: 600;
                    color: var(--state-color);
                }
                #orion-ui .task-type-chip {
                    font-size: 11px;
                    font-weight: 500;
                    color: var(--orion-text-muted);
                }
                #orion-ui .task-name {
                    font-size: 13px;
                    font-weight: 500;
                    color: var(--orion-header-primary);
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                #orion-ui .task-meta {
                    font-size: 12px;
                    font-weight: 400;
                    color: var(--orion-text-muted);
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                #orion-ui .task-actions {
                    flex: 0 0 auto;
                    display: flex;
                    align-items: center;
                    margin-left: 4px;
                }

                #orion-ui .claim-btn,
                #orion-ui .goto-btn {
                    height: 28px;
                    padding: 0 10px;
                    border: none;
                    border-radius: 3px;
                    font-size: 12px;
                    font-weight: 500;
                    cursor: pointer;
                    white-space: nowrap;
                    font-family: inherit;
                    color: #ffffff;
                    transition: background-color 0.1s ease;
                }
                #orion-ui .claim-btn {
                    background: var(--orion-green);
                }
                #orion-ui .claim-btn:hover:not(:disabled) {
                    background: var(--orion-green-hover);
                }
                #orion-ui .claim-btn:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }
                #orion-ui .goto-btn {
                    background: var(--orion-btn-secondary);
                }
                #orion-ui .goto-btn:hover:not(:disabled) {
                    background: var(--orion-btn-secondary-hover);
                }

                /* Quest Picker */
                #orion-ui .picker-filters-wrap {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                    margin-bottom: 8px;
                    padding-bottom: 8px;
                    border-bottom: 1px solid var(--orion-border);
                    flex-shrink: 0;
                }
                #orion-ui .picker-section-title {
                    font-size: 12px;
                    font-weight: 600;
                    color: var(--orion-header-secondary);
                    margin-bottom: 4px;
                    flex-shrink: 0;
                }
                #orion-ui .reward-filters {
                    display: flex;
                    gap: 4px;
                    flex-wrap: wrap;
                    flex-shrink: 0;
                }
                #orion-ui .reward-filter,
                #orion-ui .type-filter {
                    background: var(--orion-mod-selected);
                    border: 1px solid var(--orion-border);
                    height: 24px;
                    padding: 0 8px;
                    border-radius: 4px;
                    font-size: 12px;
                    font-weight: 500;
                    cursor: pointer;
                    color: var(--orion-header-primary);
                    font-family: inherit;
                    display: inline-flex;
                    align-items: center;
                    gap: 5px;
                    transition: background-color 0.1s ease, opacity 0.1s ease;
                }
                #orion-ui .reward-filter:hover,
                #orion-ui .type-filter:hover {
                    background: var(--orion-mod-active);
                }
                #orion-ui .reward-filter.off,
                #orion-ui .type-filter.off {
                    background: var(--orion-bg-tertiary);
                    color: var(--orion-text-muted);
                    opacity: 0.55;
                }
                #orion-ui .reward-dot {
                    width: 6px;
                    height: 6px;
                    border-radius: 50%;
                    flex-shrink: 0;
                }

                #orion-ui .picker-quest-list {
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                    flex: 1 1 auto;
                    min-height: 80px;
                    overflow-y: auto;
                    padding-right: 2px;
                }
                #orion-ui .quest-pick {
                    display: flex;
                    gap: 10px;
                    padding: 7px 10px;
                    background: var(--orion-bg-secondary-alt);
                    border-radius: 4px;
                    border: 1px solid var(--orion-border);
                    cursor: pointer;
                    align-items: center;
                    user-select: none;
                    flex-shrink: 0;
                    transition: background-color 0.1s ease;
                }
                #orion-ui .quest-pick:hover {
                    background: var(--orion-mod-hover);
                }
                #orion-ui .quest-pick.hidden {
                    display: none !important;
                }

                #orion-ui .native-cb,
                #orion-consent .native-cb {
                    appearance: none;
                    width: 18px;
                    height: 18px;
                    margin: 0;
                    flex-shrink: 0;
                    border: 1px solid var(--orion-interactive-normal);
                    border-radius: 3px;
                    background: transparent;
                    cursor: pointer;
                    display: grid;
                    place-content: center;
                }
                #orion-ui .native-cb::before,
                #orion-consent .native-cb::before {
                    content: '';
                    width: 12px;
                    height: 12px;
                    opacity: 0;
                    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='20 6 9 17 4 12'%3E%3C/polyline%3E%3C/svg%3E");
                    background-size: contain;
                    background-repeat: no-repeat;
                    background-position: center;
                }
                #orion-ui .native-cb:checked,
                #orion-consent .native-cb:checked {
                    background: var(--orion-brand);
                    border-color: var(--orion-brand);
                }
                #orion-ui .native-cb:checked::before,
                #orion-consent .native-cb:checked::before {
                    opacity: 1;
                }

                #orion-ui .native-toggle {
                    appearance: none;
                    width: 36px;
                    height: 20px;
                    margin: 0;
                    flex-shrink: 0;
                    background: #80848e;
                    border-radius: 10px;
                    cursor: pointer;
                    position: relative;
                    transition: background-color 0.15s ease;
                    border: none;
                }
                #orion-ui .native-toggle::after {
                    content: '';
                    position: absolute;
                    top: 3px;
                    left: 3px;
                    width: 14px;
                    height: 14px;
                    background: #ffffff;
                    border-radius: 50%;
                    transition: transform 0.15s ease;
                }
                #orion-ui .native-toggle:checked {
                    background: var(--orion-green);
                }
                #orion-ui .native-toggle:checked::after {
                    transform: translateX(16px);
                }

                #orion-ui .orb-total {
                    display: none;
                    margin-top: 8px;
                    padding: 6px 8px;
                    background: var(--orion-bg-tertiary);
                    border-radius: 4px;
                    font-size: 12px;
                    font-weight: 500;
                    color: var(--orion-text-normal);
                    text-align: center;
                    flex-shrink: 0;
                }
                #orion-ui .picker-actions {
                    display: flex;
                    gap: 8px;
                    padding-top: 8px;
                    flex-shrink: 0;
                }
                #orion-ui .quest-pick-btn,
                #orion-consent .quest-pick-btn {
                    flex: 1;
                    height: 32px;
                    padding: 0 12px;
                    border: none;
                    border-radius: 3px;
                    font-size: 13px;
                    font-weight: 500;
                    cursor: pointer;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    gap: 6px;
                    font-family: inherit;
                    color: #ffffff;
                    transition: background-color 0.1s ease;
                }
                #orion-ui .quest-pick-btn.start,
                #orion-consent .quest-pick-btn.start {
                    background: var(--orion-brand);
                }
                #orion-ui .quest-pick-btn.start:hover:not(:disabled),
                #orion-consent .quest-pick-btn.start:hover:not(:disabled) {
                    background: var(--orion-brand-hover);
                }
                #orion-ui .quest-pick-btn.deselect,
                #orion-consent .quest-pick-btn.deselect {
                    background: var(--orion-btn-secondary);
                    color: var(--orion-header-primary);
                }
                #orion-ui .quest-pick-btn.deselect:hover:not(:disabled),
                #orion-consent .quest-pick-btn.deselect:hover:not(:disabled) {
                    background: var(--orion-btn-secondary-hover);
                }
                #orion-ui .quest-pick-btn:disabled,
                #orion-consent .quest-pick-btn:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }

                /* Console Output */
                #orion-logs-wrap {
                    flex: 0 0 auto;
                    display: flex;
                    flex-direction: column;
                    border-top: 1px solid var(--orion-border);
                    background: var(--orion-bg-tertiary);
                }
                #orion-logs-wrap.collapsed #orion-logs {
                    display: none;
                }
                #orion-logs-head {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    height: 26px;
                    padding: 0 12px;
                    font-size: 11px;
                    font-weight: 600;
                    color: var(--orion-header-secondary);
                    border-bottom: 1px solid var(--orion-border);
                }
                #orion-ui .logs-clear-btn {
                    cursor: pointer;
                    color: var(--orion-text-muted);
                    font-size: 11px;
                    font-weight: 500;
                    padding: 1px 4px;
                    border-radius: 3px;
                }
                #orion-ui .logs-clear-btn:hover {
                    color: var(--orion-header-primary);
                    background: var(--orion-mod-hover);
                }
                #orion-logs {
                    padding: 6px 12px;
                    font-family: var(--orion-mono);
                    font-size: 11px;
                    height: 100px;
                    overflow-y: auto;
                    scroll-behavior: smooth;
                }
                #orion-ui .log-item {
                    margin-bottom: 3px;
                    display: flex;
                    gap: 8px;
                    line-height: 1.35;
                }
                #orion-ui .log-ts {
                    color: var(--orion-text-muted);
                    min-width: 50px;
                    font-size: 10px;
                    user-select: text;
                    flex-shrink: 0;
                }
                #orion-ui .log-msg {
                    word-break: break-word;
                    user-select: text;
                }
                #orion-ui .c-info { color: var(--orion-text-normal); }
                #orion-ui .c-success { color: var(--orion-green); }
                #orion-ui .c-err { color: var(--orion-red); }
                #orion-ui .c-warn { color: var(--orion-yellow); }
                #orion-ui .c-debug { color: var(--orion-text-muted); }

                /* Floating Launcher Control */
                #orion-unhide-pill {
                    position: fixed;
                    bottom: 20px;
                    right: 20px;
                    height: 32px;
                    padding: 0 12px;
                    border-radius: 4px;
                    background: var(--orion-bg-floating);
                    color: var(--orion-header-primary);
                    border: 1px solid var(--orion-border);
                    box-shadow: var(--elevation-high, 0 8px 16px rgba(0, 0, 0, 0.24));
                    font-family: var(--orion-font);
                    font-size: 12px;
                    font-weight: 500;
                    cursor: pointer;
                    z-index: 10000;
                    display: none;
                    align-items: center;
                    gap: 6px;
                    user-select: none;
                }
                #orion-unhide-pill:hover {
                    background: var(--orion-bg-secondary-alt);
                }
                #orion-unhide-pill svg {
                    color: var(--orion-brand);
                }

                #orion-consent {
                    position: fixed;
                    inset: 0;
                    z-index: 1002;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: rgba(0, 0, 0, 0.7);
                    font-family: var(--orion-font);
                }
                #orion-consent .orion-modal {
                    width: 440px;
                    max-width: 92vw;
                    background: var(--orion-bg-primary);
                    border: 1px solid var(--orion-border);
                    border-radius: 4px;
                    box-shadow: var(--elevation-high, 0 8px 16px rgba(0, 0, 0, 0.24));
                    color: var(--orion-text-normal);
                    overflow: hidden;
                }
                #orion-consent .orion-modal-head {
                    padding: 16px 16px 0;
                }
                #orion-consent .orion-modal-title {
                    font-weight: 600;
                    font-size: 18px;
                    line-height: 22px;
                    color: var(--orion-header-primary);
                }
                #orion-consent .orion-modal-subtitle {
                    font-size: 12px;
                    color: var(--orion-text-muted);
                    margin-top: 2px;
                }
                #orion-consent .orion-modal-body {
                    padding: 12px 16px 16px;
                    font-size: 13px;
                    line-height: 1.45;
                }
                #orion-consent .orion-modal-desc {
                    margin: 0 0 8px;
                    color: var(--orion-text-normal);
                }
                #orion-consent .orion-modal-app {
                    font-weight: 600;
                    font-size: 13px;
                    color: var(--orion-header-primary);
                    margin-bottom: 12px;
                    padding: 8px 10px;
                    border-radius: 4px;
                    background: var(--orion-bg-secondary);
                    border: 1px solid var(--orion-border);
                }
                #orion-consent .orion-modal-label {
                    font-size: 12px;
                    font-weight: 600;
                    color: var(--orion-header-secondary);
                    margin-bottom: 6px;
                }
                #orion-consent .orion-scope-list {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 4px;
                    margin-bottom: 12px;
                }
                #orion-consent .orion-scope-chip {
                    font-family: var(--orion-mono);
                    font-size: 11px;
                    color: var(--orion-text-normal);
                    background: var(--orion-bg-tertiary);
                    padding: 2px 6px;
                    border-radius: 3px;
                }
                #orion-consent .orion-modal-warn {
                    padding: 8px 10px;
                    border-radius: 4px;
                    background: rgba(240, 178, 50, 0.1);
                    border: 1px solid rgba(240, 178, 50, 0.3);
                    color: var(--orion-text-normal);
                    font-size: 12px;
                    line-height: 1.4;
                }
                #orion-consent .orion-modal-remember {
                    display: flex;
                    gap: 8px;
                    align-items: center;
                    margin-top: 12px;
                    font-size: 12px;
                    color: var(--orion-text-normal);
                    cursor: pointer;
                }
                #orion-consent .orion-modal-foot {
                    display: flex;
                    justify-content: flex-end;
                    gap: 8px;
                    padding: 12px 16px;
                    background: var(--orion-bg-secondary);
                    border-top: 1px solid var(--orion-border);
                }
                #orion-consent .orion-modal-foot .quest-pick-btn {
                    flex: 0 0 auto;
                    min-width: 84px;
                }
            `;
            document.head.appendChild(style);

            this.root = document.createElement('div');
            this.root.id = 'orion-ui';
            this.root.innerHTML = `
                <div id="orion-head">
                    <div id="orion-brand">
                        <div class="orion-logo-badge">${ICONS.BOLT}</div>
                        <div id="orion-title-wrap">
                            <span id="orion-title">${CONFIG.NAME}</span>
                        </div>
                    </div>
                    <div id="orion-controls">
                        <button type="button" class="ctrl-btn icon-only" id="orion-goto-quests" title="Open Quests Home">${ICONS.COMPASS}</button>
                        <button type="button" class="ctrl-btn icon-only active" id="orion-toggle-logs" title="Toggle Console">${ICONS.TERM}</button>
                        <button type="button" class="ctrl-btn icon-only" id="orion-opts" title="Settings">${ICONS.OPT}</button>
                        <button type="button" class="ctrl-btn icon-only ctrl-hide" id="orion-close" title="Hide (Shift + .)">${ICONS.MINIMIZE}</button>
                        <button type="button" class="ctrl-btn ctrl-stop" id="orion-stop" title="Stop Script">${ICONS.STOP} Stop</button>
                    </div>
                </div>
                <div id="orion-settings-drawer">
                    <div class="settings-head">
                        <span>Settings</span>
                        <span class="settings-close" id="orion-close-settings">Done</span>
                    </div>
                    <div class="settings-grid">
                        <label class="settings-row">
                            <span class="settings-row-label">Run games in parallel</span>
                            <input type="checkbox" class="native-toggle" id="set-parallel" ${RUNTIME.parallelGames ? 'checked' : ''}>
                        </label>
                        <label class="settings-row">
                            <span class="settings-row-label">Max parallel games</span>
                            <input type="number" class="settings-num-input" id="set-concurrency" min="1" max="30" value="${CONFIG.GAME_CONCURRENCY || 15}">
                        </label>
                        <label class="settings-row">
                            <span class="settings-row-label">Auto-enroll in quests</span>
                            <input type="checkbox" class="native-toggle" id="set-enroll" ${RUNTIME.autoEnroll ? 'checked' : ''}>
                        </label>
                        <label class="settings-row">
                            <span class="settings-row-label">Auto-claim rewards</span>
                            <input type="checkbox" class="native-toggle" id="set-claim" ${RUNTIME.autoClaim ? 'checked' : ''}>
                        </label>
                        <label class="settings-row">
                            <span class="settings-row-label">Hide game activity status</span>
                            <input type="checkbox" class="native-toggle" id="set-hide-activity" ${CONFIG.HIDE_ACTIVITY ? 'checked' : ''}>
                        </label>
                        <label class="settings-row">
                            <span class="settings-row-label">Sound on completion</span>
                            <input type="checkbox" class="native-toggle" id="set-sound" ${RUNTIME.playSound ? 'checked' : ''}>
                        </label>
                        <label class="settings-row">
                            <span class="settings-row-label">Random 1–30m cycle delay</span>
                            <input type="checkbox" class="native-toggle" id="set-delay" ${RUNTIME.randomDelay ? 'checked' : ''}>
                        </label>
                    </div>
                    <div class="settings-hint">
                        <span>Toggle window visibility</span>
                        <span><kbd class="orion-kbd">Shift</kbd> + <kbd class="orion-kbd">.</kbd></span>
                    </div>
                </div>
                <div id="orion-body"><div style="text-align:center; padding:28px 16px; color:var(--orion-text-muted); font-size:13px;">Initializing...</div></div>
                <div id="orion-logs-wrap">
                    <div id="orion-logs-head">
                        <span>Console</span>
                        <span class="logs-clear-btn" id="orion-clear-logs">Clear</span>
                    </div>
                    <div id="orion-logs"></div>
                </div>
            `;
            document.body.appendChild(this.root);

            const oldPill = document.getElementById('orion-unhide-pill'); if (oldPill) oldPill.remove();
            this.pill = document.createElement('div');
            this.pill.id = 'orion-unhide-pill';
            this.pill.innerHTML = `${ICONS.BOLT} <span>Orion</span>`;
            this.pill.onclick = () => this.toggle();
            document.body.appendChild(this.pill);

            window.Orion = {
                toggle: () => this.toggle(),
                show: () => { if (this.root?.style.display === 'none') this.toggle(); },
                hide: () => { if (this.root?.style.display !== 'none') this.toggle(); }
            };

            const head = document.getElementById('orion-head');
            let collapsed = false;
            head.addEventListener('dblclick', e => {
                if (e.target.closest('.ctrl-btn')) return;
                collapsed = !collapsed;
                this.root.style.height = collapsed ? '44px' : '';
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
                    this.root.style.top = `${Math.max(0, Math.min(initialTop + (ev.clientY - startY), window.innerHeight - 44))}px`;
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

                    btn.innerText = "Claiming...";
                    btn.disabled = true;

                    this.updateTask(questId, { ...taskData, claimState: 'WAITING' });

                    try {
                        const claimRes = await Tasks.claimReward(questId);

                        if (claimRes?.body?.claimed_at) {
                            btn.innerText = "Claimed";
                            this.log(`[Claim] Reward for "${taskData.name}" claimed successfully!`, 'success');
                            this.updateTask(questId, { ...taskData, status: "CLAIMED", claimable: false, claimState: null });
                            setTimeout(() => this.removeTask(questId), 2000);
                        } else {
                            this.log(`[Claim] Reward for "${taskData.name}" wasn't confirmed. Claim it from Discord's Quests page.`, 'warn');
                            this.updateTask(questId, { ...taskData, claimState: 'FAILED' });
                        }
                    } catch (err) {
                        this.log(`[Claim] Discord requires verification for "${taskData.name}". Open Quests in Discord to claim your reward.`, 'warn');
                        this.updateTask(questId, { ...taskData, claimState: 'FAILED' });
                    }
                }
            });

            document.getElementById('orion-goto-quests')?.addEventListener('click', () => {
                if (Mods.Router?.transitionTo) Mods.Router.transitionTo('/quest-home');
                else window.location.hash = '/quest-home';
            });
            document.getElementById('orion-close').onclick = () => this.toggle();
            document.getElementById('orion-stop').onclick = () => this.shutdown();

            const logsBtn = document.getElementById('orion-toggle-logs');
            const logsWrap = document.getElementById('orion-logs-wrap');
            logsBtn?.addEventListener('click', () => {
                this.logsOpen = !this.logsOpen;
                logsBtn.classList.toggle('active', this.logsOpen);
                if (logsWrap) logsWrap.style.display = this.logsOpen ? 'flex' : 'none';
            });
            document.getElementById('orion-clear-logs')?.addEventListener('click', () => {
                const box = document.getElementById('orion-logs');
                if (box) box.innerHTML = '';
            });

            this._hotkey = e => (e.key === '>' || (e.shiftKey && e.key === '.')) && this.toggle();
            document.addEventListener('keydown', this._hotkey);

            const optsBtn = document.getElementById('orion-opts');
            const toggleSettings = () => {
                const drawer = document.getElementById('orion-settings-drawer');
                if (drawer) {
                    const open = drawer.style.display === 'none' || !drawer.style.display;
                    drawer.style.display = open ? 'block' : 'none';
                    optsBtn?.classList.toggle('active', open);
                }
            };
            optsBtn?.addEventListener('click', toggleSettings);
            document.getElementById('orion-close-settings')?.addEventListener('click', toggleSettings);

            document.getElementById('set-parallel')?.addEventListener('change', e => {
                RUNTIME.parallelGames = e.target.checked;
            });
            document.getElementById('set-concurrency')?.addEventListener('change', e => {
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val) && val >= 1) CONFIG.GAME_CONCURRENCY = val;
            });
            document.getElementById('set-enroll')?.addEventListener('change', e => {
                RUNTIME.autoEnroll = e.target.checked;
            });
            document.getElementById('set-claim')?.addEventListener('change', e => {
                RUNTIME.autoClaim = e.target.checked;
            });
            document.getElementById('set-hide-activity')?.addEventListener('change', e => {
                CONFIG.HIDE_ACTIVITY = e.target.checked;
                Patcher.syncPresenceSuppression();
            });
            document.getElementById('set-sound')?.addEventListener('change', e => {
                RUNTIME.playSound = e.target.checked;
            });
            document.getElementById('set-delay')?.addEventListener('change', e => {
                RUNTIME.randomDelay = e.target.checked;
            });

            this.startTicker();
        },

        toggle() {
            if (!this.root?.parentElement) return;
            const isHidden = this.root.style.display === 'none';
            this.root.style.display = isHidden ? 'flex' : 'none';
            if (this.pill) {
                this.pill.style.display = isHidden ? 'none' : 'flex';
            }
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
            window.orionLock = false;

            if (this.pill?.parentElement) this.pill.remove();
            delete window.Orion;
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

        SERVER_DRIVEN: ["GAME", "STREAM"],

        startTicker() {
            if (this.tickerId) clearInterval(this.tickerId);
            this.tickerId = setInterval(() => {
                if (!RUNTIME.running) return clearInterval(this.tickerId);
                for (const [id, task] of this.tasks.entries()) {
                    if (task.status !== "RUNNING" || task.type === "ACHIEVEMENT") continue;

                    let cur;
                    if (this.SERVER_DRIVEN.includes(task.type)) {
                        if (task.serverAt == null) continue;
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
                const card = document.getElementById(`orion-task-${esc(id)}`);
                if (card) {
                    const pct = this._getPct(newData);

                    card.style.setProperty('--p', `${pct}%`);
                    const iconContainer = card.querySelector('.task-icon');
                    if (iconContainer) iconContainer.style.setProperty('--p', `${pct}%`);

                    const overlay = card.querySelector('.task-icon-overlay');
                    if (overlay) overlay.textContent = `${Math.floor(pct)}%`;

                    const progressText = card.querySelector('.progress-text');
                    if (progressText) {
                        const unit = newData.type === 'ACHIEVEMENT' ? '' : 's';
                        progressText.textContent = `${Math.min(Math.floor(newData.cur), newData.max)} / ${newData.max}${unit} (${Math.floor(pct)}%)`;
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
            const colors = { info: "#5865F2", success: "#23a55a", warn: "#f0b232", err: "#f23f43", debug: "#999" };
            console.log(`%c[ORION] %c${msg}`, `color: ${CONFIG.THEME}; font-weight: bold;`, `color: ${colors[type] || colors.info}`);
            try {
                const box = document.getElementById('orion-logs');
                if (box && type !== 'debug') {
                    const el = document.createElement('div'); el.className = `log-item c-${type}`;
                    el.innerHTML = `<span class="log-ts">${new Date().toLocaleTimeString().split(' ')[0]}</span> <span class="log-msg">${esc(msg)}</span>`;
                    box.appendChild(el); box.scrollTop = box.scrollHeight;
                    while (box.children.length > CONFIG.MAX_LOG_ITEMS) box.firstChild.remove();
                }
            } catch (e) { console.debug('[Logger] DOM error:', e.message); }
        },

        render() {
            if (document.getElementById('orion-picker-form')) return;
            const body = document.getElementById('orion-body');
            if (!body) return;
            if (!this.tasks.size) return body.innerHTML = `<div style="text-align:center; padding:28px 16px; color:var(--orion-text-muted); font-size:13px;">Waiting for tasks...</div>`;

            const sorted = [...this.tasks.entries()].sort((a, b) => {
                const ta = a[1], tb = b[1];
                if (ta.done !== tb.done) return ta.done ? 1 : -1;
                if (ta.failed !== tb.failed) return ta.failed ? 1 : -1;
                if (ta.pending !== tb.pending) return ta.pending ? 1 : -1;
                if (!ta.done && !ta.pending && !tb.done && !tb.pending) {
                    const pctA = ta.max ? ta.cur / ta.max : 0;
                    const pctB = tb.max ? tb.cur / tb.max : 0;
                    return pctB - pctA;
                }
                return 0;
            });

            body.innerHTML = sorted.map(([id, t]) => {
                const pctNum = t.pending || t.failed ? 0 : Math.min(100, (t.cur / t.max) * 100);
                const pct = pctNum.toFixed(1);
                const icon =
                    t.done ? ICONS.CHECK :
                    t.failed ? ICONS.STOP :
                    t.pending ? ICONS.CLOCK :
                    t.type === 'VIDEO' ? ICONS.VIDEO :
                    t.type === 'ACHIEVEMENT' ? ICONS.ACTIVITY :
                    t.type?.includes('GAME') ? ICONS.GAME :
                    t.type?.includes('STREAM') ? ICONS.STREAM :
                    ICONS.BOLT;

                let statusText =
                    t.status === 'CLAIMED' ? 'Claimed' :
                    t.done ? 'Completed' :
                    t.status === 'RUNNING' ? 'Running' :
                    t.status === 'QUEUE' ? 'Queued' :
                    t.status === 'PENDING' ? 'Pending' :
                    t.status === 'FAILED' ? 'Failed' :
                    t.status;
                let progressLabel = t.pending ? 'Waiting in queue' : t.failed ? 'Aborted' : 'Progress';
                const unit = t.type === 'ACHIEVEMENT' ? '' : 's';

                let actionBtn = '';

                if (t.claimable) {
                    if (t.claimState === 'WAITING') actionBtn = `<button type="button" class="claim-btn" disabled>Claiming...</button>`;
                    else if (t.claimState === 'FAILED') actionBtn = `<button type="button" class="goto-btn">Open Quests</button>`;
                    else actionBtn = `<button type="button" class="claim-btn" data-id="${esc(id)}">Claim Reward</button>`;
                } else if (t.actionRequired === 'ENROLL') {
                    statusText = 'Action Required'; progressLabel = 'Accept quest in Discord';
                    actionBtn = `<button type="button" class="goto-btn">Open Quests</button>`;
                } else if (t.type === 'ACHIEVEMENT' && t.status === 'RUNNING') {
                    statusText = 'Authenticating'; progressLabel = 'Running activity bypass';
                    actionBtn = `<button type="button" class="goto-btn">Open Quests</button>`;
                }

                const stateClass = t.done ? 'done' : t.failed ? 'failed' : t.pending ? 'pending' : 'running';
                const removingClass = t.removing ? 'removing' : '';

                let taskMetaHtml = '';
                if (!t.done) {
                    taskMetaHtml = `
                    <div class="task-meta">
                        <span>${progressLabel}</span>
                        ${actionBtn ? '' : `<span class="progress-text">${Math.min(Math.floor(t.cur), t.max)} / ${t.max}${unit} (${Math.floor(pctNum)}%)</span>`}
                    </div>`;
                }

                return `
                <div id="orion-task-${esc(id)}" class="task-card ${stateClass} ${removingClass}" style="--p: ${pct}%">
                    <div class="task-icon" style="--p: ${pct}%">
                        <div class="task-icon-inner">${icon}</div>
                        ${stateClass === 'running' ? `<div class="task-icon-overlay">${Math.floor(pctNum)}%</div>` : ''}
                    </div>
                    <div class="task-info">
                        <div class="task-top-line">
                            <span class="task-status">${statusText}</span>
                            ${t.type ? `<span class="task-type-chip">· ${esc(t.type)}</span>` : ''}
                        </div>
                        <div class="task-name" title="${esc(t.name)}">${esc(t.name)}</div>
                        ${taskMetaHtml}
                    </div>
                    ${actionBtn ? `<div class="task-actions">${actionBtn}</div>` : ''}
                    <div class="task-bar-track"><div class="task-bar-fill"></div></div>
                </div>`;
            }).join('');
        },

        showQuestPicker(quests) {
            return new Promise((resolve) => {
                const body = document.getElementById('orion-body');
                const logsWrap = document.getElementById('orion-logs-wrap');

                const closePicker = (data) => {
                    if (logsWrap) logsWrap.style.display = this.logsOpen ? 'flex' : 'none';
                    if (body) { body.classList.remove('picker-mode'); body.innerHTML = ''; }
                    resolve(data);
                };

                if (!body) return closePicker({ selectedQuests: new Set(), autoEnroll: RUNTIME.autoEnroll, autoClaim: RUNTIME.autoClaim, playSound: RUNTIME.playSound, randomDelay: RUNTIME.randomDelay, parallelGames: RUNTIME.parallelGames });
                if (logsWrap) logsWrap.style.display = 'none';

                const items = [];
                const rewardTypes = new Map();
                const questTypes = new Set();
                const boosted = canUseMoreQuestOrbs();

                const REWARD_META = { 1: { label: "In-Game", color: "#e67e22" }, 3: { label: "Decoration", color: "#9b59b6" }, 4: { label: "Orbs", color: "#5865f2" } };
                const REWARD_FALLBACK = { label: "Other", color: "#949ba4" };

                quests.forEach(q => {
                    const cfg = selectTaskConfig(q.config);
                    if (!cfg?.tasks) return;

                    const typeData = Tasks.detectType(cfg, q.config?.application?.id);
                    if (!typeData) return;
                    if (!SYS.IS_DESKTOP && (typeData.type === 'GAME' || typeData.type === 'STREAM')) return;

                    const rw = q.config?.rewardsConfig?.rewards?.[0];
                    const orbs = orbReward(q.config);
                    const rewardType = orbs ? 4 : (rw?.type ?? 0);
                    const rewardText = rw?.messages?.name ?? "Unknown Reward";
                    const meta = REWARD_META[rewardType] ?? REWARD_FALLBACK;
                    const displayType = typeData.type === 'WATCH_VIDEO' ? 'VIDEO' : typeData.type;
                    questTypes.add(displayType);

                    if (!rewardTypes.has(rewardType)) {
                        rewardTypes.set(rewardType, { label: meta.label, count: 0, type: rewardType, color: meta.color });
                    }
                    rewardTypes.get(rewardType).count++;

                    items.push({
                        id: q.id,
                        name: q.config?.messages?.questName ?? "Unknown Quest",
                        type: displayType,
                        rewardType,
                        rewardText,
                        orbs: orbPayout(orbs, boosted),
                        orbText: fmtOrbs(orbs, boosted),
                        color: meta.color
                    });
                });

                if (!items.length) return closePicker({ selectedQuests: new Set(), autoEnroll: RUNTIME.autoEnroll, autoClaim: RUNTIME.autoClaim, playSound: RUNTIME.playSound, randomDelay: RUNTIME.randomDelay, parallelGames: RUNTIME.parallelGames });

                const buildCard = (q) => `
                    <label class="quest-pick" data-rt="${q.rewardType}" data-qt="${q.type}" data-orbs="${q.orbs}">
                        <input type="checkbox" name="quests" value="${q.id}" class="native-cb" checked>
                        <div class="task-info">
                            <div class="task-name" title="${esc(q.name)}">${esc(q.name)}</div>
                            <div class="task-meta" style="justify-content: flex-start; gap: 6px;">
                                <span class="reward-dot" style="background: ${q.color};"></span>
                                <span>${esc(q.orbText || q.rewardText)}</span>
                                <span>·</span>
                                <span class="task-type-chip">${esc(q.type)}</span>
                            </div>
                        </div>
                    </label>`;

                const hasFilters = rewardTypes.size > 1 || questTypes.size > 1;

                body.innerHTML = `
                    <form id="orion-picker-form">
                        ${hasFilters ? `
                        <div class="picker-filters-wrap">
                            ${rewardTypes.size > 1 ? `
                                <div>
                                    <div class="picker-section-title">Reward Type</div>
                                    <div class="reward-filters">
                                        ${[...rewardTypes.values()].map(rt => `<button type="button" class="reward-filter" data-rt="${rt.type}"><span class="reward-dot" style="background:${rt.color};"></span>${rt.label} (${rt.count})</button>`).join('')}
                                    </div>
                                </div>
                            ` : ''}
                            ${questTypes.size > 1 ? `
                                <div>
                                    <div class="picker-section-title">Task Type</div>
                                    <div class="reward-filters">
                                        ${[...questTypes].map(t => `<button type="button" class="type-filter" data-qt="${t}">${t}</button>`).join('')}
                                    </div>
                                </div>
                            ` : ''}
                        </div>
                        ` : ''}

                        <div id="orion-quest-list" class="picker-quest-list">${items.map(buildCard).join('')}
                            <div id="orion-no-quests" style="display: none; margin: auto; padding: 24px 0; text-align: center; color: var(--orion-text-muted); font-size: 13px;">
                                No matching quests
                            </div>
                        </div>

                        <div id="orion-orb-total" class="orb-total"></div>

                        <div class="picker-actions">
                            <button type="button" class="quest-pick-btn deselect" id="select-all-btn">Deselect All</button>
                            <button type="submit" class="quest-pick-btn start" id="start-btn"><span id="start-btn-text">Start (${items.length})</span></button>
                        </div>
                    </form>`;

                const form = document.getElementById('orion-picker-form');
                const selectAllBtn = document.getElementById('select-all-btn');
                const startBtn = document.getElementById('start-btn');

                const getVisibleCheckboxes = () => Array.from(form.querySelectorAll('.quest-pick input[type="checkbox"]'))
                    .filter(cb => !cb.closest('.quest-pick').classList.contains('hidden'));

                let balanceText = '';

                const syncUI = () => {
                    const visibleCbs = getVisibleCheckboxes();
                    const totalChecked = visibleCbs.filter(cb => cb.checked).length;

                    const orbTotal = document.getElementById('orion-orb-total');
                    if (orbTotal) {
                        const picked = visibleCbs.filter(cb => cb.checked).map(cb => cb.closest('.quest-pick'));
                        const orbs = picked.reduce((total, el) => total + (Number(el?.getAttribute('data-orbs')) || 0), 0);
                        const selectedText = orbs > 0 ? `${orbs} Orbs selected` : '';
                        const text = [selectedText, balanceText].filter(Boolean).join(' · ');
                        orbTotal.textContent = text;
                        orbTotal.style.display = text ? 'block' : 'none';
                    }

                    const startBtnText = document.getElementById('start-btn-text');
                    if (startBtnText) startBtnText.textContent = `Start (${totalChecked})`;
                    startBtn.disabled = totalChecked === 0;

                    if (visibleCbs.length === 0) {
                        selectAllBtn.disabled = true;
                        selectAllBtn.textContent = 'Select All';
                    } else {
                        selectAllBtn.disabled = false;
                        selectAllBtn.textContent = visibleCbs.every(cb => cb.checked) ? 'Deselect All' : 'Select All';
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
                    const btn = e.target.closest('.reward-filter, .type-filter');
                    if (btn) {
                        e.preventDefault();
                        const kind = FILTER_KINDS.find(k => btn.classList.contains(k.cls));
                        if (kind) {
                            const value = btn.getAttribute(kind.attr);
                            btn.classList.toggle('off');
                            if (btn.classList.contains('off')) kind.set.delete(value);
                            else kind.set.add(value);
                            applyFilters();
                        }
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

                    closePicker({
                        selectedQuests: new Set(selected.map(cb => cb.value)),
                        autoEnroll: document.getElementById('set-enroll')?.checked ?? RUNTIME.autoEnroll,
                        autoClaim: document.getElementById('set-claim')?.checked ?? RUNTIME.autoClaim,
                        playSound: document.getElementById('set-sound')?.checked ?? RUNTIME.playSound,
                        randomDelay: document.getElementById('set-delay')?.checked ?? RUNTIME.randomDelay,
                        parallelGames: document.getElementById('set-parallel')?.checked ?? RUNTIME.parallelGames
                    });
                });

                body.classList.add('picker-mode');
                syncUI();

                readOrbBalance()
                    .then(balance => {
                        if (balance === null) {
                            Logger.log('[System] Discord sent no Orb balance, so the picker shows none.', 'warn');
                            return;
                        }
                        balanceText = `Balance: ${balance} Orbs`;
                        syncUI();
                    })
                    .catch(e => Logger.log(`[System] Could not read the Orb balance: ${e?.message ?? e}`, 'warn'));
            });
        }
    };

    /* ── request queue ──────────────────────────────────────────── */
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
                            this.queue.unshift(req);
                            await sleep(delay + retryJitter);
                        } else {
                            setTimeout(() => {
                                if (RUNTIME.running) {
                                    this.queue.push(req);
                                    this.process();
                                } else {
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

                await sleep(rnd(1200, 1800));
            }
            this.processing = false;
        }
    };

    /* ── store patching ─────────────────────────────────────────── */
    let Mods = {};

    const Patcher = {
        games: [], real: {}, active: false,
        savedShowCurrentGame: null,
        _unhide: null,

        PATCHED: ['getRunningGames', 'getGameForPID', 'getVisibleGame', 'getVisibleRunningGames',
                  'getRunningDiscordApplicationIds', 'getCandidateGames'],

        init(Store) {
            if (!Store) return;
            this.real = {};
            for (const name of this.PATCHED) {
                if (typeof Store[name] === 'function') this.real[name] = Store[name];
            }
            const absent = this.PATCHED.filter(n => !this.real[n]);
            if (absent.length) Logger.log(`[Patcher] Store lacks ${absent.join(', ')}, not patching those.`, 'debug');
        },

        toggle(on) {
            const S = Mods.RunStore;
            const real = this.real;

            if (on && !this.active) {
                S.getRunningGames = () => [...real.getRunningGames.call(S), ...this.games];
                S.getGameForPID = (pid) => this.games.find(g => g.pid === pid) || real.getGameForPID.call(S, pid);

                if (real.getVisibleGame) S.getVisibleGame = () => this.games[0] ?? real.getVisibleGame.call(S);
                if (real.getVisibleRunningGames) S.getVisibleRunningGames = () => [...real.getVisibleRunningGames.call(S), ...this.games];
                if (real.getCandidateGames) S.getCandidateGames = () => [...real.getCandidateGames.call(S), ...this.games];
                if (real.getRunningDiscordApplicationIds) {
                    S.getRunningDiscordApplicationIds = () => {
                        const ids = real.getRunningDiscordApplicationIds.call(S);
                        const ours = this.games.map(g => String(g.id));
                        return ids instanceof Set ? new Set([...ids, ...ours]) : [...(ids ?? []), ...ours];
                    };
                }
                this.active = true;
            } else if (!on && this.active) {
                for (const [name, fn] of Object.entries(real)) S[name] = fn;
                this.active = false;
            }
        },

        syncPresenceSuppression() {
            const setting = Mods.ShowCurrentGame;
            const shouldSuppress = CONFIG.HIDE_ACTIVITY && this.games.length > 0;

            if (!setting) {
                if (shouldSuppress) Logger.log('[Patcher] status.showCurrentGame not found, cannot hide activity.', 'warn');
                return;
            }

            if (shouldSuppress && this.savedShowCurrentGame === null) {
                try {
                    this.savedShowCurrentGame = setting.getSetting() !== false;
                    if (this.savedShowCurrentGame) {
                        Promise.resolve(setting.updateSetting(false)).catch(e =>
                            Logger.log(`[Patcher] Could not turn showCurrentGame off, activity stays visible: ${e.message}`, 'warn'));
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
            this.syncPresenceSuppression();
            this.rpc(null);
        }
    };

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

    /* ── task handlers ──────────────────────────────────────────── */
    const Tasks = {
        skipped: new Set(),
        outcomes: new Map(),
        _streamReal: undefined,
        _streamSpoofs: 0,

        readProgress(userStatus, key) {
            const p = userStatus?.progress;
            const entry = p instanceof Map ? p.get(key) : p?.[key];
            return entry?.value ?? userStatus?.streamProgressSeconds ?? 0;
        },

        sanitize(name) { return name.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/\s+/g, " "); },

        appIdFor(cfg, keyName, legacyAppId) {
            return taskAt(cfg?.tasks, keyName)?.applications?.[0]?.id ?? legacyAppId ?? null;
        },

        detectType(cfg, applicationId) {
            const keys = taskKeys(cfg.tasks);
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

        pickExecutable(executables, cleanName) {
            const loose = v => v.replace(/[^a-z0-9]/gi, "").toLowerCase();
            const fallbackExe = `${cleanName.replace(/\s+/g, "")}.exe`;

            const win32 = (Array.isArray(executables) ? executables : [])
                .filter(x => x?.os === "win32" && typeof x.name === "string" && x.name.length > 0)
                .map(x => x.name.replace(">", "").replace(/\\/g, "/"));
            if (win32.length === 0) return { exeName: fallbackExe, relPath: `${cleanName}/${fallbackExe}` };

            const rank = n => [
                /(^|[-_./ ])test([-_. ]|\.exe$)/i.test(n) ? "1" : "0",
                /launcher/i.test(n) ? "1" : "0",
                n.includes("/") ? "1" : "0",
                n
            ].join("");
            const chosen = win32.slice().sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0))[0];
            const parts = chosen.split("/").filter(Boolean);
            const exeName = parts[parts.length - 1];
            const dirs = parts.slice(0, -1);

            const alreadyRooted = dirs.length > 0 && loose(dirs[0]) === loose(cleanName);
            return { exeName, relPath: (alreadyRooted ? parts : [cleanName, ...parts]).join("/") };
        },

        async fetchGameData(appId, appName) {
            try {
                const res = await Mods.API.get({ url: `/applications/public?application_ids=${appId}` });
                const appData = res?.body?.[0];
                const cleanName = this.sanitize(appData?.name || appName);
                const { exeName, relPath } = this.pickExecutable(appData?.executables, cleanName);

                return {
                    name: appData?.name || appName,
                    icon: appData?.icon,
                    exeName,
                    cmdLine: `C:\\Program Files\\${relPath.replace(/\//g, "\\")}`,
                    exePath: `c:/program files/${relPath.toLowerCase()}`,
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
                body: { platform: 0, location: 11, is_targeted: false, metadata_sealed: null, traffic_metadata_sealed: sealedFor(questId) }
            });
        },

        failTask(q, t, reason) {
            const currentProgress = Logger.tasks.get(q.id)?.cur ?? 0;
            Logger.updateTask(q.id, { name: t.name, type: t.type, cur: currentProgress, max: t.target, status: "FAILED" });
            Logger.log(`[Task] Aborted "${t.name}": ${reason}`, 'err');
            Tasks.skipped.add(q.id);
            recordOutcome(Tasks.outcomes, q.id, 'failed');
            setTimeout(() => Logger.removeTask(q.id), 2000);
        },

        async VIDEO(q, t, s) {
            let cur = s?.progress?.[t.keyName]?.value ?? s?.progress?.[t.type]?.value ?? 0;
            let failCount = 0;

            Logger.updateTask(q.id, { name: t.name, type: "VIDEO", cur, max: t.target, status: "RUNNING" });

            const startTime = Date.now();
            let calls = 0;

            while (cur < t.target && RUNTIME.running) {
                const delayMs = rnd(7000, 9500);
                await sleep(delayMs);

                const elapsedSec = (delayMs / 1000) + (Math.random() * 0.02 - 0.01);
                cur += elapsedSec;

                const payloadTs = Number(Math.min(t.target, cur).toFixed(6));

                try {
                    const r = await Traffic.enqueue(`/quests/${q.id}/video-progress`, { timestamp: payloadTs });
                    calls++;
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

        async generic(q, t, type, fallbackKey, s) {
            if (!RUNTIME.running) return;
            const key = t.keyName || fallbackKey;
            const gameData = await this.fetchGameData(t.appId, t.name);

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
                let spoofReleased = false;
                let safetyTimer;
                let watchdogTimer;
                let beats = 0;
                let failedBeats = 0;
                let consecutiveFailures = 0;
                let lastFailure = null;

                if (type === "STREAM") {
                    if (Mods.StreamStore) {
                        if (Tasks._streamSpoofs === 0) Tasks._streamReal = Mods.StreamStore.getStreamerActiveStreamMetadata;
                        Tasks._streamSpoofs++;
                        Mods.StreamStore.getStreamerActiveStreamMetadata = () => ({ id: gameData.id, pid, sourceName: gameData.name });
                    }
                    cleanupHook = () => {
                        if (Mods.StreamStore && Tasks._streamSpoofs > 0 && --Tasks._streamSpoofs === 0) {
                            Mods.StreamStore.getStreamerActiveStreamMetadata = Tasks._streamReal;
                        }
                    };
                } else {
                    Patcher.add(game);
                    cleanupHook = () => Patcher.remove(game);
                }

                const seeded = Tasks.readProgress(s, key);
                Logger.updateTask(q.id, { name: t.name, type, cur: seeded, max: t.target, status: "RUNNING" });
                Logger.log(`[Task] Started ${type}: ${gameData.name}`, 'info');

                const stopWatching = () => {
                    if (cleaned) return;
                    cleaned = true;
                    clearTimeout(safetyTimer);
                    clearTimeout(watchdogTimer);
                    try { Mods.Dispatcher?.unsubscribe(CONST.EVT.HEARTBEAT, check); } catch (e) {
                        Logger.log(`[Dispatcher] Unsubscribe failed: ${e.message}`, 'debug');
                    }
                    try { Mods.Dispatcher?.unsubscribe(CONST.EVT.HEARTBEAT_FAIL, onFail); } catch (e) {
                        Logger.log(`[Dispatcher] Unsubscribe failed: ${e.message}`, 'debug');
                    }
                };

                const releaseSpoof = () => {
                    if (spoofReleased) return;
                    spoofReleased = true;
                    try { cleanupHook(); } catch (e) { Logger.log(`[Task] Cleanup: ${e.message}`, 'debug'); }
                    RUNTIME.cleanups.delete(abort);
                };

                const finish = () => { stopWatching(); releaseSpoof(); };

                const linger = async () => {
                    const maxMinutes = Number(CONFIG.PLAY_SESSION_TAIL_MIN ?? 0);
                    if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) return;
                    const maxMs = Math.round(maxMinutes * 60 * 1000);
                    const tailMs = rnd(Math.round(maxMs * 0.4), maxMs);
                    Logger.log(`[Task] Holding ${type} "${gameData.name}" for ${Math.round(tailMs / 1000)}s after completion.`, 'debug');
                    const step = 500;
                    for (let waited = 0; waited < tailMs && RUNTIME.running && !spoofReleased; waited += step) {
                        await sleep(Math.min(step, tailMs - waited));
                    }
                };

                const abort = () => { finish(); resolve(); };

                safetyTimer = setTimeout(() => {
                    if (RUNTIME.running) Tasks.failTask(q, t, 'Timeout exceeded (25m)');
                    finish();
                    resolve();
                }, SYS.MAX_TIME);

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
                    Logger.updateTask(q.id, {
                        name: t.name, type, cur: prog, max: t.target, status: "RUNNING",
                        serverCur: prog, serverAt: Date.now()
                    });

                    if (prog >= t.target) {
                        stopWatching();
                        Promise.resolve(Tasks.finish(q, t))
                            .then(linger)
                            .finally(() => { releaseSpoof(); resolve(); });
                    }
                };

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

        _relayUrl: 'http://127.0.0.1:43210',
        _relayProbe: null,
        _relayProbeAt: 0,
        RELAY_PROBE_TTL: 60000,

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
            const relayAvailable = await this._probeRelay();
            if (!RUNTIME.running) throw new Error('Shutdown');
            if (relayAvailable) {
                let r;
                try {
                    r = await fetch(`${this._relayUrl}/proxy`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'X-Orion-Relay': '1' },
                        body: JSON.stringify({ url, headers, body: jsonBody }),
                        redirect: 'error'
                    });
                    if (!RUNTIME.running) throw new Error('Shutdown');
                } catch (e) {
                    if (!RUNTIME.running) throw e;
                    this._relayProbe = null;
                    Logger.log(`[Bypass] Relay stopped responding, trying other transports: ${e?.message ?? e}`, 'debug');
                }
                if (r) {
                    if (!r.ok) {
                        const body = await r.text();
                        if (!RUNTIME.running) throw new Error('Shutdown');
                        if (r.status === 403 && body.includes('X-Orion-Relay')) {
                            this._relayProbe = null;
                            Logger.log('[Bypass] The running Orion Relay is out of date. Update it from tools/orion-relay/ (it now requires the X-Orion-Relay header so a web page cannot drive it). Trying other transports.', 'warn');
                            r = null;
                        } else {
                            throw { status: r.status, body };
                        }
                    }
                }
                if (r) {
                    const result = await r.json();
                    if (!RUNTIME.running) throw new Error('Shutdown');
                    if (!result.ok) throw { status: result.status, body: result.body };
                    return result;
                }
            }

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

            const dn = window.DiscordNative;
            if (dn) {
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

            if (!RUNTIME.running) throw new Error('Shutdown');
            const res = await fetch(url, { method: 'POST', headers, body: jsonBody, redirect: 'error' });
            if (!RUNTIME.running) throw new Error('Shutdown');
            const body = await res.text();
            if (!RUNTIME.running) throw new Error('Shutdown');
            if (!res.ok) throw { status: res.status, body };
            return { ok: true, status: res.status, body };
        },

        async bypassAchievement(q, t) {
            const appId = t.appId || q.config?.application?.id;
            let reason = null;
            if (!appId) {
                reason = 'this quest carries no application id, so there is nothing to authorize against';
                return { ok: false, reason };
            }
            if (!/^\d+$/.test(String(appId))) {
                reason = `the quest's application id ("${appId}") is not numeric, so it was refused before any request went out`;
                Logger.log(`[Bypass] Refusing non-numeric appId "${appId}".`, 'warn');
                return { ok: false, reason };
            }

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
                if (e instanceof TypeError && /failed to fetch|networkerror/i.test(e.message)) {
                    Logger.log(`[Bypass] Discord's CSP blocks the script from reaching discordsays.com. Use the Vencord plugin port for the auto-bypass, since a userscript cannot bypass CSP. Skipping "${t.name}".`, 'warn');
                    return { ok: false, reason };
                }
                const code = e?.body?.code;
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

        async ACHIEVEMENT(q, t) {
            Logger.updateTask(q.id, { name: t.name, type: "ACHIEVEMENT", cur: 0, max: t.target, status: "RUNNING" });

            const key = buildStreamKey();

            if (key) {
                Logger.log(`[Task] Attempting heartbeat spoofing for "${t.name}"...`, 'info');
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

            if (!RUNTIME.running) return;
            const bypass = await Tasks.bypassAchievement(q, t);
            if (!RUNTIME.running) return;
            if (bypass.ok) return Tasks.finish(q, t);

            Logger.log(`[Task] Skipping "${t.name}". No auto-completion path worked (heartbeat rejected, bypass blocked). Likely age-gated/delisted on your account.`, 'warn');
            return Tasks.failTask(q, t, bypass.reason ?? 'no auto-completion path worked');
        },

        async ACTIVITY(q, t) {
            const key = buildStreamKey();
            if (!key) {
                return Tasks.failTask(q, t, 'No voice channel found');
            }

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
            recordOutcome(Tasks.outcomes, q.id, 'completed');
            Logger.log(`[Task] Completed "${t.name}"!`, 'success');
            Sound.play('tick');

            try {
                if (typeof Notification !== 'undefined') {
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
                    const claimRes = await this.claimReward(q.id);

                    if (claimRes?.body?.claimed_at) {
                        Logger.log(`[Claim] Reward for "${t.name}" claimed automatically!`, 'success');
                        Logger.updateTask(q.id, { name: t.name, type: t.type, cur: t.target, max: t.target, status: "CLAIMED" });
                        setTimeout(() => Logger.removeTask(q.id), 2000);
                        return;
                    }
                } catch (e) {
                    const needsCaptcha = e?.body?.captcha_key || e?.body?.captcha_sitekey;
                    if (needsCaptcha) {
                        Logger.log(`[Claim] Captcha required for "${t.name}". Use UI button.`, 'warn');
                    } else {
                        Logger.log(`[Claim] Auto-claim failed for "${t.name}": ${e?.body?.message ?? e?.message}`, 'err');
                    }
                }
            }

            Logger.updateTask(q.id, { name: t.name, type: t.type, cur: t.target, max: t.target, status: "COMPLETED", claimable: true, questId: q.id });
        }
    };

    /* ── webpack module extraction ─────────────────────────────── */
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

                    if (!BoolValue && typeof p.create === 'function'
                        && String(p.typeName ?? '').includes('Bool')) BoolValue = p;

                    if (!actions && typeof p.updateAsync === 'function'
                        && (p.ProtoClass?.typeName?.endsWith('.PreloadedUserSettings') || p.type === 1)) {
                        actions = p;
                        delay = exp.UserSettingsDelay?.INFREQUENT_USER_ACTION ?? 0;
                    }
                }
                if (actions && BoolValue) break;
            } catch { }
        }
        if (!actions) return undefined;
        if (!BoolValue) Logger.log('[Patcher] BoolValue proto type not found. Hiding activity will only work if the setting already exists.', 'debug');

        return {
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
                    Premium: W.findByProps('canUseMoreQuestOrbs', 'canUseShopDiscounts'),
                    Dispatcher: W.Common?.FluxDispatcher || W.findByProps('dispatch', 'subscribe', 'flushWaitQueue'),
                    API: W.Common?.RestAPI || W.findByProps('get', 'post', 'del'),
                    Router: routerModule,
                    ShowCurrentGame: findShowCurrentGameSetting(W.cache || W.wreq?.c)
                };

                const required = ['QuestStore', 'API', 'Dispatcher', 'RunStore'];
                const missing = required.filter(k => !Mods[k]);

                if (missing.length === 0) {
                    const optional = ['StreamStore', 'ChanStore', 'GuildChanStore', 'Router'];
                    optional.forEach(k => { if (!Mods[k]) Logger.log(`[System] Optional module '${k}' not found. Features may be limited.`, 'warn'); });

                    Patcher.init(Mods.RunStore);
                    return true;
                }
                Logger.log(`[System] Vencord extraction missed: ${missing.join(', ')}. Falling back to native...`, 'warn');
            }

            if (typeof webpackChunkdiscord_app === 'undefined') {
                throw new Error("Webpack chunk not found - is this running inside Discord?");
            }

            let req;
            webpackChunkdiscord_app.push([[Symbol()], {}, (r) => {
                const cur = Object.keys(req?.c || {}).length;
                const incoming = Object.keys(r?.c || {}).length;
                if (incoming > cur) req = r;
            }]);
            webpackChunkdiscord_app.pop();

            if (!req?.c) throw new Error("Module registry not available - Discord build incompatible (see issue #20)");

            const modules = Object.values(req.c);

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

            function findPremiumFeatures() {
                for (const m of modules) {
                    try {
                        const exp = m?.exports;
                        if (!exp || typeof exp !== 'object') continue;
                        for (const prop of [exp, ...Object.values(exp)]) {
                            if (prop && typeof prop.canUseMoreQuestOrbs === 'function'
                                && typeof prop.canUseShopDiscounts === 'function') {
                                return prop;
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
                Premium: findPremiumFeatures(),
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
    async function runConcurrent(tasks, limit) {
        const executing = new Set();

        for (const task of tasks) {
            if (!RUNTIME.running) break;

            const p = task().finally(() => executing.delete(p));
            executing.add(p);

            await sleep(rnd(1500, 4000));

            if (executing.size >= limit) {
                await Promise.race(executing);
            }
        }

        return Promise.allSettled(executing);
    }

    async function main() {
        Logger.init();
        if (!loadModules()) return Logger.log('[System] Failed to load Discord modules. Aborting.', 'err');

        const getQuests = () => {
            const q = Mods.QuestStore.quests;
            return q instanceof Map ? [...q.values()] : Object.values(q);
        };

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
            if (!allQuests.length) {
                Logger.log('[System] Discord has not given this client a quest list. Reload Discord (Ctrl+R) and paste again.', 'err');
            } else {
                Logger.log('[System] All available quests are completed!', 'success');
            }
            return Logger.shutdown();
        }

        const pickerResult = await Logger.showQuestPicker(quests);
        if (!RUNTIME.running) return;

        RUNTIME.autoEnroll = pickerResult.autoEnroll;
        RUNTIME.autoClaim = pickerResult.autoClaim;
        RUNTIME.playSound = pickerResult.playSound;
        RUNTIME.randomDelay = pickerResult.randomDelay;
        RUNTIME.parallelGames = pickerResult.parallelGames;

        if (pickerResult.selectedQuests.size === 0) {
            Logger.log('[System] No quests selected. Shutting down.', 'info');
            return Logger.shutdown();
        }

        let loopCount = 1;

        while (RUNTIME.running) {
            try {
                Logger.log(`[Cycle] Starting loop #${loopCount}...`, 'info');

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

                const active = quests.filter(q =>
                    pickerResult.selectedQuests.has(q.id)
                    && !q.userStatus?.completedAt
                    && notExpired(q)
                    && q.id !== CONST.ID
                    && !Tasks.skipped.has(q.id)
                );

                if (!active.length) {
                    const summary = summarizeRun(Tasks.outcomes);
                    Logger.log(`[System] ${summary.line}`, summary.blocked || summary.failed ? 'warn' : 'success');
                    if (summary.playDone) Sound.play('done');
                    break;
                }

                const queues = { video: [], game: [] };
                const scheduledInfo = [];

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
                            keyName
                        };

                        if (!q.userStatus?.enrolledAt && !RUNTIME.autoEnroll) {
                            Logger.updateTask(tInfo.id, {
                                name: tInfo.name, type: tInfo.type, cur: 0, max: tInfo.target,
                                status: "PENDING", actionRequired: 'ENROLL'
                            });
                            return;
                        }

                        if (Logger.tasks.has(q.id) && Logger.tasks.get(q.id).status === "RUNNING") return;

                        Logger.updateTask(tInfo.id, {
                            name: tInfo.name, type: tInfo.type, cur: 0, max: tInfo.target,
                            status: "QUEUE", actionRequired: null
                        });

                        const taskFunc = async () => {
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
                        scheduledInfo.push({ appId: tInfo.appId, name: tInfo.name, type });
                    } catch (e) {
                        Logger.log(`[Quest] Error processing ${q.id}: ${e.message}`, 'err');
                    }
                });

                const totalTasks = queues.video.length + queues.game.length;

                if (totalTasks > 0) {
                    Logger.log(`[Cycle] Processing: ${queues.video.length} videos, ${queues.game.length} games.`, 'info');
                    const sharedGames = new Map();
                    for (const s of scheduledInfo) {
                        if (s.type !== "GAME") continue;
                        const key = String(s.appId ?? "");
                        if (!key || key === "0") continue;
                        const g = sharedGames.get(key);
                        if (g) g.count++; else sharedGames.set(key, { name: s.name, count: 1 });
                    }
                    for (const { name, count } of sharedGames.values()) {
                        if (count < 2) continue;
                        Logger.log(`[Cycle] ${count} "${name}" quests are the same game, so Discord credits all ${count} while it runs once and they finish together. The limit still drives one at a time.`, 'info');
                    }
                    const gameLimit = (RUNTIME.parallelGames ?? true) ? (CONFIG.GAME_CONCURRENCY || 15) : 1;
                    const pGames = runConcurrent(queues.game, gameLimit);
                    const pVideos = runConcurrent(queues.video, 2);
                    await Promise.all([pGames, pVideos]);
                } else {
                    if (active.length === 0) { Logger.log('[System] All available quests are completed!', 'success'); break; }
                    else await sleep(rnd(4000, 6000));
                }

                if (!RUNTIME.running) break;

                if (RUNTIME.randomDelay) {
                    const delayMs = rnd(60000, 1800000);
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

        const hasUnclaimed = [...Logger.tasks.values()].some(t => t.claimable && !t.removing);
        if (hasUnclaimed) {
            Logger.log('[System] Quest cycle finished. Claim your rewards above, then click Stop.', 'info');
            return;
        }

        Logger.shutdown();
    }

    main().catch(e => {
        const msg = e?.message ?? e?.toString?.() ?? "Unknown fatal error";
        console.error('[Orion Fatal]', e);
        try { Logger.log(`[System] FATAL: ${msg}`, 'err'); } catch (_) { }
        Logger.shutdown();
        setTimeout(() => { window.orionLock = false; }, 1500);
    });
})();
